use bytes::Bytes;
use orca_protocol::models::TerminalReadResult;
use orca_protocol::terminal_stream::{
    encode_terminal_stream_frame, TerminalStreamFrame, TerminalStreamOpcode,
};
use orca_pty::{
    spawn as spawn_pty, warm_windows_conpty_once, OscScanner, PendingOutputRecord, PtyError,
    PtySession, PtySessionConfig, TakePendingOutputResult, TerminalModes, TerminalSnapshot,
};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::idle_exit::IdleExitManager;

#[derive(Error, Debug)]
pub enum TerminalError {
    #[error("Terminal not found: {0}")]
    NotFound(String),
    #[error("Terminal {0} has been tombstoned")]
    Tombstoned(String),
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

pub struct TombstoneCache {
    capacity: usize,
    entries: HashMap<String, u64>,
    order: VecDeque<String>,
}

impl TombstoneCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub fn record(&mut self, id: &str) {
        if !self.entries.contains_key(id) {
            if self.order.len() >= self.capacity {
                if let Some(oldest) = self.order.pop_front() {
                    self.entries.remove(&oldest);
                }
            }
            self.order.push_back(id.to_string());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        self.entries.insert(id.to_string(), now);
    }

    pub fn has(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    pub fn clear_for_create(&mut self, id: &str) {
        self.entries.remove(id);
        self.order.retain(|k| k != id);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

pub struct ActiveTerminal {
    pub id: String,
    pub stream_id: u32,
    pub pid: u32,
    pub cwd: Option<PathBuf>,
    pub dynamic_cwd: Arc<RwLock<Option<PathBuf>>>,
    pub title: Arc<RwLock<Option<String>>>,
    pub command: String,
    pub session: Arc<PtySession>,
    pub output_tx: broadcast::Sender<TerminalStreamFrame>,
    pub raw_output_tx: broadcast::Sender<Bytes>,
    pub scrollback: Arc<Mutex<Vec<u8>>>,
    pub last_output_ms: Arc<AtomicU64>,
    pub exited: Arc<AtomicBool>,
    pub paused: Arc<AtomicBool>,
    pub background: Arc<AtomicBool>,
    pub cols: Arc<AtomicU16>,
    pub rows: Arc<AtomicU16>,
    pub failsafe_abort_tx: Arc<Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    pub pending_records: Arc<Mutex<Vec<PendingOutputRecord>>>,
    pub pending_bytes: Arc<AtomicUsize>,
    pub pending_seq: Arc<AtomicU64>,
    pub pending_overflowed: Arc<AtomicBool>,
    pub wsl_distro: Option<String>,
}

pub struct TerminalManager {
    terminals: Arc<RwLock<HashMap<String, Arc<ActiveTerminal>>>>,
    tombstones: Arc<RwLock<TombstoneCache>>,
    counter: AtomicU64,
    stream_counter: AtomicU32,
    idle_exit: Arc<IdleExitManager>,
    event_tx: broadcast::Sender<TerminalEventNotification>,
}

impl TerminalManager {
    pub fn new(idle_exit: Arc<IdleExitManager>) -> Arc<Self> {
        let (event_tx, _) = broadcast::channel(4096);
        warm_windows_conpty_once();
        Arc::new(Self {
            terminals: Arc::new(RwLock::new(HashMap::new())),
            tombstones: Arc::new(RwLock::new(TombstoneCache::new(1024))),
            counter: AtomicU64::new(1),
            stream_counter: AtomicU32::new(1),
            idle_exit,
            event_tx,
        })
    }

    pub fn subscribe_all_events(&self) -> broadcast::Receiver<TerminalEventNotification> {
        self.event_tx.subscribe()
    }

    pub async fn get_terminal(
        &self,
        terminal_id: &str,
    ) -> Result<Arc<ActiveTerminal>, TerminalError> {
        {
            let lock = self.terminals.read().await;
            if let Some(t) = lock.get(terminal_id) {
                return Ok(Arc::clone(t));
            }
        }
        let tombstones = self.tombstones.read().await;
        if tombstones.has(terminal_id) {
            return Err(TerminalError::Tombstoned(terminal_id.to_string()));
        }
        Err(TerminalError::NotFound(terminal_id.to_string()))
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
        self.create_terminal_with_wsl(command, args, cols, rows, cwd, env, None, None)
            .await
    }

    pub async fn create_terminal_with_id(
        self: &Arc<Self>,
        command: Option<String>,
        args: Option<Vec<String>>,
        cols: Option<u16>,
        rows: Option<u16>,
        cwd: Option<PathBuf>,
        env: Option<HashMap<String, String>>,
        requested_id: Option<String>,
    ) -> Result<(String, u32), TerminalError> {
        self.create_terminal_with_wsl(command, args, cols, rows, cwd, env, None, requested_id)
            .await
    }

    pub async fn create_terminal_with_wsl(
        self: &Arc<Self>,
        command: Option<String>,
        args: Option<Vec<String>>,
        cols: Option<u16>,
        rows: Option<u16>,
        cwd: Option<PathBuf>,
        env: Option<HashMap<String, String>>,
        wsl_distro: Option<String>,
        requested_id: Option<String>,
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
        config.wsl_distro = wsl_distro.clone();
        if let Some(env_map) = env {
            config.env = env_map;
        }

        let session = spawn_pty(config).await?;
        let pid = session.pid();
        let session = Arc::new(session);

        let terminal_id = match requested_id {
            Some(rid) if !rid.trim().is_empty() => rid,
            _ => {
                let id_num = self.counter.fetch_add(1, Ordering::SeqCst);
                format!("term-{}", id_num)
            }
        };
        let stream_id = self.stream_counter.fetch_add(1, Ordering::SeqCst);

        // Clear tombstone if recycled
        self.tombstones.write().await.clear_for_create(&terminal_id);

        let (output_tx, _) = broadcast::channel(256);
        let (raw_output_tx, _) = broadcast::channel(256);
        let scrollback = Arc::new(Mutex::new(Vec::with_capacity(16384)));
        let last_output_ms = Arc::new(AtomicU64::new(0));
        let exited = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let background = Arc::new(AtomicBool::new(false));
        let dynamic_cwd = Arc::new(RwLock::new(None));
        let title = Arc::new(RwLock::new(None));
        let pending_records = Arc::new(Mutex::new(Vec::new()));
        let pending_bytes = Arc::new(AtomicUsize::new(0));
        let pending_seq = Arc::new(AtomicU64::new(0));
        let pending_overflowed = Arc::new(AtomicBool::new(false));
        let failsafe_abort_tx = Arc::new(Mutex::new(None));

        let active = Arc::new(ActiveTerminal {
            id: terminal_id.clone(),
            stream_id,
            pid,
            cwd,
            dynamic_cwd: Arc::clone(&dynamic_cwd),
            title: Arc::clone(&title),
            command,
            session: Arc::clone(&session),
            output_tx: output_tx.clone(),
            raw_output_tx: raw_output_tx.clone(),
            scrollback: Arc::clone(&scrollback),
            last_output_ms: Arc::clone(&last_output_ms),
            exited: Arc::clone(&exited),
            paused: Arc::clone(&paused),
            background: Arc::clone(&background),
            cols: Arc::new(AtomicU16::new(cols)),
            rows: Arc::new(AtomicU16::new(rows)),
            failsafe_abort_tx,
            pending_records: Arc::clone(&pending_records),
            pending_bytes: Arc::clone(&pending_bytes),
            pending_seq: Arc::clone(&pending_seq),
            pending_overflowed: Arc::clone(&pending_overflowed),
            wsl_distro: wsl_distro.clone(),
        });

        let previous = {
            let mut lock = self.terminals.write().await;
            lock.insert(terminal_id.clone(), Arc::clone(&active))
        };
        if let Some(old) = previous {
            let _ = old.session.terminate().await;
        }

        self.idle_exit.terminal_created().await;

        // Background reader for PTY output
        let mgr = Arc::clone(self);
        let term_id_clone = terminal_id.clone();
        let session_clone = Arc::clone(&session);
        let scrollback_clone = Arc::clone(&scrollback);
        let last_output_ms_clone = Arc::clone(&last_output_ms);
        let exited_clone = Arc::clone(&exited);
        let dynamic_cwd_clone = Arc::clone(&dynamic_cwd);
        let title_clone = Arc::clone(&title);
        let pending_records_clone = Arc::clone(&pending_records);
        let pending_bytes_clone = Arc::clone(&pending_bytes);
        let pending_overflowed_clone = Arc::clone(&pending_overflowed);

        tokio::spawn(async move {
            let mut seq = 0u64;
            let mut osc_scanner = OscScanner::new(wsl_distro);

            loop {
                let chunk = session_clone.next_output().await;

                match chunk {
                    Some(payload) => {
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        last_output_ms_clone.store(now_ms, Ordering::SeqCst);

                        // 1. Reactive OSC scanning
                        osc_scanner.scan(&payload);
                        if let Some(new_cwd) = osc_scanner.get_cwd() {
                            let mut cwd_lock = dynamic_cwd_clone.write().await;
                            *cwd_lock = Some(PathBuf::from(new_cwd));
                        }
                        if let Some(new_title) = osc_scanner.get_title() {
                            let mut title_lock = title_clone.write().await;
                            *title_lock = Some(new_title.to_string());
                        }

                        // 2. Incremental checkpoint recording
                        let text = String::from_utf8_lossy(&payload).into_owned();
                        let record = PendingOutputRecord {
                            kind: "output".to_string(),
                            data: Some(text.clone()),
                            cols: None,
                            rows: None,
                        };
                        record_pending_output(
                            &pending_records_clone,
                            &pending_bytes_clone,
                            &pending_overflowed_clone,
                            record,
                        )
                        .await;

                        // 3. Scrollback maintenance (1MB bounded)
                        {
                            let mut sb = scrollback_clone.lock().await;
                            sb.extend_from_slice(&payload);
                            if sb.len() > 1024 * 1024 {
                                let excess = sb.len() - 1024 * 1024;
                                sb.drain(..excess);
                            }
                        }

                        // 4. Binary streaming frame
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

                        // 5. Broadcast notification (main Electron process owns hidden delivery gating)
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
                        mgr.tombstones.write().await.record(&term_id_clone);
                        {
                            let mut lock = mgr.terminals.write().await;
                            lock.remove(&term_id_clone);
                        }
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

            mgr.idle_exit.terminal_closed().await;
        });

        Ok((terminal_id, pid))
    }

    pub async fn write_input(&self, terminal_id: &str, data: &[u8]) -> Result<(), TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        t.session.write_input(data).await?;
        Ok(())
    }

    pub async fn read_output(
        &self,
        terminal_id: &str,
        cursor: Option<usize>,
        limit: Option<usize>,
        screen: bool,
    ) -> Result<TerminalReadResult, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
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

    pub async fn wait_for(
        &self,
        terminal_id: &str,
        condition: &str,
        timeout_ms: Option<u64>,
    ) -> Result<serde_json::Value, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
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
        let parent = self.get_terminal(parent_id).await?;
        let parent_cwd = parent.cwd.clone();
        self.create_terminal(command, None, None, None, parent_cwd, None)
            .await
    }

    pub async fn resize(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        t.cols.store(cols, Ordering::SeqCst);
        t.rows.store(rows, Ordering::SeqCst);
        let record = PendingOutputRecord {
            kind: "resize".to_string(),
            data: None,
            cols: Some(cols),
            rows: Some(rows),
        };
        record_pending_output(
            &t.pending_records,
            &t.pending_bytes,
            &t.pending_overflowed,
            record,
        )
        .await;
        t.session.resize(cols, rows)?;
        Ok(())
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
                self.tombstones.write().await.record(terminal_id);
                self.idle_exit.terminal_closed().await;
                Ok(())
            }
            None => {
                let tombstones = self.tombstones.read().await;
                if tombstones.has(terminal_id) {
                    Err(TerminalError::Tombstoned(terminal_id.to_string()))
                } else {
                    Err(TerminalError::NotFound(terminal_id.to_string()))
                }
            }
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
        let mut tombstones = self.tombstones.write().await;
        for t in all_terminals {
            let _ = t.session.terminate().await;
            t.exited.store(true, Ordering::SeqCst);
            tombstones.record(&t.id);
            self.idle_exit.terminal_closed().await;
        }
        count
    }

    pub async fn pause_pty(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        t.paused.store(true, Ordering::SeqCst);
        t.session.pause();

        let mut guard = t.failsafe_abort_tx.lock().await;
        if let Some(abort) = guard.take() {
            let _ = abort.send(());
        }

        let (tx, mut rx) = tokio::sync::oneshot::channel();
        *guard = Some(tx);

        let session_clone = Arc::clone(&t.session);
        let paused_clone = Arc::clone(&t.paused);
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(5000)) => {
                    paused_clone.store(false, Ordering::SeqCst);
                    session_clone.resume();
                }
                _ = &mut rx => {}
            }
        });

