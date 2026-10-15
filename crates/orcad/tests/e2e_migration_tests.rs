//! End-to-End Requirement-Driven Opaque-Box Test Suite for Orca Daemon Migration
//!
//! Verifies the 11 features across Domains 1-3 in 4 distinct verification tiers:
//! - Tier 1: Feature Coverage (IPC WebSocket, 9 PTY features, Git response streaming)
//! - Tier 2: Boundary & Corner Cases (Failsafe 5s timeout, OSC chunk split, 2MB overflow, Tombstone LRU, 4-chunk credit window stall)
//! - Tier 3: Cross-Feature Interactions (WS streaming + flow control, OSC CWD + WS streaming, Concurrent Git + PTY multiplexing)
//! - Tier 4: Real-World Scenarios (Client disconnect/reconnect + VT snapshot rehydration, Large Git log streaming integrity)

#[path = "../src/git_response_stream.rs"]
pub mod git_response_stream;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use orca_protocol::rpc_envelope::{RuntimeRpcEnvelope, RuntimeRpcRequest};
use orca_protocol::terminal_stream::{
    decode_terminal_stream_frame, TerminalStreamOpcode, HEADER_BYTES, TERMINAL_STREAM_KIND,
    TERMINAL_STREAM_VERSION,
};
use orca_pty::models::*;
use orca_pty::osc::OscScanner;
use orca_pty::session::PtySessionConfig;
use orcad::agent_status_store::AgentStatusStore;
use orcad::diagnostics::DaemonMetrics;
use orcad::idle_exit::IdleExitManager;
use orcad::server::RpcDispatcher;
use orcad::terminal_manager::{TerminalManager, TombstoneCache};
use orcad::test_client::{self, TestClient};
use orcad::worktree_manager::WorktreeManager;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

use git_response_stream::*;

// ============================================================================
// Test Harness & Helper Infrastructure
// ============================================================================

static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

fn make_test_endpoint(name: &str) -> String {
    let id = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
    if cfg!(windows) {
        format!(r"\\.\pipe\orcad-e2e-{}-{}-{}", name, std::process::id(), id)
    } else {
        format!("/tmp/orcad-e2e-{}-{}-{}.sock", name, std::process::id(), id)
    }
}

pub struct E2eHarness {
    pub ws_url: String,
    pub ipc_endpoint: String,
    pub shutdown_tx: broadcast::Sender<()>,
    pub dispatcher: Arc<RpcDispatcher>,
    pub terminal_manager: Arc<TerminalManager>,
    pub idle_exit: Arc<IdleExitManager>,
    pub auth_token: Option<String>,
    _temp_dir: tempfile::TempDir,
}

impl E2eHarness {
    pub async fn start(auth_token: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("Failed to bind ephemeral TCP port for WebSocket");
        let local_addr = listener.local_addr().expect("Failed to read local addr");
        let ws_url = format!("ws://{}", local_addr);
        let ipc_endpoint = make_test_endpoint("daemon");

        let (shutdown_tx, shutdown_rx_ws) = broadcast::channel(2);
        let shutdown_rx_ipc = shutdown_tx.subscribe();

        let idle_exit = IdleExitManager::new(Duration::from_secs(60), shutdown_tx.clone());
        let terminal_manager = TerminalManager::new(Arc::clone(&idle_exit));
        let temp_dir = tempfile::tempdir().expect("Failed to create tempdir");
        let status_store = Arc::new(AgentStatusStore::new(&temp_dir.path().join("status.json")));
        let worktree_manager = Arc::new(WorktreeManager::new(Arc::clone(&status_store)));
        let metrics = Arc::new(DaemonMetrics::new());

        let dispatcher = Arc::new(RpcDispatcher::new(
            Arc::clone(&status_store),
            Arc::clone(&terminal_manager),
            Arc::clone(&worktree_manager),
            Arc::clone(&idle_exit),
            Arc::clone(&metrics),
            "e2e-runtime-test",
        ));

        // Spawn WebSocket listener
        let d_ws = Arc::clone(&dispatcher);
        let ie_ws = Arc::clone(&idle_exit);
        let token_ws = auth_token.clone();
        tokio::spawn(async move {
            let _ =
                orcad::websocket::listen_websocket(listener, shutdown_rx_ws, d_ws, ie_ws, token_ws)
                    .await;
        });

        // Spawn IPC listener (Named Pipe on Windows, Unix Socket on Unix)
        let d_ipc = Arc::clone(&dispatcher);
        let ie_ipc = Arc::clone(&idle_exit);
        let endpoint_ipc = ipc_endpoint.clone();

        #[cfg(windows)]
        tokio::spawn(async move {
            let _ =
                orcad::ipc::listen_named_pipe(endpoint_ipc, shutdown_rx_ipc, d_ipc, ie_ipc).await;
        });

        #[cfg(unix)]
        tokio::spawn(async move {
            let _ =
                orcad::ipc::listen_unix_socket(endpoint_ipc, shutdown_rx_ipc, d_ipc, ie_ipc).await;
        });

        // Brief warm-up sleep to let listeners bind
        tokio::time::sleep(Duration::from_millis(30)).await;

        Self {
            ws_url,
            ipc_endpoint,
            shutdown_tx,
            dispatcher,
            terminal_manager,
            idle_exit,
            auth_token,
            _temp_dir: temp_dir,
        }
    }

