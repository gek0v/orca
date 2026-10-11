use bytes::Bytes;
use orca_protocol::models::TerminalReadResult;
use orca_protocol::terminal_stream::{
    encode_terminal_stream_frame, TerminalStreamFrame, TerminalStreamOpcode,
};
use orca_pty::{spawn as spawn_pty, PtyError, PtySession, PtySessionConfig};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::idle_exit::IdleExitManager;

#[derive(Error, Debug)]
pub enum TerminalError {
    #[error("Terminal not found: {0}")]
    NotFound(String),
    #[error("PTY error: {0}")]
    Pty(#[from] PtyError),
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct TerminalEventNotification {
    #[serde(rename = "type")]
    pub event_type: String,
    pub event: String,
    pub id: String,
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
}

pub struct ActiveTerminal {
    pub id: String,
    pub stream_id: u32,
    pub pid: u32,
    pub cwd: Option<PathBuf>,
    pub command: String,
    pub session: Arc<PtySession>,
    pub output_tx: broadcast::Sender<TerminalStreamFrame>,
    pub raw_output_tx: broadcast::Sender<Bytes>,
    pub scrollback: Arc<Mutex<Vec<u8>>>,
    pub last_output_ms: Arc<AtomicU64>,
    pub exited: Arc<AtomicBool>,
}

pub struct TerminalManager {
    terminals: Arc<RwLock<HashMap<String, Arc<ActiveTerminal>>>>,
    counter: AtomicU64,
    stream_counter: AtomicU32,
    idle_exit: Arc<IdleExitManager>,
    event_tx: broadcast::Sender<TerminalEventNotification>,
}

impl TerminalManager {
    pub fn new(idle_exit: Arc<IdleExitManager>) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(1024);
        Arc::new(Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            counter: AtomicU64::new(1),
            stream_counter: AtomicU32::new(1),
            idle_exit,
            event_tx,
        })
    }

    pub fn subscribe_all_events(&self) -> broadcast::Receiver<TerminalEventNotification> {
        self.event_tx.subscribe()
    }

