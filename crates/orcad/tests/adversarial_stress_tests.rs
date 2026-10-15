//! Adversarial Stress Testing Suite for Orca Daemon Migration (Domains 1-3)
//!
//! Empirical challenges designed by Challenger 1:
//! 1. WebSocket Transport: rapid connect/disconnect, malformed text/binary frames,
//!    auth brute-force, concurrent clients.
//! 2. PTY Flow Control: rapid pause/resume toggling, 5s failsafe timer accuracy under high output volume.
//! 3. Git Response Streaming: backpressure credit exhaustion, out-of-order ACKs, abort mid-flight, receiver drop.

use orcad::git_response_stream::*;

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use orca_protocol::rpc_envelope::RuntimeRpcRequest;
use orcad::agent_status_store::AgentStatusStore;
use orcad::diagnostics::DaemonMetrics;
use orcad::idle_exit::IdleExitManager;
use orcad::server::RpcDispatcher;
use orcad::terminal_manager::TerminalManager;
use orcad::worktree_manager::WorktreeManager;
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

pub struct StressTestServer {
    pub ws_url: String,
    pub shutdown_tx: broadcast::Sender<()>,
    pub dispatcher: Arc<RpcDispatcher>,
    pub terminal_manager: Arc<TerminalManager>,
    pub idle_exit: Arc<IdleExitManager>,
    pub auth_token: Option<String>,
    _temp_dir: tempfile::TempDir,
}

impl StressTestServer {
    pub async fn start(auth_token: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("Failed to bind ephemeral TCP port");
        let local_addr = listener.local_addr().expect("Failed to read local addr");
        let ws_url = format!("ws://{}", local_addr);

        let (shutdown_tx, shutdown_rx_ws) = broadcast::channel(2);
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
            "stress-test-runtime",
        ));

        let d_ws = Arc::clone(&dispatcher);
        let ie_ws = Arc::clone(&idle_exit);
        let token_ws = auth_token.clone();
        tokio::spawn(async move {
            let _ =
                orcad::websocket::listen_websocket(listener, shutdown_rx_ws, d_ws, ie_ws, token_ws)
                    .await;
        });

        tokio::time::sleep(Duration::from_millis(30)).await;

        Self {
            ws_url,
            shutdown_tx,
            dispatcher,
            terminal_manager,
            idle_exit,
            auth_token,
            _temp_dir: temp_dir,
        }
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

// ============================================================================
// GROUP 1: WebSocket Transport Adversarial Stress Tests
// ============================================================================

/// Stress Test 1: Rapid Connect and Disconnect
/// 50 consecutive and concurrent clients connect and immediately drop their connections.
#[tokio::test]
async fn test_ws_rapid_connect_disconnect_stress() {
    let server = StressTestServer::start(None).await;

    let mut handles = Vec::new();
    for i in 0..50 {
        let url = server.ws_url.clone();
        handles.push(tokio::spawn(async move {
            match tokio_tungstenite::connect_async(&url).await {
                Ok((mut ws, _)) => {
                    if i % 2 == 0 {
                        // Drop immediately
                        drop(ws);
                    } else {
                        // Send close frame then drop
                        let _ = ws.close(None).await;
                    }
                    true
                }
                Err(e) => {
                    tracing::error!("Connect failed: {:?}", e);
                    false
                }
            }
        }));
    }

    let results = futures::future::join_all(handles).await;
    let mut successes = 0;
    for res in results {
        if let Ok(true) = res {
            successes += 1;
        }
    }

    assert_eq!(
        successes, 50,
        "All 50 rapid connections must succeed and close cleanly"
    );

    // Server must still be responsive
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.ws_url)
        .await
        .expect("Server must remain healthy and responsive");
    ws.close(None).await.ok();
    server.shutdown().await;
}