        Ok(())
    }

    pub async fn resume_pty(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        t.paused.store(false, Ordering::SeqCst);
        t.session.resume();

        let mut guard = t.failsafe_abort_tx.lock().await;
        if let Some(abort) = guard.take() {
            let _ = abort.send(());
        }

        Ok(())
    }

    pub async fn is_paused(&self, terminal_id: &str) -> Result<bool, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        Ok(t.paused.load(Ordering::SeqCst))
    }

    pub async fn set_session_background(
        &self,
        terminal_id: &str,
        background: bool,
    ) -> Result<(), TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        t.background.store(background, Ordering::SeqCst);
        Ok(())
    }

    pub async fn is_background(&self, terminal_id: &str) -> Result<bool, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        Ok(t.background.load(Ordering::Relaxed))
    }

    pub async fn signal(&self, terminal_id: &str, sig: &str) -> Result<(), TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        t.session.signal(sig).await?;
        Ok(())
    }

    pub async fn get_cwd(&self, terminal_id: &str) -> Result<Option<String>, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        let dyn_guard = t.dynamic_cwd.read().await;
        if let Some(p) = &*dyn_guard {
            return Ok(Some(p.to_string_lossy().to_string()));
        }
        Ok(t.cwd.as_ref().map(|p| p.to_string_lossy().to_string()))
    }

    pub async fn get_title(&self, terminal_id: &str) -> Result<Option<String>, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        let title_guard = t.title.read().await;
        Ok(title_guard.clone())
    }

    pub async fn get_snapshot(&self, terminal_id: &str) -> Result<TerminalSnapshot, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        let sb_bytes = {
            let guard = t.scrollback.lock().await;
            guard.clone()
        };
        let scrollback_ansi = String::from_utf8_lossy(&sb_bytes).into_owned();
        let scrollback_lines = scrollback_ansi.lines().count();
        let cwd = {
            let dyn_guard = t.dynamic_cwd.read().await;
            dyn_guard
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .or_else(|| t.cwd.as_ref().map(|p| p.to_string_lossy().to_string()))
        };
        let last_title = {
            let guard = t.title.read().await;
            guard.clone()
        };
        let cols = t.cols.load(Ordering::SeqCst);
        let rows = t.rows.load(Ordering::SeqCst);

        Ok(TerminalSnapshot {
            snapshot_ansi: scrollback_ansi.clone(),
            scrollback_ansi,
            pending_escape_tail_ansi: None,
            osc_links: None,
            rehydrate_sequences: String::new(),
            frame_restore_ansi: None,
            cwd,
            modes: TerminalModes::default(),
            cols,
            rows,
            scrollback_lines,
            last_title,
            output_sequence: Some(t.pending_seq.load(Ordering::SeqCst)),
            terminal_owner: None,
        })
    }

    pub async fn take_pending_output(
        &self,
        terminal_id: &str,
        include_snapshot: bool,
    ) -> Result<TakePendingOutputResult, TerminalError> {
        let t = self.get_terminal(terminal_id).await?;
        let records = {
            let mut records_guard = t.pending_records.lock().await;
            std::mem::take(&mut *records_guard)
        };
        t.pending_bytes.store(0, Ordering::SeqCst);
        let overflowed = t.pending_overflowed.swap(false, Ordering::SeqCst);

        let should_advance = include_snapshot || !records.is_empty() || overflowed;
        let seq = if should_advance {
            t.pending_seq.fetch_add(1, Ordering::SeqCst) + 1
        } else {
            t.pending_seq.load(Ordering::SeqCst)
        };

        let snapshot = if include_snapshot {
            Some(self.get_snapshot(terminal_id).await?)
        } else {
            None
        };

        Ok(TakePendingOutputResult {
            records,
            seq,
            overflowed,
            snapshot,
        })
    }

    pub async fn is_tombstoned(&self, terminal_id: &str) -> bool {
        self.tombstones.read().await.has(terminal_id)
    }

    pub async fn tombstone_count(&self) -> usize {
        self.tombstones.read().await.len()
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

const PENDING_OUTPUT_MAX_BYTES: usize = 2 * 1024 * 1024; // 2MB

async fn record_pending_output(
    records_lock: &Mutex<Vec<PendingOutputRecord>>,
    bytes_atomic: &AtomicUsize,
    overflowed_atomic: &AtomicBool,
    record: PendingOutputRecord,
) {
    if overflowed_atomic.load(Ordering::SeqCst) {
        return;
    }
    let record_len = record.data.as_ref().map(|d| d.len()).unwrap_or(8);
    let current_bytes = bytes_atomic.load(Ordering::SeqCst);
    if current_bytes + record_len > PENDING_OUTPUT_MAX_BYTES {
        let mut list = records_lock.lock().await;
        list.clear();
        bytes_atomic.store(0, Ordering::SeqCst);
        overflowed_atomic.store(true, Ordering::SeqCst);
        return;
    }

    let mut list = records_lock.lock().await;
    if record.kind == "output" {
        if let Some(last) = list.last_mut() {
            if last.kind == "output" {
                if let (Some(last_data), Some(new_data)) = (&mut last.data, &record.data) {
                    if last_data.len() + new_data.len() <= 64 * 1024 {
                        last_data.push_str(new_data);
                        bytes_atomic.fetch_add(record_len, Ordering::SeqCst);
                        return;
                    }
                }
            }
        }
    }
    list.push(record);
    bytes_atomic.fetch_add(record_len, Ordering::SeqCst);
}
