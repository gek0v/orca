use std::sync::Arc;
use std::time::Duration;

use orca_protocol::rpc_envelope::{RuntimeRpcEnvelope, RuntimeRpcRequest};
use orcad::agent_status_store::AgentStatusStore;
use orcad::diagnostics::DaemonMetrics;
use orcad::idle_exit::IdleExitManager;
use orcad::server::RpcDispatcher;
use orcad::terminal_manager::TerminalManager;
use orcad::worktree_manager::WorktreeManager;
use serde_json::json;
use tokio::sync::broadcast;

fn make_req(id: &str, method: &str, params: Option<serde_json::Value>) -> RuntimeRpcRequest {
    RuntimeRpcRequest {
        id: id.to_string(),
        method: method.to_string(),
        auth_token: None,
        params,
    }
}

fn unwrap_success(envelope: RuntimeRpcEnvelope<serde_json::Value>) -> serde_json::Value {
    match envelope {
        RuntimeRpcEnvelope::Success(s) => s.result,
        RuntimeRpcEnvelope::Failure(f) => {
            panic!(
                "Expected RPC success, got failure: [{}] {}",
                f.error.code, f.error.message
            );
        }
        RuntimeRpcEnvelope::Keepalive(_) => panic!("Expected RPC success, got keepalive"),
    }
}

async fn setup_test_dispatcher() -> (Arc<RpcDispatcher>, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().expect("Failed to create tempdir");
    let (shutdown_tx, _) = broadcast::channel(1);
    let idle_exit = IdleExitManager::new(Duration::from_secs(60), shutdown_tx);
    let terminal_manager = TerminalManager::new(Arc::clone(&idle_exit));
    let status_store = Arc::new(AgentStatusStore::new(&temp_dir.path().join("status.json")));
    let worktree_manager = Arc::new(WorktreeManager::new(Arc::clone(&status_store)));
    let metrics = Arc::new(DaemonMetrics::new());

    let dispatcher = Arc::new(RpcDispatcher::new(
        status_store,
        terminal_manager,
        worktree_manager,
        idle_exit,
        metrics,
        "test-runtime-relay",
    ));

    (dispatcher, temp_dir)
}