/// Stress Test 2: Malformed Text and Binary Frames
/// Inject corrupt JSON, truncated binary framing, wrong magic/kind, and invalid opcodes.
#[tokio::test]
async fn test_ws_malformed_text_and_binary_frames() {
    let server = StressTestServer::start(None).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.ws_url)
        .await
        .expect("Connect WS");

    // 1. Send malformed text: non-JSON
    ws.send(Message::Text("NOT_JSON_AT_ALL".into()))
        .await
        .expect("Send text");
    let resp1 = ws
        .next()
        .await
        .expect("Must get response")
        .expect("Ok message");
    if let Message::Text(txt) = resp1 {
        let val: Value = serde_json::from_str(&txt).expect("Parse error JSON");
        assert_eq!(val["error"]["code"], "parse_error");
    } else {
        panic!("Expected text error response for malformed text");
    }

    // 2. Send truncated binary frames (< 16 bytes)
    for len in [0, 1, 4, 15] {
        let truncated = vec![0x74u8; len];
        ws.send(Message::Binary(truncated.into()))
            .await
            .expect("Send truncated binary");
    }

    // 3. Send binary frame with invalid KIND (0x99 instead of 0x74)
    let mut bad_kind = vec![0u8; 16];
    bad_kind[0] = 0x99;
    bad_kind[1] = 1; // version
    bad_kind[2] = 1; // opcode Output
    ws.send(Message::Binary(bad_kind.into()))
        .await
        .expect("Send bad kind binary");

    // 4. Send binary frame with invalid opcode (0xFF)
    let mut bad_opcode = vec![0u8; 16];
    bad_opcode[0] = 0x74;
    bad_opcode[1] = 1;
    bad_opcode[2] = 0xFF; // unknown opcode
    ws.send(Message::Binary(bad_opcode.into()))
        .await
        .expect("Send bad opcode binary");

    // 5. Verify server is still alive and processes valid JSON-RPC
    let valid_req = RuntimeRpcRequest {
        id: "ping-after-corrupt".to_string(),
        method: "ping".to_string(),
        auth_token: None,
        params: None,
    };
    ws.send(Message::Text(
        serde_json::to_string(&valid_req).unwrap().into(),
    ))
    .await
    .expect("Send valid ping");

    let resp = ws
        .next()
        .await
        .expect("Must get ping response")
        .expect("Ok message");
    if let Message::Text(txt) = resp {
        let val: Value = serde_json::from_str(&txt).expect("Parse ping response");
        assert_eq!(val["id"], "ping-after-corrupt");
    } else {
        panic!("Expected text response for valid ping");
    }

    server.shutdown().await;
}

/// Stress Test 3: Authentication Brute Force and Token Tampering
/// Send rapid requests with invalid/tampered auth tokens across query, headers, and in-band RPC.
#[tokio::test]
async fn test_ws_auth_brute_force_and_token_tampering() {
    let secret = "orca-secret-token-12345";
    let server = StressTestServer::start(Some(secret.to_string())).await;

    // A. Invalid handshake query
    for bad_token in ["wrong-token", "orca-secret", "token12345", ""] {
        let bad_url = format!("{}?token={}", server.ws_url, bad_token);
        let res = tokio_tungstenite::connect_async(&bad_url).await;
        assert!(
            res.is_err(),
            "Handshake with bad query token '{}' must fail with HTTP 403",
            bad_token
        );
    }

    // B. Invalid handshake header
    for bad_header in ["Bearer invalid", "Bearer orca-secret", ""] {
        let req = server.ws_url.clone().into_client_request().unwrap();
        let mut req = req;
        req.headers_mut()
            .insert("Authorization", HeaderValue::from_str(bad_header).unwrap());
        let res = tokio_tungstenite::connect_async(req).await;
        assert!(
            res.is_err(),
            "Handshake with bad header '{}' must fail with HTTP 403",
            bad_header
        );
    }

    // C. Connect without handshake auth, but send in-band RPC with wrong auth_token
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.ws_url)
        .await
        .expect("Connect without handshake token");

    for bad_token in ["wrong-in-band", "tampered", ""] {
        let req = RuntimeRpcRequest {
            id: format!("req-{}", bad_token),
            method: "ping".to_string(),
            auth_token: Some(bad_token.to_string()),
            params: None,
        };
        ws.send(Message::Text(serde_json::to_string(&req).unwrap().into()))
            .await
            .expect("Send in-band");

        let resp = ws
            .next()
            .await
            .expect("Must get response")
            .expect("Ok message");
        if let Message::Text(txt) = resp {
            let val: Value = serde_json::from_str(&txt).expect("Parse response");
            assert_eq!(val["error"]["code"], "unauthorized");
        } else {
            panic!("Expected text response");
        }
    }

    // D. Finally send correct in-band auth token -> must succeed
    let correct_req = RuntimeRpcRequest {
        id: "correct-auth-req".to_string(),
        method: "ping".to_string(),
        auth_token: Some(secret.to_string()),
        params: None,
    };
    ws.send(Message::Text(
        serde_json::to_string(&correct_req).unwrap().into(),
    ))
    .await
    .expect("Send correct in-band");

    let resp = ws
        .next()
        .await
        .expect("Must get response")
        .expect("Ok message");
    if let Message::Text(txt) = resp {
        let val: Value = serde_json::from_str(&txt).expect("Parse response");
        assert_eq!(val["id"], "correct-auth-req");
        assert_eq!(val["result"]["ok"], true);
    } else {
        panic!("Expected text response for valid auth");
    }

    server.shutdown().await;
}

