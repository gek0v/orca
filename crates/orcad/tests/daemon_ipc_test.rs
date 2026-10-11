use orcad::agent_status_store::AgentVerdict;
use orcad::server::{Server, ServerConfig};
use orcad::test_client;
use std::time::Duration;
use tokio::time::sleep;

fn make_test_endpoint(test_name: &str) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\orcad-test-{}-{}", test_name, std::process::id())
    } else {
        format!("/tmp/orcad-test-{}-{}.sock", test_name, std::process::id())
    }
}

#[tokio::test]
async fn test_daemon_client_connect_and_ping() {
    let endpoint = make_test_endpoint("ping");
    let daemon = Server::start(&endpoint)
        .await
        .expect("Daemon must start successfully");

    let mut client = test_client::connect(&endpoint)
        .await
        .expect("Client must connect to daemon");

    let resp = client.send_ping().await.expect("Ping must succeed");
    assert!(resp._keepalive, "Keepalive flag must be true");

    daemon
        .shutdown()
        .await
        .expect("Daemon must shut down cleanly");
}

#[tokio::test]
async fn test_daemon_terminal_lifecycle_over_ipc() {
    let endpoint = make_test_endpoint("term");
    let daemon = Server::start(&endpoint)
        .await
        .expect("Daemon must start successfully");

    let mut client = test_client::connect(&endpoint)
        .await
        .expect("Client must connect to daemon");

    let (cmd, args) = if cfg!(windows) {
        (
            "cmd.exe",
            vec!["/c".to_string(), "echo ORCA_IPC_TERM_OK".to_string()],
        )
    } else {
        (
            "sh",
            vec!["-c".to_string(), "echo ORCA_IPC_TERM_OK".to_string()],
        )
    };

    // 1. Create terminal
    let term_id = client
        .create_terminal(Some(cmd), Some(args))
        .await
        .expect("Terminal create must succeed");
    assert!(!term_id.is_empty(), "Terminal ID must not be empty");

    // 2. Resize terminal
    client
        .resize_terminal(&term_id, 120, 35)
        .await
        .expect("Terminal resize must succeed");

    // 3. Write terminal input
    client
        .write_terminal_input(&term_id, "echo hello\r\n")
        .await
        .expect("Terminal input must succeed");

    // 4. Kill terminal
    client
        .kill_terminal(&term_id)
        .await
        .expect("Terminal kill must succeed");

    daemon
        .shutdown()
        .await
        .expect("Daemon must shut down cleanly");
}

#[tokio::test]
async fn test_daemon_status_store_over_ipc() {
    let endpoint = make_test_endpoint("status");
    let daemon = Server::start(&endpoint)
        .await
        .expect("Daemon must start successfully");

    let mut client = test_client::connect(&endpoint)
        .await
        .expect("Client must connect to daemon");

    // Initially none
    let initial = client
        .get_status("session-remote-1")
        .await
        .expect("Get status should succeed");
    assert!(initial.is_none());

    // Update to Live
    client
        .update_status("session-remote-1", AgentVerdict::Live, "Executing task")
        .await
        .expect("Update status must succeed");

    let row = client
        .get_status("session-remote-1")
        .await
        .expect("Get status should succeed")
        .expect("Row must exist");
    assert_eq!(row.session_id, "session-remote-1");
    assert_eq!(row.verdict, AgentVerdict::Live);
    assert_eq!(row.description, "Executing task");

    // List all
    let rows = client
        .list_status()
        .await
        .expect("List status must succeed");
    assert!(rows.iter().any(|r| r.session_id == "session-remote-1"));

    // Transition to Unverifiable (e.g. connection lost)
    client
        .update_status(
            "session-remote-1",
            AgentVerdict::Unverifiable,
            "Host disconnected",
        )
        .await
        .expect("Update to unverifiable must succeed");

    let row = client
        .get_status("session-remote-1")
        .await
        .expect("Get status should succeed")
        .expect("Row must exist");
    assert_eq!(row.verdict, AgentVerdict::Unverifiable);

    // Transition to Exited
    client
        .update_status("session-remote-1", AgentVerdict::Exited, "Process reaped")
        .await
        .expect("Update to exited must succeed");

    let row = client
        .get_status("session-remote-1")
        .await
        .expect("Get status should succeed")
        .expect("Row must exist");
    assert_eq!(row.verdict, AgentVerdict::Exited);

    daemon
        .shutdown()
        .await
        .expect("Daemon must shut down cleanly");
}

#[tokio::test]
async fn test_daemon_idle_exit_triggers_cleanly() {
    let endpoint = make_test_endpoint("idle");
    let temp_dir = tempfile::tempdir().unwrap();
    let status_path = temp_dir.path().join("last-status.json");

    // Configure a 100ms idle timeout
    let config = ServerConfig {
        endpoint: endpoint.clone(),
        idle_timeout: Duration::from_millis(100),
        status_path,
        runtime_id: "test-runtime".into(),
    };

    let daemon = Server::start_with_config(config)
        .await
        .expect("Daemon must start");

    // Connect briefly and disconnect
    {
        let mut client = test_client::connect(&endpoint)
            .await
            .expect("Client must connect");
        let resp = client.send_ping().await.expect("Ping must succeed");
        assert!(resp._keepalive);
        // client dropped here, connection closes
    }

    // Wait for idle exit deadline (100ms timeout + buffer)
    sleep(Duration::from_millis(250)).await;

    // Verify daemon shut down or active count is 0
    assert_eq!(daemon.idle_exit().active_connections(), 0);
    assert_eq!(daemon.idle_exit().active_terminals(), 0);

    daemon.shutdown().await.ok();
}

#[tokio::test]
async fn test_daemon_terminal_event_streaming_over_ipc() {
    let endpoint = make_test_endpoint("events");
    let daemon = Server::start(&endpoint)
        .await
        .expect("Daemon must start successfully");

    let mut client = test_client::connect(&endpoint)
        .await
        .expect("Client must connect to daemon");

    let (cmd, args) = if cfg!(windows) {
        (
            "cmd.exe",
            vec!["/c".to_string(), "echo ORCA_STREAM_EV_OK".to_string()],
        )
    } else {
        (
            "sh",
            vec!["-c".to_string(), "echo ORCA_STREAM_EV_OK".to_string()],
        )
    };

    let _term_id = client
        .create_terminal(Some(cmd), Some(args))
        .await
        .expect("Terminal create must succeed");

    let mut received_output = false;
    let mut received_exit = false;

    // Read events until output and exit are observed
    for _ in 0..20 {
        if let Some(val) = client.read_next_event(Duration::from_millis(300)).await {
            if val.get("event").and_then(|e| e.as_str()) == Some("data") {
                if let Some(data) = val.get("data").and_then(|d| d.as_str()) {
                    if data.contains("ORCA_STREAM_EV_OK") {
                        received_output = true;
                    }
                }
            } else if val.get("event").and_then(|e| e.as_str()) == Some("exit") {
                received_exit = true;
            }
        }
        if received_output && received_exit {
            break;
        }
    }

    assert!(received_output, "Must have received terminal data event");
    assert!(received_exit, "Must have received terminal exit event");

    daemon
        .shutdown()
        .await
        .expect("Daemon must shut down cleanly");
}