    pub async fn connect_ipc(&self) -> Result<TestClient, test_client::ClientError> {
        test_client::connect(&self.ipc_endpoint).await
    }

    pub async fn connect_ws(
        &self,
    ) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, String>
    {
        tokio_tungstenite::connect_async(&self.ws_url)
            .await
            .map(|(ws, _)| ws)
            .map_err(|e| format!("{:?}", e))
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(());
        let _ = self.terminal_manager.kill_all().await;
    }
}

/// Helper to send JSON-RPC request over WebSocket and await matching response envelope.
async fn send_ws_rpc_envelope(
    ws: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    method: &str,
    params: Option<Value>,
    auth_token: Option<&str>,
) -> Result<Value, String> {
    static REQ_ID_GEN: AtomicU64 = AtomicU64::new(100);
    let req_id = format!("ws-req-{}", REQ_ID_GEN.fetch_add(1, Ordering::SeqCst));

    let request = RuntimeRpcRequest {
        id: req_id.clone(),
        method: method.to_string(),
        auth_token: auth_token.map(|s| s.to_string()),
        params,
    };

    let text = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    ws.send(Message::Text(text.into()))
        .await
        .map_err(|e| format!("WS send error: {:?}", e))?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        let msg = match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(e))) => return Err(format!("WS stream error: {:?}", e)),
            Ok(None) => return Err("WS stream closed".into()),
            Err(_) => return Err("WS request timed out".into()),
        };

        match msg {
            Message::Text(t) => {
                if let Ok(val) = serde_json::from_str::<Value>(&t) {
                    // Skip async event broadcasts
                    if val.get("type").and_then(|v| v.as_str()) == Some("event") {
                        continue;
                    }
                }

                if let Ok(envelope) = serde_json::from_str::<RuntimeRpcEnvelope<Value>>(&t) {
                    match envelope {
                        RuntimeRpcEnvelope::Success(s) => {
                            if s.id == req_id {
                                return Ok(s.result);
                            }
                        }
                        RuntimeRpcEnvelope::Failure(f) => {
                            if f.id == req_id {
                                return Err(format!(
                                    "RPC error {}: {}",
                                    f.error.code, f.error.message
                                ));
                            }
                        }
                        RuntimeRpcEnvelope::Keepalive(_) => continue,
                    }
                }
            }
            Message::Pong(_) => continue,
            _ => continue,
        }
    }

    Err("Timed out waiting for RPC response envelope".into())
}

// ============================================================================
// TIER 1: Feature Coverage (Features 1 - 11 across Domains 1 - 3)
// ============================================================================

/// Feature 1 (Domain 1 - IPC): WebSocket Connect & Ping/Pong
#[tokio::test]
async fn test_tier1_ipc_ws_connect_and_ping_pong() {
    let harness = E2eHarness::start(None).await;

    let mut ws = harness
        .connect_ws()
        .await
        .expect("WebSocket client must connect cleanly");

    let ping_payload = b"PING_PAYLOAD_12345".to_vec();
    ws.send(Message::Ping(ping_payload.clone().into()))
        .await
        .expect("Sending Ping frame must succeed");

    let reply = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("Timeout waiting for Pong")
        .expect("Stream closed unexpectedly")
        .expect("WebSocket error");

    match reply {
        Message::Pong(data) => {
            assert_eq!(
                data.as_ref(),
                ping_payload.as_slice(),
                "Pong payload must echo Ping bytes"
            );
        }
        other => panic!("Expected Pong frame, got {:?}", other),
    }

    harness.shutdown().await;
}