/// Stress Test 4: Concurrent Clients Terminal Multiplexing
/// 10 concurrent clients sending commands and receiving outputs over WebSocket.
#[tokio::test]
async fn test_ws_concurrent_clients_terminal_multiplexing() {
    let server = StressTestServer::start(None).await;

    let mut client_handles = Vec::new();
    for c in 0..10 {
        let url = server.ws_url.clone();
        client_handles.push(tokio::spawn(async move {
            let (mut ws, _) = tokio_tungstenite::connect_async(&url)
                .await
                .expect("Connect client");

            // Dispatch 5 pings concurrently
            for req_idx in 0..5 {
                let req_id = format!("client-{}-req-{}", c, req_idx);
                let req = RuntimeRpcRequest {
                    id: req_id.clone(),
                    method: "ping".to_string(),
                    auth_token: None,
                    params: None,
                };
                ws.send(Message::Text(serde_json::to_string(&req).unwrap().into()))
                    .await
                    .expect("Send ping");

                let resp = ws.next().await.expect("Get ping resp").expect("Ok message");
                if let Message::Text(txt) = resp {
                    let val: Value = serde_json::from_str(&txt).unwrap();
                    assert_eq!(val["id"], req_id);
                } else {
                    panic!("Expected text message");
                }
            }
            ws.close(None).await.ok();
            true
        }));
    }

    let results = futures::future::join_all(client_handles).await;
    for res in results {
        assert!(
            res.expect("Client task"),
            "All client interactions must succeed without errors"
        );
    }

    server.shutdown().await;
}

// ============================================================================
// GROUP 2: PTY Flow Control Adversarial Stress Tests
// ============================================================================

/// Stress Test 5: Rapid Pause and Resume Toggling
/// Rapidly toggle pause_pty and resume_pty 50 times in rapid succession on an active session.
#[tokio::test]
async fn test_pty_flow_control_rapid_toggling() {
    let idle_exit = IdleExitManager::new(Duration::from_secs(60), broadcast::channel(1).0);
    let tm = TerminalManager::new(Arc::clone(&idle_exit));

    let (cmd, args) = if cfg!(windows) {
        (
            "cmd.exe",
            vec!["/c".to_string(), "ping 127.0.0.1 -n 10 >nul".to_string()],
        )
    } else {
        ("sh", vec!["-c".to_string(), "sleep 10".to_string()])
    };

    let (term_id, _pid) = tm
        .create_terminal(
            Some(cmd.to_string()),
            Some(args),
            Some(80),
            Some(24),
            None,
            None,
        )
        .await
        .expect("Create terminal");

    // Rapid toggle loop: 50 iterations
    for _ in 0..50 {
        tm.pause_pty(&term_id)
            .await
            .expect("pause_pty must succeed");
        assert!(tm.is_paused(&term_id).await.expect("is_paused"));

        tm.resume_pty(&term_id)
            .await
            .expect("resume_pty must succeed");
        assert!(!tm.is_paused(&term_id).await.expect("is_paused"));
    }

    // Terminal must still be active and accept input
    tm.write_input(&term_id, b"echo RAPID_TOGGLE_OK\r\n")
        .await
        .expect("write_input must succeed after rapid toggling");

    tm.kill_all().await;
}