    pub async fn create_terminal(
        self: &Arc<Self>,
        command: Option<String>,
        args: Option<Vec<String>>,
        cols: Option<u16>,
        rows: Option<u16>,
        cwd: Option<PathBuf>,
        env: Option<HashMap<String, String>>,
    ) -> Result<(String, u32), TerminalError> {
        let cols = cols.unwrap_or(80);
        let rows = rows.unwrap_or(24);
        let default_cmd = if cfg!(windows) {
            "cmd.exe".to_string()
        } else {
            "sh".to_string()
        };
        let command = command.unwrap_or(default_cmd);
        let args = args.unwrap_or_default();

        let mut config = PtySessionConfig::new(command.clone(), args, cols, rows);
        config.cwd = cwd.clone();
        if let Some(env_map) = env {
            config.env = env_map;
        }

        let session = spawn_pty(config).await?;
        let pid = session.pid();
        let session = Arc::new(session);

        let id_num = self.counter.fetch_add(1, Ordering::SeqCst);
        let terminal_id = format!("term-{}", id_num);
        let stream_id = self.stream_counter.fetch_add(1, Ordering::SeqCst);

        let (output_tx, _) = broadcast::channel(256);
        let (raw_output_tx, _) = broadcast::channel(256);
        let scrollback = Arc::new(Mutex::new(Vec::with_capacity(16384)));
        let last_output_ms = Arc::new(AtomicU64::new(0));
        let exited = Arc::new(AtomicBool::new(false));

        let active = Arc::new(ActiveTerminal {
            id: terminal_id.clone(),
            stream_id,
            pid,
            cwd,
            command,
            session: Arc::clone(&session),
            output_tx: output_tx.clone(),
            raw_output_tx: raw_output_tx.clone(),
            scrollback: Arc::clone(&scrollback),
            last_output_ms: Arc::clone(&last_output_ms),
            exited: Arc::clone(&exited),
        });

        {
            let mut lock = self.terminals.write().await;
            lock.insert(terminal_id.clone(), Arc::clone(&active));
        }

        self.idle_exit.terminal_created().await;

        // Background reader for PTY output
        let mgr = Arc::clone(self);
        let term_id_clone = terminal_id.clone();
        let session_clone = Arc::clone(&session);
        let scrollback_clone = Arc::clone(&scrollback);
        let last_output_ms_clone = Arc::clone(&last_output_ms);
        let exited_clone = Arc::clone(&exited);

        tokio::spawn(async move {
            let mut seq = 0u64;
            loop {
                let chunk = session_clone.next_output().await;

                match chunk {
                    Some(payload) => {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        last_output_ms_clone.store(now_ms, Ordering::SeqCst);

                        {
                            let mut sb = scrollback_clone.lock().await;
                            sb.extend_from_slice(&payload);
                            if sb.len() > 1024 * 1024 {
                                let excess = sb.len() - 1024 * 1024;
                                sb.drain(..excess);
                            }
                        }

                        let frame = TerminalStreamFrame {
                            opcode: TerminalStreamOpcode::Output,
                            stream_id,
                            seq,
                            payload: payload.clone(),
                        };
                        seq += 1;

                        let _ = output_tx.send(frame.clone());
                        let encoded = encode_terminal_stream_frame(&frame);
                        let _ = raw_output_tx.send(encoded);

                        let text = String::from_utf8_lossy(&payload).into_owned();
                        let _ = mgr.event_tx.send(TerminalEventNotification {
                            event_type: "event".to_string(),
                            event: "data".to_string(),
                            id: term_id_clone.clone(),
                            terminal_id: term_id_clone.clone(),
                            data: Some(text),
                            code: None,
                        });
                    }
                    None => {
                        // Shell exited
                        exited_clone.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }

            let _ = mgr.event_tx.send(TerminalEventNotification {
                event_type: "event".to_string(),
                event: "exit".to_string(),
                id: term_id_clone.clone(),
                terminal_id: term_id_clone.clone(),
                data: None,
                code: Some(0),
            });

            // Signal terminal closed to idle-exit while keeping metadata inspectable
            mgr.idle_exit.terminal_closed().await;
        });

        Ok((terminal_id, pid))
    }

    pub async fn write_input(&self, terminal_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let terminal = {
            let lock = self.terminals.read().await;
            lock.get(terminal_id).cloned()
        };

        match terminal {
            Some(t) => {
                t.session.write_input(data).await?;
                Ok(())
            }
            None => Err(TerminalError::NotFound(terminal_id.to_string())),
        }
    }

    pub async fn read_output(
        &self,
        terminal_id: &str,
        cursor: Option<usize>,
        limit: Option<usize>,
        screen: bool,
    ) -> Result<TerminalReadResult, TerminalError> {
        let terminal = {
            let lock = self.terminals.read().await;
            lock.get(terminal_id).cloned()
        };

        match terminal {
            Some(t) => {
                let sb = t.scrollback.lock().await;
                let start = cursor.unwrap_or(0).min(sb.len());
                let max_limit = limit.unwrap_or(sb.len().saturating_sub(start));
                let end = (start + max_limit).min(sb.len());
                let slice = &sb[start..end];
                let raw_text = String::from_utf8_lossy(slice).into_owned();
                let text = if screen {
                    strip_ansi_escapes(&raw_text)
                } else {
                    raw_text
                };
                Ok(TerminalReadResult {
                    ok: true,
                    terminal_id: terminal_id.to_string(),
                    text,
                    cursor: end,
                    source: if screen {
                        "screen".to_string()
                    } else {
                        "stream".to_string()
                    },
                })
            }
            None => Err(TerminalError::NotFound(terminal_id.to_string())),
        }
    }

    pub async fn wait_for(
        &self,
        terminal_id: &str,
        condition: &str,
        timeout_ms: Option<u64>,
    ) -> Result<serde_json::Value, TerminalError> {
        let terminal = {
            let lock = self.terminals.read().await;
            lock.get(terminal_id).cloned()
        };

        let t = match terminal {
            Some(t) => t,
            None => return Err(TerminalError::NotFound(terminal_id.to_string())),
        };

        let timeout_duration = Duration::from_millis(timeout_ms.unwrap_or(30_000));
        let start = tokio::time::Instant::now();

        loop {
            if start.elapsed() >= timeout_duration {
                return Ok(json!({
                    "ok": false,
                    "terminalId": terminal_id,
                    "conditionMet": false,
                    "error": "timeout",
                    "condition": condition,
                }));
            }

            match condition {
                "exit" => {
                    if t.exited.load(Ordering::SeqCst) {
                        return Ok(json!({
                            "ok": true,
                            "terminalId": terminal_id,
                            "conditionMet": true,
                            "status": "exit",
                        }));
                    }
                }
                "tui-idle" => {
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let last = t.last_output_ms.load(Ordering::SeqCst);
                    if t.exited.load(Ordering::SeqCst)
                        || (last > 0 && now_ms.saturating_sub(last) >= 300)
                    {
                        return Ok(json!({
                            "ok": true,
                            "terminalId": terminal_id,
                            "conditionMet": true,
                            "status": if t.exited.load(Ordering::SeqCst) { "exit" } else { "tui-idle" },
                        }));
                    }
                }
                _ => {
                    return Ok(json!({
                        "ok": false,
                        "terminalId": terminal_id,
                        "conditionMet": false,
                        "error": format!("unsupported condition: {}", condition),
                    }));
                }
            }

            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    pub async fn split_terminal(
        self: &Arc<Self>,
        parent_id: &str,
        _direction: Option<String>,
        command: Option<String>,
    ) -> Result<(String, u32), TerminalError> {
        let parent_cwd = {
            let lock = self.terminals.read().await;
            lock.get(parent_id).and_then(|t| t.cwd.clone())
        };

        self.create_terminal(command, None, None, None, parent_cwd, None)
            .await
    }

    pub async fn resize(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        let terminal = {
            let lock = self.terminals.read().await;
            lock.get(terminal_id).cloned()
        };

        match terminal {
            Some(t) => {
                t.session.resize(cols, rows)?;
                Ok(())
            }
            None => Err(TerminalError::NotFound(terminal_id.to_string())),
        }
    }

    pub async fn kill_terminal(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let terminal = {
            let mut lock = self.terminals.write().await;
            lock.remove(terminal_id)
        };

        match terminal {
            Some(t) => {
                let _ = t.session.terminate().await;
                t.exited.store(true, Ordering::SeqCst);
                self.idle_exit.terminal_closed().await;
                Ok(())
            }
            None => Err(TerminalError::NotFound(terminal_id.to_string())),
        }
    }

    pub async fn kill_all(&self) -> usize {
        let all_terminals: Vec<Arc<ActiveTerminal>> = {
            let mut lock = self.terminals.write().await;
            let list = lock.values().cloned().collect();
            lock.clear();
            list
        };

        let count = all_terminals.len();
        for t in all_terminals {
            let _ = t.session.terminate().await;
            t.exited.store(true, Ordering::SeqCst);
            self.idle_exit.terminal_closed().await;
        }
        count
    }

    pub async fn subscribe(
        &self,
        terminal_id: &str,
    ) -> Option<broadcast::Receiver<TerminalStreamFrame>> {
        let lock = self.terminals.read().await;
        lock.get(terminal_id).map(|t| t.output_tx.subscribe())
    }

    pub async fn subscribe_raw(&self, terminal_id: &str) -> Option<broadcast::Receiver<Bytes>> {
        let lock = self.terminals.read().await;
        lock.get(terminal_id).map(|t| t.raw_output_tx.subscribe())
    }

    pub async fn list_terminals(&self) -> Vec<String> {
        let lock = self.terminals.read().await;
        lock.keys().cloned().collect()
    }

    pub async fn list_terminals_detailed(&self) -> Vec<serde_json::Value> {
        let lock = self.terminals.read().await;
        lock.values()
            .map(|t| {
                json!({
                    "handle": t.id,
                    "terminalId": t.id,
                    "id": t.id,
                    "pid": t.pid,
                    "command": t.command,
                    "cwd": t.cwd.as_ref().map(|p| p.to_string_lossy().to_string()),
                    "exited": t.exited.load(Ordering::SeqCst),
                })
            })
            .collect()
    }

    pub async fn active_count(&self) -> usize {
        let lock = self.terminals.read().await;
        lock.iter()
            .filter(|(_, t)| !t.exited.load(Ordering::SeqCst))
            .count()
    }
}

fn strip_ansi_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_escape = false;
    for c in s.chars() {
        if c == '\x1b' {
            in_escape = true;
        } else if in_escape {
            if c.is_ascii_alphabetic() || c == '~' {
                in_escape = false;
            }
        } else {
            out.push(c);
        }
    }
    out
}