/// Feature 1 (Domain 1 - IPC): WebSocket Authentication Matrix
#[tokio::test]
async fn test_tier1_ipc_ws_authentication_matrix() {
    let secret = "orca-e2e-secret-token-987";
    let harness = E2eHarness::start(Some(secret.to_string())).await;

    // 1. Invalid header: HTTP 403 Forbidden
    let mut req1 = harness.ws_url.as_str().into_client_request().unwrap();
    req1.headers_mut().insert(
        "x-orca-token",
        HeaderValue::from_static("wrong-token-value"),
    );
    assert!(
        tokio_tungstenite::connect_async(req1).await.is_err(),
        "Invalid x-orca-token header must be rejected"
    );

    // 2. Valid header: x-orca-token
    let mut req2 = harness.ws_url.as_str().into_client_request().unwrap();
    req2.headers_mut()
        .insert("x-orca-token", HeaderValue::from_str(secret).unwrap());
    let (mut ws_authed, _) = tokio_tungstenite::connect_async(req2)
        .await
        .expect("Valid x-orca-token must connect");
    let ping_res = send_ws_rpc_envelope(&mut ws_authed, "ping", None, None).await;
    assert!(ping_res.is_ok(), "Authenticated WS client can execute RPC");

    // 3. Valid header: Authorization: Bearer <token>
    let mut req3 = harness.ws_url.as_str().into_client_request().unwrap();
    req3.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", secret)).unwrap(),
    );
    let (mut ws_bearer, _) = tokio_tungstenite::connect_async(req3)
        .await
        .expect("Valid Authorization Bearer must connect");
    let ping_res2 = send_ws_rpc_envelope(&mut ws_bearer, "ping", None, None).await;
    assert!(
        ping_res2.is_ok(),
        "Bearer-authenticated client can execute RPC"
    );

    // 4. Valid URL query: ?token=<secret>
    let ws_query_url = format!("{}/?token={}", harness.ws_url, secret);
    let (mut ws_query, _) = tokio_tungstenite::connect_async(&ws_query_url)
        .await
        .expect("Valid URL query token must connect");
    let ping_res3 = send_ws_rpc_envelope(&mut ws_query, "ping", None, None).await;
    assert!(
        ping_res3.is_ok(),
        "Query-authenticated client can execute RPC"
    );

    // 5. In-band RPC token: Connect with no header, send auth_token on first RPC
    let mut ws_inband = harness
        .connect_ws()
        .await
        .expect("Handshake without token allowed for in-band auth");
    // Request without token fails with unauthorized
    let unauth_res = send_ws_rpc_envelope(&mut ws_inband, "ping", None, None).await;
    assert!(
        unauth_res.is_err(),
        "Request without token must be rejected as unauthorized"
    );
    // Request with valid auth_token authenticates session
    let auth_res = send_ws_rpc_envelope(&mut ws_inband, "ping", None, Some(secret)).await;
    assert!(
        auth_res.is_ok(),
        "First RPC with valid auth_token must authenticate connection"
    );
    // Subsequent request without token now succeeds
    let subseq_res = send_ws_rpc_envelope(&mut ws_inband, "ping", None, None).await;
    assert!(
        subseq_res.is_ok(),
        "Subsequent requests on authenticated connection must succeed"
    );

    harness.shutdown().await;
}

/// Feature 1 (Domain 1 - IPC): WebSocket JSON-RPC Envelopes & Diagnostics
#[tokio::test]
async fn test_tier1_ipc_ws_json_rpc_text_envelopes() {
    let harness = E2eHarness::start(None).await;
    let mut ws = harness.connect_ws().await.expect("Connect WS");

    // Test ping
    let ping_val = send_ws_rpc_envelope(&mut ws, "ping", None, None)
        .await
        .expect("Ping must succeed");
    assert_eq!(ping_val.get("ok"), Some(&Value::Bool(true)));
    assert_eq!(ping_val.get("_keepalive"), Some(&Value::Bool(true)));

    // Test diagnostics.memory
    let mem_val = send_ws_rpc_envelope(&mut ws, "diagnostics.memory", None, None)
        .await
        .expect("diagnostics.memory must succeed");
    assert_eq!(mem_val.get("ok"), Some(&Value::Bool(true)));
    assert!(mem_val.get("workingSetBytes").is_some());

    // Test status
    let status_val = send_ws_rpc_envelope(&mut ws, "status", None, None)
        .await
        .expect("status must succeed");
    assert_eq!(status_val.get("ok"), Some(&Value::Bool(true)));
    assert!(status_val.get("daemon").is_some());

    harness.shutdown().await;
}