/// Stress Test 6: 5-Second Failsafe Timer Accuracy under High Output Volume
/// Spawn a live PTY generating a continuous stream of output.
/// Pause the session and verify that output stops, then wait for the 5-second failsafe
/// timer to trigger and resume output automatically.
#[tokio::test]
async fn test_pty_failsafe_5s_timer_under_high_output_volume() {
    let idle_exit = IdleExitManager::new(Duration::from_secs(60), broadcast::channel(1).0);
    let tm = TerminalManager::new(Arc::clone(&idle_exit));

    let (cmd, args): (&str, Vec<String>) = if cfg!(windows) {
        ("cmd.exe", vec![])
    } else {
        ("sh", vec![])
    };

    let (term_id, _pid) = tm
        .create_terminal(
            Some(cmd.to_string()),
            Some(args),
            Some(80),
            Some(24),
            None,
            None,
        )
        .await
        .expect("Create terminal");

    let mut stream_rx = tm.subscribe_raw(&term_id).await.expect("Subscribe raw");

    // Write command that outputs continuously
    let loop_cmd = if cfg!(windows) {
        "FOR /L %i IN (1,1,200) DO @echo HIGH_VOLUME_%i & ping -n 1 127.0.0.1 >nul\r\n"
    } else {
        "for i in $(seq 1 200); do echo HIGH_VOLUME_$i; sleep 0.05; done\n"
    };

    tm.write_input(&term_id, loop_cmd.as_bytes())
        .await
        .expect("Write loop command");

    // Read initial output
    let mut initial_received = false;
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(bytes) = tokio::time::timeout(Duration::from_millis(500), stream_rx.recv()).await
        {
            if let Ok(b) = bytes {
                let s = String::from_utf8_lossy(&b);
                if s.contains("HIGH_VOLUME") {
                    initial_received = true;
                    break;
                }
            }
        }
    }
    assert!(
        initial_received,
        "Must receive initial stream output before pause"
    );

    // Pause the session
    let start_pause = Instant::now();
    tm.pause_pty(&term_id).await.expect("Pause PTY");
    assert!(tm.is_paused(&term_id).await.expect("is_paused"));

    // Verify output halts while paused (drain any already buffered items first)
    tokio::time::sleep(Duration::from_millis(200)).await;
    while let Ok(_) = stream_rx.try_recv() {}

    // Now while paused, no new output should arrive for the next 1 second
    let paused_burst = tokio::time::timeout(Duration::from_millis(1000), stream_rx.recv()).await;
    assert!(
        paused_burst.is_err(),
        "While paused, no new output must be delivered"
    );

    // Wait for failsafe timer (5 seconds). We do NOT call resume_pty!
    // The failsafe timer should fire around 5.0 seconds from start_pause.
    let remaining_to_failsafe = Duration::from_millis(5100).saturating_sub(start_pause.elapsed());
    tokio::time::sleep(remaining_to_failsafe).await;

    // Check if session has unpaused automatically via failsafe timer
    let is_paused_after = tm.is_paused(&term_id).await.expect("is_paused");
    assert!(
        !is_paused_after,
        "5-second failsafe timer must automatically unpause the session"
    );

    // Output should resume flow
    let resume_burst = tokio::time::timeout(Duration::from_secs(3), stream_rx.recv()).await;
    assert!(
        resume_burst.is_ok(),
        "Output delivery must resume after failsafe timer triggers"
    );

    tm.kill_all().await;
}

// ============================================================================
// GROUP 3: Git Response Streaming Adversarial Stress Tests
// ============================================================================

