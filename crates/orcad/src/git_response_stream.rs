use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify, RwLock};

/// Threshold in bytes above which a Git RPC response is streamed chunk-by-chunk (256 KB).
pub const GIT_RESPONSE_STREAM_THRESHOLD: usize = 256 * 1024;

/// Size of each chunk payload in bytes before Base64 encoding (128 KB).
pub const GIT_RESPONSE_CHUNK_SIZE: usize = 128 * 1024;

/// Sliding credit window: maximum unacknowledged in-flight chunks allowed before the pump parks.
pub const STREAM_ACK_WINDOW_CHUNKS: u64 = 4;

/// Stall timeout to re-check client backpressure, abort state, or disconnection (1000 ms).
pub const STREAM_ACK_STALL_RECHECK_MS: u64 = 1_000;

/// Standard RFC 4648 Base64 character set.
const BASE64_STANDARD_CHARSET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encodes binary data into standard RFC 4648 Base64 with padding.
pub fn to_standard_base64(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i];
        let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
        let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };

        out.push(BASE64_STANDARD_CHARSET[(b0 >> 2) as usize] as char);
        out.push(BASE64_STANDARD_CHARSET[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);

        if i + 1 < input.len() {
            out.push(BASE64_STANDARD_CHARSET[(((b1 & 15) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }

        if i + 2 < input.len() {
            out.push(BASE64_STANDARD_CHARSET[(b2 & 63) as usize] as char);
        } else {
            out.push('=');
        }

        i += 3;
    }
    out
}

/// Decodes standard RFC 4648 Base64 string into raw bytes.
pub fn from_standard_base64(input: &str) -> Result<Vec<u8>, String> {
    let clean = input.trim();
    if clean.is_empty() {
        return Ok(Vec::new());
    }
    if clean.len() % 4 != 0 {
        return Err("Invalid Base64 length: not a multiple of 4".to_string());
    }

    fn decode_char(c: u8) -> Result<u8, String> {
        match c {
            b'A'..=b'Z' => Ok(c - b'A'),
            b'a'..=b'z' => Ok(c - b'a' + 26),
            b'0'..=b'9' => Ok(c - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("Invalid Base64 character: {}", c as char)),
        }
    }

    let bytes = clean.as_bytes();
    let mut out = Vec::with_capacity(clean.len() / 4 * 3);

    let mut i = 0;
    while i < bytes.len() {
        let c0 = decode_char(bytes[i])?;
        let c1 = decode_char(bytes[i + 1])?;

        let pad2 = bytes[i + 2] == b'=';
        let pad3 = bytes[i + 3] == b'=';

        let c2 = if pad2 { 0 } else { decode_char(bytes[i + 2])? };
        let c3 = if pad3 { 0 } else { decode_char(bytes[i + 3])? };

        out.push((c0 << 2) | (c1 >> 4));

        if !pad2 {
            out.push(((c1 & 0x0F) << 4) | (c2 >> 2));
        } else if !pad3 {
            return Err("Invalid Base64 padding pattern".to_string());
        }

        if !pad3 {
            out.push(((c2 & 0x03) << 6) | c3);
        }

        i += 4;
    }

    Ok(out)
}

/// Chunks binary payload into 128 KB slices and Base64-encodes each slice.
pub fn encode_chunks(payload: &[u8], chunk_size: usize) -> Vec<String> {
    if payload.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    for slice in payload.chunks(chunk_size) {
        chunks.push(to_standard_base64(slice));
    }
    chunks
}

/// Metadata describing a chunked stream.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResponseStreamMeta {
    pub stream_id: u64,
    pub total_bytes: usize,
    pub chunk_count: usize,
}

/// Sentinel marker returned to the RPC caller when a response exceeds the threshold.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitResponseStreamMarker {
    #[serde(rename = "__orcaGitResponseStream")]
    pub stream_marker: GitResponseStreamMeta,
}

impl GitResponseStreamMarker {
    pub fn new(stream_id: u64, total_bytes: usize, chunk_count: usize) -> Self {
        Self {
            stream_marker: GitResponseStreamMeta {
                stream_id,
                total_bytes,
                chunk_count,
            },
        }
    }
}

/// Parameters for a `git.responseChunk` notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResponseChunkParams {
    pub stream_id: u64,
    pub seq: u64,
    pub data: String,
}

/// Parameters for a `git.responseAck` notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResponseAckParams {
    pub stream_id: u64,
    pub seq: u64,
}