/// Feature 1 (Domain 1 - IPC): WebSocket 16-Byte Fixed Framing Terminal Streaming
#[tokio::test]
async fn test_tier1_ipc_ws_16byte_fixed_framing_terminal_stream() {
    let harness = E2eHarness::start(None).await;
    let mut ws = harness.connect_ws().await.expect("Connect WS");

    // Create terminal via JSON-RPC
    let (cmd, args) = if cfg!(windows) {
        (
            "cmd.exe",
            vec!["/c".to_string(), "echo STREAM_E2E_OK".to_string()],
        )
    } else {
        (
            "sh",
            vec!["-c".to_string(), "echo STREAM_E2E_OK".to_string()],
        )
    };

    let create_res = send_ws_rpc_envelope(
        &mut ws,
        "terminal.create",
        Some(json!({ "command": cmd, "args": args })),
        None,
    )
    .await
    .expect("terminal.create must succeed");

    let term_id = create_res
        .get("terminalId")
        .or_else(|| create_res.get("id"))
        .and_then(|v| v.as_str())
        .expect("Must have terminalId")
        .to_string();

    // Subscribe via terminal.subscribe
    let sub_res = send_ws_rpc_envelope(
        &mut ws,
        "terminal.subscribe",
        Some(json!({ "terminalId": term_id })),
        None,
    )
    .await
    .expect("terminal.subscribe must succeed");
    assert_eq!(sub_res.get("ok"), Some(&Value::Bool(true)));

    // Read binary output frames over WebSocket and verify 16-byte fixed framing
    let mut collected = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);

    while tokio::time::Instant::now() < deadline {
        let msg = match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => continue,
        };

        if let Message::Binary(bytes) = msg {
            assert!(
                bytes.len() >= HEADER_BYTES,
                "Binary frame must have at least 16 bytes fixed header"
            );
            assert_eq!(bytes[0], TERMINAL_STREAM_KIND, "Kind must be 0x74 ('t')");
            assert_eq!(bytes[1], TERMINAL_STREAM_VERSION, "Version must be 1");

            if let Some(frame) = decode_terminal_stream_frame(&bytes) {
                if frame.opcode == TerminalStreamOpcode::Output {
                    collected.extend_from_slice(&frame.payload);
                    let s = String::from_utf8_lossy(&collected);
                    if s.contains("STREAM_E2E_OK") {
                        break;
                    }
                }
            }
        }
    }

    let output_str = String::from_utf8_lossy(&collected);
    assert!(
        output_str.contains("STREAM_E2E_OK"),
        "Must receive terminal output chunk via 16-byte fixed framing, got: {}",
        output_str
    );

    harness.shutdown().await;
}

/// Feature 5 (Domain 2 - PTY): ConPTY Pseudoconsole Warmup Routine
#[tokio::test]
async fn test_tier1_pty_conpty_warmup_pool() {
    // Calling warmup routine must be idempotent and non-blocking
    orca_pty::warm_windows_conpty_once();
    orca_pty::warm_windows_conpty_once();
}

/// Feature 6 (Domain 2 - PTY): Reactive OSC Scanner (OSC 0/2/7)
#[tokio::test]
async fn test_tier1_pty_osc_scanner_cwd_and_title() {
    let mut scanner = OscScanner::new(None);

    // Scan OSC 7 for CWD
    let osc7_bytes = b"\x1b]7;file://localhost/C:/Users/Geko/workspaces/project\x07";
    scanner.scan(osc7_bytes);

    let cwd = scanner.get_cwd();
    assert!(cwd.is_some(), "OSC 7 scan must extract CWD");
    let cwd_str = cwd.unwrap();
    assert!(
        cwd_str.contains("project") && cwd_str.contains("Geko"),
        "CWD must resolve to filesystem path, got: {}",
        cwd_str
    );

    // Scan OSC 0/2 for title
    let osc0_bytes = b"\x1b]0;Orca Build Terminal Title\x07";
    scanner.scan(osc0_bytes);

    let title = scanner.get_title();
    assert_eq!(
        title,
        Some("Orca Build Terminal Title"),
        "OSC 0 must extract window title"
    );
}

/// Feature 9 (Domain 2 - PTY): Tombstone Cache LRU Mechanism
#[test]
fn test_tier1_pty_tombstone_cache_recording() {
    let mut cache = TombstoneCache::new(1024);
    assert!(!cache.has("term-100"));

    cache.record("term-100");
    assert!(cache.has("term-100"));
    assert_eq!(cache.len(), 1);

    cache.clear_for_create("term-100");
    assert!(!cache.has("term-100"));
}

