use orcad::agent_status_store::{AgentStatusStore, AgentVerdict};
use orcad::hook_server::HookServer;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

async fn send_http_request(
    port: u16,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> (u16, String) {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port))
        .await
        .expect("Must connect to hook server");

    let mut req = format!("POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\nContent-Type: application/json\r\n", path, body.len());
    if let Some(t) = token {
        req.push_str(&format!("x-orca-agent-hook-token: {}\r\n", t));
    }
    req.push_str("\r\n");
    req.push_str(body);

    stream
        .write_all(req.as_bytes())
        .await
        .expect("Write request");

    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.expect("Read response");
    let response = String::from_utf8_lossy(&buf[..n]).to_string();

    let status_code = response
        .lines()
        .next()
        .and_then(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 2 {
                parts[1].parse::<u16>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);

    (status_code, response)
}

#[tokio::test]
async fn test_hook_server_token_auth_and_status_ingest() {
    let temp_dir = tempfile::tempdir().unwrap();
    let status_path = temp_dir.path().join("last-status.json");
    let endpoint_path = temp_dir.path().join("endpoint.json");
    let store = Arc::new(AgentStatusStore::new(&status_path));
    let token = "test-auth-token-12345";

    let (hook_server, bound_port) = HookServer::bind(
        Arc::clone(&store),
        token.to_string(),
        0, // ephemeral port
        Some(endpoint_path.clone()),
    )
    .await
    .expect("Hook server must bind");

    tokio::spawn(hook_server.run());

    // Verify endpoint.json created with port and token
    assert!(endpoint_path.exists(), "endpoint.json must be written");
    let endpoint_content = std::fs::read_to_string(&endpoint_path).unwrap();
    assert!(endpoint_content.contains(&bound_port.to_string()));
    assert!(endpoint_content.contains(token));

    // 1. Unauthenticated request must return 403
    let (code_unauth, _) = send_http_request(
        bound_port,
        "/hooks/claude",
        None,
        r#"{"session_id":"s-1","status":"working"}"#,
    )
    .await;
    assert_eq!(code_unauth, 403);

    // 2. Request with invalid token must return 403
    let (code_bad_token, _) = send_http_request(
        bound_port,
        "/hooks/claude",
        Some("wrong-token"),
        r#"{"session_id":"s-1","status":"working"}"#,
    )
    .await;
    assert_eq!(code_bad_token, 403);

    // 3. Authenticated request must return 200/204 and update store
    let (code_auth, _) = send_http_request(
        bound_port,
        "/hooks/claude",
        Some(token),
        r#"{"session_id":"s-1","status":"working","text":"Researching"}"#,
    )
    .await;
    assert!(code_auth == 200 || code_auth == 204);

    let status = store
        .get_status("s-1")
        .await
        .expect("Status must exist in store");
    assert_eq!(status.verdict, AgentVerdict::Live);
    assert_eq!(status.description, "Researching");

    // 4. OpenCode startup prompt claim path returns 200 with JSON
    let (code_claim, resp_claim) = send_http_request(
        bound_port,
        "/opencode/startup-prompt-claim",
        Some(token),
        r#"{"session_id":"s-2"}"#,
    )
    .await;
    assert_eq!(code_claim, 200);
    assert!(resp_claim.contains("\"allowed\":true"));
}