/// Stress Test 7: Backpressure Credit Exhaustion on Large Payload
/// Stream 16 chunks (2MB) with sliding window 4.
/// Verify pump parks at chunk 4, verifies stall_recheck timeout, and slides credit window.
#[tokio::test]
async fn test_git_streaming_credit_exhaustion_large_payload() {
    let registry = GitResponseStreamRegistry::with_config(200, 4);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(64);

    // 16 chunks of 128KB = 2048 KB (2 MB)
    let payload = vec![b'P'; 16 * 128 * 1024];
    let marker = registry
        .start_stream(&payload, 999, out_tx)
        .await
        .expect("start_stream");
    let stream_id = marker.stream_marker.stream_id;
    assert_eq!(marker.stream_marker.chunk_count, 16);

    // Read first 4 chunks (0, 1, 2, 3)
    for expected in 0..4 {
        let msg = out_rx.recv().await.expect("Chunk recv");
        let val: Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(val["params"]["seq"], expected);
    }

    // Pump must now be stalled on credit exhaustion (window = 4)
    let stalled = tokio::time::timeout(Duration::from_millis(150), out_rx.recv()).await;
    assert!(
        stalled.is_err(),
        "Pump must stall after 4 unacknowledged chunks"
    );

    // Send ACK for seq 0 -> window slides, chunk 4 arrives
    registry.record_ack(stream_id, 0).await;
    let msg4 = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("recv timeout")
        .expect("channel open");
    let val4: Value = serde_json::from_str(&msg4).unwrap();
    assert_eq!(val4["params"]["seq"], 4);

    // Cumulative ACK for seq 10 -> window slides to cover through chunk 14
    registry.record_ack(stream_id, 10).await;
    for expected in 5..=14 {
        let msg = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
            .await
            .expect("recv timeout")
            .expect("channel open");
        let val: Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(val["params"]["seq"], expected);
    }

    // At seq 14, unacked is (14 - 10) = 4, so pump stalls before seq 15
    let stalled2 = tokio::time::timeout(Duration::from_millis(150), out_rx.recv()).await;
    assert!(
        stalled2.is_err(),
        "Pump must stall before chunk 15 until seq 11+ is acknowledged"
    );

    // Acknowledge seq 14 -> chunk 15 and responseEnd arrive
    registry.record_ack(stream_id, 14).await;
    let msg15 = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("recv timeout")
        .expect("channel open");
    let val15: Value = serde_json::from_str(&msg15).unwrap();
    assert_eq!(val15["params"]["seq"], 15);

    let end_msg = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("recv timeout")
        .expect("channel open");
    let end_val: Value = serde_json::from_str(&end_msg).unwrap();
    assert_eq!(end_val["method"], "git.responseEnd");
    assert_eq!(end_val["params"]["streamId"], stream_id);
}

/// Stress Test 8: Out-of-Order, Duplicate, and Retrograde ACKs
/// Client sends ACK seq 3, then ACK seq 1, then duplicate ACK seq 3, then ACK seq 2.
/// Monotonicity must be maintained and stream must continue properly.
#[tokio::test]
async fn test_git_streaming_out_of_order_and_retrograde_acks() {
    let registry = GitResponseStreamRegistry::with_config(200, 4);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(64);

    let payload = vec![b'A'; 8 * 128 * 1024];
    let marker = registry
        .start_stream(&payload, 888, out_tx)
        .await
        .expect("start_stream");
    let stream_id = marker.stream_marker.stream_id;

    // Drain initial 4 chunks (0, 1, 2, 3)
    for _ in 0..4 {
        out_rx.recv().await.expect("Initial chunk");
    }

    // 1. Send ACK for seq 3
    assert!(registry.record_ack(stream_id, 3).await);
    assert_eq!(registry.acked_through_seq(stream_id).await, Some(3));

    // 2. Send retrograde ACK for seq 1 (must NOT regress acked_through_seq)
    assert!(registry.record_ack(stream_id, 1).await);
    assert_eq!(
        registry.acked_through_seq(stream_id).await,
        Some(3),
        "acked_through_seq must not regress on older ACK"
    );

    // 3. Send duplicate ACK for seq 3
    assert!(registry.record_ack(stream_id, 3).await);
    assert_eq!(
        registry.acked_through_seq(stream_id).await,
        Some(3),
        "Duplicate ACK must be a no-op"
    );

    // 4. Send retrograde ACK for seq 2
    assert!(registry.record_ack(stream_id, 2).await);
    assert_eq!(registry.acked_through_seq(stream_id).await, Some(3));

    // With ACK at 3, window slides by 4: chunks 4, 5, 6, 7 arrive
    for expected in 4..=7 {
        let msg = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
            .await
            .expect("recv timeout")
            .expect("channel open");
        let val: Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(val["params"]["seq"], expected);
    }

    let end_msg = tokio::time::timeout(Duration::from_millis(500), out_rx.recv())
        .await
        .expect("end timeout")
        .expect("channel open");
    let end_val: Value = serde_json::from_str(&end_msg).unwrap();
    assert_eq!(end_val["method"], "git.responseEnd");
}