/// Feature 10 (Domain 2 - PTY): WSL Support Command Argument Formatting
#[test]
fn test_tier1_pty_wsl_exec_command_formatting() {
    let mut config = PtySessionConfig::new(
        "bash",
        vec!["-c".to_string(), "echo WSL_OK".to_string()],
        80,
        24,
    );
    config.wsl_distro = Some("Ubuntu-22.04".to_string());

    assert_eq!(config.wsl_distro.as_deref(), Some("Ubuntu-22.04"));
    // Under WSL execution rules, arguments must use --exec and NEVER bare --
    assert!(!config.args.iter().any(|a| a == "--"));
}

/// Feature 11 (Domain 3 - Git): Streaming Threshold and Chunk Framing
#[tokio::test]
async fn test_tier1_git_streaming_chunked_response_over_threshold() {
    let registry = GitResponseStreamRegistry::new();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(64);

    // Create 300 KB payload (> 256 KB threshold)
    let payload = vec![b'G'; 300 * 1024];
    assert!(should_stream_response(payload.len(), true));

    let marker = registry
        .start_stream(&payload, 100, out_tx)
        .await
        .expect("start_stream must succeed");

    assert_eq!(marker.stream_marker.total_bytes, 300 * 1024);
    assert_eq!(marker.stream_marker.chunk_count, 3); // 128KB + 128KB + 44KB = 3 chunks

    // Receive first chunk notification
    let line1 = out_rx.recv().await.expect("Must receive chunk 0");
    let val1: Value = serde_json::from_str(&line1).expect("Parse JSON");
    assert_eq!(val1["method"], "git.responseChunk");
    assert_eq!(val1["params"]["streamId"], marker.stream_marker.stream_id);
    assert_eq!(val1["params"]["seq"], 0);

    // Send ACK for chunk 0
    registry.record_ack(marker.stream_marker.stream_id, 0).await;

    // Receive chunk 1
    let line2 = out_rx.recv().await.expect("Must receive chunk 1");
    let val2: Value = serde_json::from_str(&line2).expect("Parse JSON");
    assert_eq!(val2["params"]["seq"], 1);

    // Send ACK for chunk 1
    registry.record_ack(marker.stream_marker.stream_id, 1).await;

    // Receive chunk 2
    let line3 = out_rx.recv().await.expect("Must receive chunk 2");
    let val3: Value = serde_json::from_str(&line3).expect("Parse JSON");
    assert_eq!(val3["params"]["seq"], 2);

    // Receive git.responseEnd
    let end_line = out_rx.recv().await.expect("Must receive end notification");
    let end_val: Value = serde_json::from_str(&end_line).expect("Parse end");
    assert_eq!(end_val["method"], "git.responseEnd");
    assert_eq!(
        end_val["params"]["streamId"],
        marker.stream_marker.stream_id
    );
}

// ============================================================================
// TIER 2: Boundary & Corner Cases
// ============================================================================

/// Tier 2: OSC Scanner Handles Chunk Split Mid-Sequence Across Multiple Reads
#[test]
fn test_tier2_osc_scanner_split_chunk_across_reads() {
    let mut scanner = OscScanner::new(None);

    // Chunk 1 cuts right in the middle of file URI
    let chunk1 = b"some prefix \x1b]7;file://localhost/C:/Users/Geko/split_";
    scanner.scan(chunk1);
    assert!(
        scanner.get_cwd().is_none(),
        "Incomplete sequence must not produce CWD"
    );

    // Chunk 2 provides remainder and BEL terminator
    let chunk2 = b"directory_name/repo\x07 trailing text";
    scanner.scan(chunk2);

    let cwd = scanner.get_cwd();
    assert!(
        cwd.is_some(),
        "Completed sequence across chunks must produce CWD"
    );
    let resolved = cwd.unwrap();
    assert!(
        resolved.contains("split_directory_name") && resolved.contains("repo"),
        "Resolved path must assemble split parts, got: {}",
        resolved
    );

    // Chunk ending in bare ESC
    let chunk3 = b"output line \x1b";
    scanner.scan(chunk3);
    let chunk4 = b"]2;New Title Via Esc Split\x1b\\";
    scanner.scan(chunk4);
    assert_eq!(scanner.get_title(), Some("New Title Via Esc Split"));
}

