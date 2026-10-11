use bytes::Bytes;
use orca_protocol::terminal_stream::{
    encode_terminal_stream_frame, TerminalStreamFrame, TerminalStreamOpcode,
};
use orca_pty::{spawn as spawn_pty, PtyError, PtySession, PtySessionConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
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
    pub session: Arc<Mutex<PtySession>>,
    pub output_tx: broadcast::Sender<TerminalStreamFrame>,
    pub raw_output_tx: broadcast::Sender<Bytes>,
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

        let mut config = PtySessionConfig::new(command, args, cols, rows);
        config.cwd = cwd;
        if let Some(env_map) = env {
            config.env = env_map;
        }

        let session = spawn_pty(config).await?;
        let pid = session.pid();
        let session = Arc::new(Mutex::new(session));

        let id_num = self.counter.fetch_add(1, Ordering::SeqCst);
        let terminal_id = format!("term-{}", id_num);
        let stream_id = self.stream_counter.fetch_add(1, Ordering::SeqCst);

        let (output_tx, _) = broadcast::channel(256);
        let (raw_output_tx, _) = broadcast::channel(256);

        let active = Arc::new(ActiveTerminal {
            id: terminal_id.clone(),
            stream_id,
            pid,
            session: Arc::clone(&session),
            output_tx: output_tx.clone(),
            raw_output_tx: raw_output_tx.clone(),
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

        tokio::spawn(async move {
            let mut seq = 0u64;
            loop {
                let chunk = {
                    let mut guard = session_clone.lock().await;
                    guard.next_output().await
                };

                match chunk {
                    Some(payload) => {
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

            // Cleanup when PTY stream ends
            mgr.remove_terminal_silent(&term_id_clone).await;
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
                let mut guard = t.session.lock().await;
                guard.write_input(data).await?;
                Ok(())
            }
            None => Err(TerminalError::NotFound(terminal_id.to_string())),
        }
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
                let guard = t.session.lock().await;
                guard.resize(cols, rows)?;
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
                {
                    let mut guard = t.session.lock().await;
                    let _ = guard.terminate().await;
                }
                self.idle_exit.terminal_closed().await;
                Ok(())
            }
            None => Err(TerminalError::NotFound(terminal_id.to_string())),
        }
    }

    async fn remove_terminal_silent(&self, terminal_id: &str) {
        let removed = {
            let mut lock = self.terminals.write().await;
            lock.remove(terminal_id)
        };

        if removed.is_some() {
            self.idle_exit.terminal_closed().await;
        }
    }

    pub async fn kill_all(&self) {
        let all_terminals: Vec<Arc<ActiveTerminal>> = {
            let mut lock = self.terminals.write().await;
            let list = lock.values().cloned().collect();
            lock.clear();
            list
        };

        for t in all_terminals {
            let mut guard = t.session.lock().await;
            let _ = guard.terminate().await;
            self.idle_exit.terminal_closed().await;
        }
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

    pub async fn active_count(&self) -> usize {
        let lock = self.terminals.read().await;
        lock.len()
    }
}