/// Stress Test 9: Abort Mid-Flight while Parked on Backpressure
/// Stream parks on credit window. Client issues abort(). Pump must terminate immediately.
#[tokio::test]
async fn test_git_streaming_abort_while_parked_on_backpressure() {
    let registry = GitResponseStreamRegistry::with_config(500, 4);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(64);

    let payload = vec![b'X'; 10 * 128 * 1024];
    let marker = registry
        .start_stream(&payload, 777, out_tx)
        .await
        .expect("start_stream");
    let stream_id = marker.stream_marker.stream_id;

    // Receive first 4 chunks
    for _ in 0..4 {
        out_rx.recv().await.expect("Chunk recv");
    }

    // Verify pump is parked
    let stalled = tokio::time::timeout(Duration::from_millis(150), out_rx.recv()).await;
    assert!(stalled.is_err(), "Pump must be parked on window");

    // Client aborts the stream
    assert!(
        registry.abort(stream_id).await,
        "abort() must return true for active stream"
    );

    // Pump must terminate without sending any further chunks or responseEnd
    let aborted_recv = tokio::time::timeout(Duration::from_millis(300), out_rx.recv()).await;
    assert!(
        aborted_recv.is_err() || aborted_recv.unwrap().is_none(),
        "No further messages must be emitted after abort"
    );

    // Stream must be unmapped from registry
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !registry.has_stream(stream_id).await,
        "Aborted stream must be removed from registry"
    );
}

/// Stress Test 10: Receiver Drop Disconnect Cleanup
/// Dropping out_tx receiver causes pump to detect channel disconnection, unpark and exit.
#[tokio::test]
async fn test_git_streaming_channel_drop_disconnect_cleanup() {
    let registry = GitResponseStreamRegistry::with_config(200, 4);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel(64);

    let payload = vec![b'Y'; 8 * 128 * 1024];
    let marker = registry
        .start_stream(&payload, 666, out_tx)
        .await
        .expect("start_stream");
    let stream_id = marker.stream_marker.stream_id;

    // Read 2 chunks
    let _ = out_rx.recv().await;
    let _ = out_rx.recv().await;

    // Drop receiver abruptly simulating client disconnect
    drop(out_rx);

    // Send wake to registry (simulating disconnect trigger)
    registry.wake_all().await;

    // Give pump 5 stall_recheck cycles (1000ms) to detect broken channel
    tokio::time::sleep(Duration::from_millis(1000)).await;

    // Pump must have terminated and deregistered stream
    assert!(
        !registry.has_stream(stream_id).await,
        "Stream must be unmapped when channel drops"
    );
}