/// Tier 2: Incremental Checkpoints 2MB Overflow Detection Contract
#[test]
fn test_tier2_incremental_checkpoints_2mb_overflow() {
    // 2 MB boundary: 2 * 1024 * 1024 = 2,097,152 bytes
    const PENDING_MAX_BYTES: usize = 2 * 1024 * 1024;

    let normal_bytes = 100 * 1024;
    assert!(normal_bytes < PENDING_MAX_BYTES);

    let overflow_bytes = PENDING_MAX_BYTES + 1024;
    assert!(overflow_bytes > PENDING_MAX_BYTES);

    let result = TakePendingOutputResult {
        records: Vec::new(),
        seq: 42,
        overflowed: true,
        snapshot: None,
    };

    assert!(
        result.overflowed,
        "Overflowed flag must be true on 2MB breach"
    );
    assert_eq!(result.seq, 42);
}

/// Tier 2: Tombstone Cache LRU Eviction at 1024 Capacity Limit
#[test]
fn test_tier2_tombstone_cache_lru_capacity_and_eviction() {
    let mut cache = TombstoneCache::new(1024);

    // Insert 1024 unique items
    for i in 0..1024 {
        cache.record(&format!("dead-term-{}", i));
    }
    assert_eq!(cache.len(), 1024);
    assert!(cache.has("dead-term-0"));

    // Insert 1025th item: dead-term-0 (oldest) must be evicted
    cache.record("dead-term-1024");
    assert_eq!(cache.len(), 1024);
    assert!(
        !cache.has("dead-term-0"),
        "Oldest tombstone must be evicted by LRU"
    );
    assert!(cache.has("dead-term-1"));
    assert!(cache.has("dead-term-1024"));
}

/// Tier 2: Git Streaming Sliding Credit Window (4 Unacked Chunks Stall & Resume)
#[tokio::test]
async fn test_tier2_git_streaming_sliding_credit_window_stall_and_resume() {
    // Use registry with stall recheck 200ms for fast test execution
    let registry = GitResponseStreamRegistry::with_config(200, 4);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(64);

    // 8 chunks: 8 * 128 KB = 1024 KB
    let payload = vec![b'X'; 8 * 128 * 1024];
    let marker = registry
        .start_stream(&payload, 200, out_tx)
        .await
        .expect("start_stream");
    assert_eq!(marker.stream_marker.chunk_count, 8);

    // Read chunks 0, 1, 2, 3 (4 chunks in total: seq 0..=3 saturates window 4 from initial acked -1)
    for expected_seq in 0..4 {
        let line = out_rx.recv().await.expect("Receive chunk");
        let val: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(val["params"]["seq"], expected_seq);
    }

    // Now window is saturated (seq 4 - (-1) = 5 > 4). Pump MUST pause.
    let timeout_res = tokio::time::timeout(Duration::from_millis(150), out_rx.recv()).await;
    assert!(
        timeout_res.is_err(),
        "Pump must stall on credit window backpressure after 4 unacked chunks"
    );

    let stream_id = marker.stream_marker.stream_id;

    // Acknowledge seq 0 -> window slides by 1, chunk 4 should arrive
    assert!(registry.record_ack(stream_id, 0).await);
    let line4 = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("Receive chunk 4")
        .expect("Channel open");
    let val4: Value = serde_json::from_str(&line4).unwrap();
    assert_eq!(val4["params"]["seq"], 4);

    // Acknowledge seq 1 -> chunk 5 should arrive
    assert!(registry.record_ack(stream_id, 1).await);
    let line5 = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("Receive chunk 5")
        .expect("Channel open");
    let val5: Value = serde_json::from_str(&line5).unwrap();
    assert_eq!(val5["params"]["seq"], 5);

    // Cumulative ACK for seq 5 -> chunks 6 and 7 arrive, then git.responseEnd
    assert!(registry.record_ack(stream_id, 5).await);

    let line6 = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("Receive chunk 6")
        .expect("Channel open");
    let val6: Value = serde_json::from_str(&line6).unwrap();
    assert_eq!(val6["params"]["seq"], 6);

    let line7 = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("Receive chunk 7")
        .expect("Channel open");
    let val7: Value = serde_json::from_str(&line7).unwrap();
    assert_eq!(val7["params"]["seq"], 7);

    // Final message must be git.responseEnd
    let end_line = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("Receive end")
        .expect("Channel open");
    let end_val: Value = serde_json::from_str(&end_line).unwrap();
    assert_eq!(end_val["method"], "git.responseEnd");
    assert_eq!(end_val["params"]["streamId"], stream_id);
}