/// Parameters for a `git.responseEnd` notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResponseEndParams {
    pub stream_id: u64,
}

/// Parameters for a `git.responseError` notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitResponseErrorParams {
    pub stream_id: u64,
    pub message: String,
}

/// Parameters for a `git.cancelResponseStream` notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCancelStreamParams {
    pub stream_id: u64,
}

/// Helper function to check whether an RPC response should be streamed.
pub fn should_stream_response(payload_len: usize, stream_response_opt: bool) -> bool {
    stream_response_opt && payload_len > GIT_RESPONSE_STREAM_THRESHOLD
}

/// Active stream state tracked by the registry.
pub struct GitStreamEntry {
    pub stream_id: u64,
    pub client_id: u64,
    pub aborted: AtomicBool,
    pub acked_through_seq: AtomicI64,
    pub notify: Arc<Notify>,
}

/// Central registry managing Git response streaming and credit-based backpressure.
pub struct GitResponseStreamRegistry {
    next_id: AtomicU64,
    streams: Arc<RwLock<HashMap<u64, Arc<GitStreamEntry>>>>,
    disposed: AtomicBool,
    stall_recheck_ms: u64,
    ack_window_chunks: u64,
}

impl Default for GitResponseStreamRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl GitResponseStreamRegistry {
    /// Creates a new registry with default constants.
    pub fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            streams: Arc::new(RwLock::new(HashMap::new())),
            disposed: AtomicBool::new(false),
            stall_recheck_ms: STREAM_ACK_STALL_RECHECK_MS,
            ack_window_chunks: STREAM_ACK_WINDOW_CHUNKS,
        }
    }

    /// Creates a registry with custom stall recheck interval and window for testing.
    pub fn with_config(stall_recheck_ms: u64, ack_window_chunks: u64) -> Self {
        Self {
            next_id: AtomicU64::new(1),
            streams: Arc::new(RwLock::new(HashMap::new())),
            disposed: AtomicBool::new(false),
            stall_recheck_ms,
            ack_window_chunks,
        }
    }

    /// Records client acknowledgment for chunks up to `seq`.
    /// Advances `acked_through_seq` monotonically and wakes any parked pump.
    pub async fn record_ack(&self, stream_id: u64, seq: u64) -> bool {
        let streams = self.streams.read().await;
        if let Some(entry) = streams.get(&stream_id) {
            let mut current = entry.acked_through_seq.load(Ordering::Acquire);
            while (seq as i64) > current {
                match entry.acked_through_seq.compare_exchange_weak(
                    current,
                    seq as i64,
                    Ordering::Release,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(actual) => current = actual,
                }
            }
            entry.notify.notify_waiters();
            true
        } else {
            false
        }
    }

    /// Records acknowledgment with client ownership validation.
    pub async fn record_ack_with_client(&self, stream_id: u64, seq: u64, client_id: u64) -> bool {
        let streams = self.streams.read().await;
        if let Some(entry) = streams.get(&stream_id) {
            if entry.client_id != client_id {
                return false;
            }
            let mut current = entry.acked_through_seq.load(Ordering::Acquire);
            while (seq as i64) > current {
                match entry.acked_through_seq.compare_exchange_weak(
                    current,
                    seq as i64,
                    Ordering::Release,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(actual) => current = actual,
                }
            }
            entry.notify.notify_waiters();
            true
        } else {
            false
        }
    }

    /// Aborts an active stream, causing its pump to terminate immediately.
    pub async fn abort(&self, stream_id: u64) -> bool {
        let streams = self.streams.read().await;
        if let Some(entry) = streams.get(&stream_id) {
            entry.aborted.store(true, Ordering::Release);
            entry.notify.notify_waiters();
            true
        } else {
            false
        }
    }

    /// Aborts an active stream with client ownership check.
    pub async fn abort_with_client(&self, stream_id: u64, client_id: u64) -> bool {
        let streams = self.streams.read().await;
        if let Some(entry) = streams.get(&stream_id) {
            if entry.client_id != client_id {
                return false;
            }
            entry.aborted.store(true, Ordering::Release);
            entry.notify.notify_waiters();
            true
        } else {
            false
        }
    }

    /// Wakes all parked pumps so they detect disconnects, shutdown, or staleness.
    pub async fn wake_all(&self) {
        let streams = self.streams.read().await;
        for entry in streams.values() {
            entry.notify.notify_waiters();
        }
    }

    /// Returns the number of currently active streams.
    pub async fn active_streams_count(&self) -> usize {
        self.streams.read().await.len()
    }

    /// Checks if a stream is currently registered.
    pub async fn has_stream(&self, stream_id: u64) -> bool {
        self.streams.read().await.contains_key(&stream_id)
    }

    /// Returns the current `acked_through_seq` for a stream.
    pub async fn acked_through_seq(&self, stream_id: u64) -> Option<i64> {
        let streams = self.streams.read().await;
        streams
            .get(&stream_id)
            .map(|e| e.acked_through_seq.load(Ordering::Acquire))
    }

    /// Disposes the registry and aborts all active streams.
    pub async fn dispose_all(&self) {
        self.disposed.store(true, Ordering::Release);
        let streams = self.streams.read().await;
        for entry in streams.values() {
            entry.aborted.store(true, Ordering::Release);
            entry.notify.notify_waiters();
        }
    }

    /// Reopens the registry after disposal.
    pub fn reopen(&self) {
        self.disposed.store(false, Ordering::Release);
    }

    /// Checks if the registry is disposed.
    pub fn is_disposed(&self) -> bool {
        self.disposed.load(Ordering::Acquire)
    }

    /// Starts streaming `payload_bytes` through `out_tx`.
    /// Slices the payload into 128 KB Base64 chunks, returns `GitResponseStreamMarker`,
    /// and spawns the background pump task.
    pub async fn start_stream(
        &self,
        payload_bytes: &[u8],
        client_id: u64,
        out_tx: mpsc::Sender<String>,
    ) -> Result<GitResponseStreamMarker, String> {
        if self.disposed.load(Ordering::Acquire) {
            return Err("git_response_stream_disposed".to_string());
        }

        let stream_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let notify = Arc::new(Notify::new());
        let entry = Arc::new(GitStreamEntry {
            stream_id,
            client_id,
            aborted: AtomicBool::new(false),
            acked_through_seq: AtomicI64::new(-1),
            notify: Arc::clone(&notify),
        });

        let mut chunks = encode_chunks(payload_bytes, GIT_RESPONSE_CHUNK_SIZE);
        let chunk_count = chunks.len();
        let total_bytes = payload_bytes.len();

        {
            let mut map = self.streams.write().await;
            map.insert(stream_id, Arc::clone(&entry));
        }

        let streams_ref = Arc::clone(&self.streams);
        let entry_clone = Arc::clone(&entry);
        let stall_recheck = Duration::from_millis(self.stall_recheck_ms);
        let ack_window = self.ack_window_chunks as i64;

        // Spawn asynchronous pump task
        tokio::spawn(async move {
            let mut channel_broken = false;

            for seq in 0..chunk_count {
                if entry_clone.aborted.load(Ordering::Acquire) {
                    break;
                }

                // Credit window check: park if (seq - acked > ack_window)
                loop {
                    if entry_clone.aborted.load(Ordering::Acquire) || out_tx.is_closed() {
                        if out_tx.is_closed() {
                            channel_broken = true;
                        }
                        break;
                    }
                    let acked = entry_clone.acked_through_seq.load(Ordering::Acquire);
                    if (seq as i64) - acked <= ack_window {
                        break;
                    }
                    // Park until ACK or stall timeout
                    let _ =
                        tokio::time::timeout(stall_recheck, entry_clone.notify.notified()).await;
                }

                if channel_broken || entry_clone.aborted.load(Ordering::Acquire) {
                    break;
                }

                // Send git.responseChunk notification
                let event = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "git.responseChunk",
                    "params": {
                        "streamId": stream_id,
                        "seq": seq as u64,
                        "data": &chunks[seq],
                    }
                });

                let mut s = event.to_string();
                s.push('\n');
                if out_tx.send(s).await.is_err() {
                    channel_broken = true;
                    break;
                }

                // Memory reclamation: clear sent chunk immediately
                chunks[seq] = String::new();
            }

            // Emit git.responseEnd if stream completed successfully without abort or disconnect
            if !channel_broken && !entry_clone.aborted.load(Ordering::Acquire) {
                let end_event = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "git.responseEnd",
                    "params": {
                        "streamId": stream_id,
                    }
                });
                let mut s = end_event.to_string();
                s.push('\n');
                let _ = out_tx.send(s).await;
            }

            // Cleanup from active streams registry
            let mut map = streams_ref.write().await;
            map.remove(&stream_id);
        });

        Ok(GitResponseStreamMarker::new(
            stream_id,
            total_bytes,
            chunk_count,
        ))
    }
}