/// Stress Test 11: Verify Required RPC Dispatch Routing
/// Original Request R2 & R3 specify RPCs: `pausePty`, `resumePty`, `setSessionBackground`, `signal`,
/// `getSnapshot`, `takePendingOutput`, and `git.responseAck`.
#[tokio::test]
async fn test_required_rpc_dispatch_routing() {
    let server = StressTestServer::start(None).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.ws_url)
        .await
        .expect("Connect WS");

    // Create a terminal first
    let create_req = RuntimeRpcRequest {
        id: "create-t".to_string(),
        method: "terminal.create".to_string(),
        auth_token: None,
        params: Some(serde_json::json!({
            "command": if cfg!(windows) { "cmd.exe" } else { "sh" }
        })),
    };
    ws.send(Message::Text(
        serde_json::to_string(&create_req).unwrap().into(),
    ))
    .await
    .unwrap();

    let mut term_id = String::new();
    while let Some(Ok(msg)) = ws.next().await {
        if let Message::Text(txt) = msg {
            let val: Value = serde_json::from_str(&txt).unwrap();
            if val["id"] == "create-t" {
                term_id = val["result"]["handle"].as_str().unwrap().to_string();
                break;
            }
        }
    }
    assert!(
        !term_id.is_empty(),
        "Terminal creation response must be received"
    );

    // Helper closure to send RPC and wait for response
    async fn call_rpc(
        ws: &mut WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        id: &str,
        method: &str,
        params: Value,
    ) -> Value {
        let req = RuntimeRpcRequest {
            id: id.to_string(),
            method: method.to_string(),
            auth_token: None,
            params: Some(params),
        };
        ws.send(Message::Text(serde_json::to_string(&req).unwrap().into()))
            .await
            .expect("Send RPC request");

        while let Some(Ok(msg)) = ws.next().await {
            if let Message::Text(txt) = msg {
                let val: Value = serde_json::from_str(&txt).expect("Parse RPC JSON");
                if val["id"] == id {
                    return val;
                }
            }
        }
        panic!("Did not receive response for RPC id: {}", id);
    }

    // 1. terminal.pausePty
    let val = call_rpc(
        &mut ws,
        "t-pause",
        "terminal.pausePty",
        serde_json::json!({ "terminalId": &term_id }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.pausePty must be routed"
    );
    assert_eq!(val["result"]["ok"], true);
    assert_eq!(val["result"]["paused"], true);

    // 2. terminal.resumePty
    let val = call_rpc(
        &mut ws,
        "t-resume",
        "terminal.resumePty",
        serde_json::json!({ "terminalId": &term_id }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.resumePty must be routed"
    );
    assert_eq!(val["result"]["ok"], true);
    assert_eq!(val["result"]["paused"], false);

    // 3. terminal.setSessionBackground
    let val = call_rpc(
        &mut ws,
        "t-bg",
        "terminal.setSessionBackground",
        serde_json::json!({ "terminalId": &term_id, "background": true }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.setSessionBackground must be routed"
    );
    assert_eq!(val["result"]["ok"], true);

    // 4. terminal.signal
    let val = call_rpc(
        &mut ws,
        "t-sig",
        "terminal.signal",
        serde_json::json!({ "terminalId": &term_id, "signal": "SIGINT" }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.signal must be routed"
    );
    assert_eq!(val["result"]["ok"], true);

    // 5. terminal.getSnapshot
    let val = call_rpc(
        &mut ws,
        "t-snap",
        "terminal.getSnapshot",
        serde_json::json!({ "terminalId": &term_id }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.getSnapshot must be routed"
    );
    assert!(val["result"]["snapshotAnsi"].is_string());

    // 6. terminal.takePendingOutput
    let val = call_rpc(
        &mut ws,
        "t-pending",
        "terminal.takePendingOutput",
        serde_json::json!({ "terminalId": &term_id, "includeSnapshot": false }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.takePendingOutput must be routed"
    );
    assert!(val["result"]["records"].is_array());

    // 7. terminal.getCwd
    let val = call_rpc(
        &mut ws,
        "t-cwd",
        "terminal.getCwd",
        serde_json::json!({ "terminalId": &term_id }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.getCwd must be routed"
    );
    assert_eq!(val["result"]["ok"], true);

    // 8. terminal.getTitle
    let val = call_rpc(
        &mut ws,
        "t-title",
        "terminal.getTitle",
        serde_json::json!({ "terminalId": &term_id }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC terminal.getTitle must be routed"
    );
    assert_eq!(val["result"]["ok"], true);

    // 9. git.responseAck
    let val = call_rpc(
        &mut ws,
        "git-ack",
        "git.responseAck",
        serde_json::json!({ "streamId": 42, "seq": 1 }),
    )
    .await;
    assert_ne!(
        val["error"]["code"], "method_not_found",
        "RPC git.responseAck must be routed"
    );
    assert_eq!(val["result"]["ok"], true);
    assert_eq!(val["result"]["streamId"], 42);

    server.shutdown().await;
}