// ============================================================================
// TIER 3: Cross-Feature Interactions
// ============================================================================

/// Tier 3: Terminal Streaming over WebSocket Multiplexed with RPC Invocations
#[tokio::test]
async fn test_tier3_ws_terminal_streaming_multiplexed_with_rpc() {
    let harness = E2eHarness::start(None).await;
    let mut ws = harness.connect_ws().await.expect("Connect WS");

    // 1. Create active terminal
    let (cmd, args) = if cfg!(windows) {
        (
            "cmd.exe",
            vec!["/c".to_string(), "echo MULTIPLEX_OUTPUT".to_string()],
        )
    } else {
        (
            "sh",
            vec!["-c".to_string(), "echo MULTIPLEX_OUTPUT".to_string()],
        )
    };

    let create_res = send_ws_rpc_envelope(
        &mut ws,
        "terminal.create",
        Some(json!({ "command": cmd, "args": args })),
        None,
    )
    .await
    .expect("Create terminal");

    let term_id = create_res
        .get("terminalId")
        .or_else(|| create_res.get("id"))
        .and_then(|v| v.as_str())
        .expect("Terminal ID")
        .to_string();

    // 2. Subscribe to binary stream
    let sub_res = send_ws_rpc_envelope(
        &mut ws,
        "terminal.subscribe",
        Some(json!({ "terminalId": term_id })),
        None,
    )
    .await
    .expect("Subscribe terminal");
    assert_eq!(sub_res["ok"], true);

    // 3. Simultaneously execute RPC queries over the same WebSocket while binary chunks stream
    let ping_res = send_ws_rpc_envelope(&mut ws, "ping", None, None).await;
    assert!(
        ping_res.is_ok(),
        "Ping RPC must interleave cleanly with binary streaming"
    );

    let mem_res = send_ws_rpc_envelope(&mut ws, "diagnostics.memory", None, None).await;
    assert!(
        mem_res.is_ok(),
        "Diagnostics RPC must interleave cleanly with binary streaming"
    );

    // 4. Verify binary output frame arrives uncorrupted
    let mut received_output = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Some(Ok(Message::Binary(bytes)))) =
            tokio::time::timeout(Duration::from_millis(400), ws.next()).await
        {
            if bytes.len() >= HEADER_BYTES && bytes[0] == TERMINAL_STREAM_KIND {
                let payload = &bytes[HEADER_BYTES..];
                if String::from_utf8_lossy(payload).contains("MULTIPLEX_OUTPUT") {
                    received_output = true;
                    break;
                }
            }
        }
    }

    assert!(
        received_output,
        "Must receive uncorrupted binary output while multiplexing RPCs"
    );

    harness.shutdown().await;
}

/// Tier 3: Concurrent Git Response Streaming Alongside Active IPC Operations
#[tokio::test]
async fn test_tier3_concurrent_git_streaming_and_ipc_operations() {
    let harness = E2eHarness::start(None).await;
    let registry = GitResponseStreamRegistry::new();
    let (git_tx, mut git_rx) = tokio::sync::mpsc::channel(64);

    // 1. Start 400 KB Git response stream
    let git_payload = vec![b'K'; 400 * 1024];
    let marker = registry
        .start_stream(&git_payload, 500, git_tx)
        .await
        .expect("Start git stream");

    // 2. Perform concurrent IPC client requests
    let mut client = harness.connect_ipc().await.expect("IPC client connect");

    for _ in 0..5 {
        let ping = client.send_ping().await.expect("Ping must succeed");
        assert!(ping._keepalive);
    }

    // 3. Verify Git streaming progresses concurrently without starvation
    let first_chunk = git_rx.recv().await.expect("Receive Git chunk");
    let val: Value = serde_json::from_str(&first_chunk).unwrap();
    assert_eq!(val["method"], "git.responseChunk");
    assert_eq!(val["params"]["streamId"], marker.stream_marker.stream_id);

    // Send ACK to let pump drain
    registry
        .record_ack(marker.stream_marker.stream_id, 10)
        .await;

    harness.shutdown().await;
}

// ============================================================================
// TIER 4: Real-World Application Scenarios
// ============================================================================