#[tokio::test]
async fn test_fs_handler_crud_and_range_rpc() {
    let (dispatcher, temp_dir) = setup_test_dispatcher().await;
    let base_dir = temp_dir.path().join("test_fs");
    let file_path = base_dir.join("sample.txt");
    let file_path_str = file_path.to_string_lossy().to_string();

    // 1. fs.mkdir
    let req = make_req(
        "req-1",
        "fs.mkdir",
        Some(json!({
            "path": base_dir.to_string_lossy().to_string(),
            "recursive": true
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("created").and_then(|v| v.as_bool()), Some(true));

    // 2. fs.write
    let content = "Hello Orca Relay Remote Filesystem!";
    let req = make_req(
        "req-2",
        "fs.write",
        Some(json!({
            "path": file_path_str,
            "content": content
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(
        val.get("bytesWritten").and_then(|v| v.as_u64()),
        Some(content.len() as u64)
    );

    // 3. fs.read
    let req = make_req(
        "req-3",
        "fs.read",
        Some(json!({
            "path": file_path_str
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("content").and_then(|v| v.as_str()), Some(content));

    // 4. fs.readRange
    let req = make_req(
        "req-4",
        "fs.readRange",
        Some(json!({
            "path": file_path_str,
            "start": 6,
            "end": 10
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("content").and_then(|v| v.as_str()), Some("Orca"));

    // 5. fs.stat & fs.lstat
    let req = make_req("req-5", "fs.stat", Some(json!({ "path": file_path_str })));
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let stat = val.get("stat").cloned().unwrap();
    assert_eq!(stat.get("isFile").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(
        stat.get("size").and_then(|v| v.as_u64()),
        Some(content.len() as u64)
    );

    // 6. fs.copy & fs.readDir
    let copy_path = base_dir.join("sample_copy.txt");
    let copy_path_str = copy_path.to_string_lossy().to_string();
    let req = make_req(
        "req-6",
        "fs.copy",
        Some(json!({
            "from": file_path_str,
            "to": copy_path_str
        })),
    );
    unwrap_success(dispatcher.dispatch(req).await);

    let req = make_req(
        "req-7",
        "fs.readDir",
        Some(json!({ "path": base_dir.to_string_lossy().to_string() })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let entries = val
        .get("entries")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap();
    assert_eq!(entries.len(), 2);

    // 7. fs.delete
    let req = make_req(
        "req-8",
        "fs.delete",
        Some(json!({
            "path": copy_path_str
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("deleted").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn test_watch_registry_rpc() {
    let (dispatcher, temp_dir) = setup_test_dispatcher().await;
    let watch_path = temp_dir.path().to_string_lossy().to_string();

    // 1. fs.watch
    let req = make_req(
        "watch-1",
        "fs.watch",
        Some(json!({
            "clientId": "client-test",
            "path": watch_path,
            "recursive": true
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let watch_id = val.get("watchId").and_then(|v| v.as_u64()).unwrap();

    // 2. fs.watches
    let req = make_req(
        "watch-2",
        "fs.watches",
        Some(json!({ "clientId": "client-test" })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let list = val
        .get("watches")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap();
    assert!(list.contains(&json!(watch_id)));

    // 3. fs.unwatch
    let req = make_req(
        "watch-3",
        "fs.unwatch",
        Some(json!({
            "clientId": "client-test",
            "watchId": watch_id
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("unwatched").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn test_port_scanner_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;
    let req = make_req("ports-1", "ports.scan", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert!(val.get("ports").is_some());
}

#[tokio::test]
async fn test_skill_installer_rpc() {
    let (dispatcher, temp_dir) = setup_test_dispatcher().await;
    let source_skill_dir = temp_dir.path().join("source_skill");
    let target_skills_dir = temp_dir.path().join("installed_skills");
    tokio::fs::create_dir_all(&source_skill_dir).await.unwrap();

    tokio::fs::write(
        source_skill_dir.join("SKILL.md"),
        "# Test Skill\nDescription of test skill for Orca Relay.",
    )
    .await
    .unwrap();

    // 1. skills.preview
    let req = make_req(
        "skill-1",
        "skills.preview",
        Some(json!({ "sourceDir": source_skill_dir.to_string_lossy().to_string() })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let preview = val.get("preview").cloned().unwrap();
    assert_eq!(preview.get("fileCount").and_then(|v| v.as_u64()), Some(1));

    // 2. skills.install
    let req = make_req(
        "skill-2",
        "skills.install",
        Some(json!({
            "sourceDir": source_skill_dir.to_string_lossy().to_string(),
            "targetDir": target_skills_dir.to_string_lossy().to_string()
        })),
    );
    unwrap_success(dispatcher.dispatch(req).await);

    // 3. skills.list
    let req = make_req(
        "skill-3",
        "skills.list",
        Some(json!({ "skillsDir": target_skills_dir.to_string_lossy().to_string() })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let list = val
        .get("skills")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap();
    assert_eq!(list.len(), 1);

    // 4. skills.remove
    let req = make_req(
        "skill-4",
        "skills.remove",
        Some(json!({
            "skillsDir": target_skills_dir.to_string_lossy().to_string(),
            "name": "source_skill"
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("removed").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn test_session_search_rpc() {
    let (dispatcher, temp_dir) = setup_test_dispatcher().await;
    let vault_dir = temp_dir.path().join("ai_vault");
    tokio::fs::create_dir_all(&vault_dir).await.unwrap();

    let session_file = vault_dir.join("chat-001.md");
    tokio::fs::write(
        &session_file,
        "# Conversation with AI\nUser: How do I implement relay supervision?\nAssistant: Use systemd scopes and cgroups.",
    )
    .await
    .unwrap();

    let req = make_req(
        "search-1",
        "aiVault.search",
        Some(json!({
            "query": "supervision",
            "scopeDirs": [vault_dir.to_string_lossy().to_string()]
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let results = val
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap();
    assert!(!results.is_empty());
    assert!(results[0]
        .get("matchedLine")
        .and_then(|v| v.as_str())
        .unwrap()
        .contains("supervision"));
}

#[tokio::test]
async fn test_external_automations_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;

    // 1. externalAutomations.create
    let (cmd, args) = if cfg!(windows) {
        (
            "cmd",
            vec!["/c".to_string(), "echo Hello Automation".to_string()],
        )
    } else {
        (
            "sh",
            vec!["-c".to_string(), "echo Hello Automation".to_string()],
        )
    };

    let req = make_req(
        "auto-1",
        "externalAutomations.create",
        Some(json!({
            "name": "echo-job",
            "command": cmd,
            "args": args
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let job_id = val
        .get("jobId")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();

    // 2. externalAutomations.list
    let req = make_req("auto-2", "externalAutomations.list", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let jobs = val.get("jobs").and_then(|v| v.as_array()).cloned().unwrap();
    assert!(jobs
        .iter()
        .any(|j| j.get("id").and_then(|v| v.as_str()) == Some(&job_id)));

    // 3. externalAutomations.run
    let req = make_req(
        "auto-3",
        "externalAutomations.run",
        Some(json!({ "jobId": job_id })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let run = val.get("run").cloned().unwrap();
    assert_eq!(run.get("success").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(run.get("exitCode").and_then(|v| v.as_i64()), Some(0));

    // 4. externalAutomations.runs
    let req = make_req(
        "auto-4",
        "externalAutomations.runs",
        Some(json!({ "jobId": job_id })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let runs = val.get("runs").and_then(|v| v.as_array()).cloned().unwrap();
    assert_eq!(runs.len(), 1);
}

#[tokio::test]
async fn test_systemd_scope_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;
    let req = make_req(
        "scope-1",
        "system.cgroupScope",
        Some(json!({
            "nonce": "test-session-42",
            "cgroupContent": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/orca-daemon-test-session-42.scope"
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(
        val.get("unitName").and_then(|v| v.as_str()),
        Some("orca-daemon-test-session-42.scope")
    );
    assert_eq!(
        val.get("currentScope").and_then(|v| v.as_str()),
        Some("orca-daemon-test-session-42.scope")
    );
}

#[tokio::test]
async fn test_daemon_host_relocation_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;
    let req = make_req(
        "reloc-1",
        "system.relocatedHost",
        Some(json!({ "version": "1.4.214" })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("version").and_then(|v| v.as_str()), Some("1.4.214"));
    assert!(val.get("exeName").is_some());
    assert!(val.get("relocatedDir").is_some());
}

#[tokio::test]
async fn test_relay_status_and_preflight_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;

    // 1. relay.status
    let req = make_req("status-1", "relay.status", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("ok").and_then(|v| v.as_bool()), Some(true));
    assert!(val.get("daemon").is_some());

    // 2. preflight.detectAgents
    let req = make_req("preflight-1", "preflight.detectAgents", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let agents = val.get("agents").and_then(|v| v.as_array()).unwrap();
    assert!(agents.iter().any(|a| a.as_str() == Some("claude")));

    // 3. preflight.detectWindowsTerminalCapabilities
    let req = make_req(
        "preflight-2",
        "preflight.detectWindowsTerminalCapabilities",
        None,
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("ok").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn test_workspace_session_snapshot_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;

    // 1. workspace.get
    let req = make_req(
        "ws-1",
        "workspace.get",
        Some(json!({ "namespace": "project-alpha" })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(
        val.get("namespace").and_then(|v| v.as_str()),
        Some("project-alpha")
    );
    assert_eq!(val.get("revision").and_then(|v| v.as_u64()), Some(1));

    // 2. workspace.patch
    let req = make_req(
        "ws-2",
        "workspace.patch",
        Some(json!({
            "namespace": "project-alpha",
            "snapshot": { "activeTabId": "tab-1" }
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("ok").and_then(|v| v.as_bool()), Some(true));

    // 3. workspace.presence
    let req = make_req(
        "ws-3",
        "workspace.presence",
        Some(json!({ "clientId": "c1" })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("ok").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn test_agent_exec_non_interactive_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;

    let (bin, args) = if cfg!(windows) {
        (
            "cmd",
            vec![
                "/c".to_string(),
                "echo Generated commit message".to_string(),
            ],
        )
    } else {
        (
            "sh",
            vec![
                "-c".to_string(),
                "echo Generated commit message".to_string(),
            ],
        )
    };

    let req = make_req(
        "exec-1",
        "agent.execNonInteractive",
        Some(json!({
            "binary": bin,
            "args": args,
            "timeoutMs": 10000
        })),
    );
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("ok").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(val.get("exitCode").and_then(|v| v.as_i64()), Some(0));
    let stdout = val.get("stdout").and_then(|v| v.as_str()).unwrap();
    assert!(stdout.contains("Generated commit message"));

    // cancel
    let req = make_req("exec-2", "agent.cancelExec", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert_eq!(val.get("canceled").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn test_resolve_home_and_shell_profiles_rpc() {
    let (dispatcher, _temp_dir) = setup_test_dispatcher().await;

    // 1. session.resolveHome
    let req = make_req("home-1", "session.resolveHome", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert!(val.get("home").and_then(|v| v.as_str()).is_some());

    // 2. pty.getDefaultShell
    let req = make_req("shell-1", "pty.getDefaultShell", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    assert!(val.get("shell").and_then(|v| v.as_str()).is_some());

    // 3. pty.getProfiles
    let req = make_req("prof-1", "pty.getProfiles", None);
    let val = unwrap_success(dispatcher.dispatch(req).await);
    let profiles = val.get("profiles").and_then(|v| v.as_array()).unwrap();
    assert!(!profiles.is_empty());
}