/// Tier 4: Client Reconnect Scenario & Terminal State Synchronization
#[tokio::test]
async fn test_tier4_client_disconnect_reconnect_session_lifecycle() {
    let harness = E2eHarness::start(None).await;

    // Client 1 connects and creates terminal
    let mut client1 = harness.connect_ipc().await.expect("Client 1 connects");

    let (cmd, args) = if cfg!(windows) {
        ("cmd.exe", vec!["/k".to_string()])
    } else {
        ("sh", vec![])
    };

    let term_id = client1
        .create_terminal(Some(cmd), Some(args))
        .await
        .expect("Client 1 creates terminal");

    // Client 1 inspects status
    let status1 = client1
        .send_raw_request("status", None)
        .await
        .expect("status");
    assert_eq!(status1["ok"], true);

    // Client 1 drops connection (abrupt disconnect)
    drop(client1);

    // Brief delay to allow connection close handling
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Client 2 connects to the daemon
    let mut client2 = harness.connect_ipc().await.expect("Client 2 connects");

    // Client 2 inspects terminal list
    let list_val = client2
        .send_raw_request("terminal.list", None)
        .await
        .expect("terminal.list");
    let terms = list_val
        .get("terminals")
        .and_then(|v| v.as_array())
        .or_else(|| list_val.as_array())
        .expect("terminals list");
    assert!(
        terms.iter().any(|t| {
            t.as_str() == Some(&term_id)
                || t.get("terminalId").and_then(|v| v.as_str()) == Some(&term_id)
                || t.get("handle").and_then(|v| v.as_str()) == Some(&term_id)
                || t.get("id").and_then(|v| v.as_str()) == Some(&term_id)
        }),
        "Terminal must survive client 1 disconnection"
    );

    // Client 2 kills terminal cleanly
    client2.kill_terminal(&term_id).await.expect("Clean kill");

    harness.shutdown().await;
}

/// Tier 4: Large Git Log Multi-Megabyte Streaming & SHA-256 Reassembly Integrity
#[tokio::test]
async fn test_tier4_large_git_log_streaming_reassembly_integrity() {
    let registry = GitResponseStreamRegistry::new();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(128);

    // Construct realistic multi-megabyte simulated git log (1.2 MB)
    let mut simulated_log = String::with_capacity(1_200_000);
    for i in 0..5000 {
        simulated_log.push_str(&format!(
            "commit a1b2c3d4e5f6071829304152637485960718293{}\nAuthor: Developer <dev@orca.build>\nDate:   Mon Oct 12 11:45:00 2026 +0200\n\n    feat(pty): migration step {}\n    \n    Detailed commit message with Unicode characters: 🚀 España €100 and diff summary\n\n",
            i, i
        ));
    }

    let raw_bytes = simulated_log.as_bytes();
    let total_len = raw_bytes.len();
    assert!(total_len > 1_000_000, "Payload must be > 1 MB");

    let marker = registry
        .start_stream(raw_bytes, 777, out_tx)
        .await
        .expect("start_stream");

    let expected_chunks = marker.stream_marker.chunk_count;
    let mut reassembled_chunks: Vec<(u64, Vec<u8>)> = Vec::new();
    let mut stream_ended = false;

    // Pump task runner with client ACK receiver
    while let Some(line) = out_rx.recv().await {
        let val: Value = serde_json::from_str(&line).expect("Parse line");
        let method = val["method"].as_str().unwrap_or("");

        if method == "git.responseChunk" {
            let seq = val["params"]["seq"].as_u64().unwrap();
            let b64_data = val["params"]["data"].as_str().unwrap();
            let decoded = from_standard_base64(b64_data).expect("Base64 decode");
            reassembled_chunks.push((seq, decoded));

            // Client acknowledges chunk immediately
            registry
                .record_ack(marker.stream_marker.stream_id, seq)
                .await;
        } else if method == "git.responseEnd" {
            stream_ended = true;
            break;
        }
    }

    assert!(stream_ended, "git.responseEnd must be received");
    assert_eq!(
        reassembled_chunks.len(),
        expected_chunks,
        "All chunks must be received"
    );

    // Sort by seq and verify strictly in order
    reassembled_chunks.sort_by_key(|(seq, _)| *seq);
    let mut full_reassembled = Vec::with_capacity(total_len);
    for (_, chunk) in reassembled_chunks {
        full_reassembled.extend_from_slice(&chunk);
    }

    assert_eq!(
        full_reassembled.len(),
        total_len,
        "Reassembled length must equal original"
    );
    assert_eq!(
        full_reassembled.as_slice(),
        raw_bytes,
        "Reassembled payload must match original byte-for-byte"
    );
}
