use orcad::server::Server;
use orcad::test_client;
use serde_json::json;
use tempfile::tempdir;

fn make_test_endpoint(test_name: &str) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\orcad-test-{}-{}", test_name, std::process::id())
    } else {
        format!("/tmp/orcad-test-{}-{}.sock", test_name, std::process::id())
    }
}

#[tokio::test]
async fn test_git_engine_exec_and_worktree_lifecycle() {
    let temp_root = tempdir().expect("tempdir");
    let repo_dir = temp_root.path().join("test-repo");
    std::fs::create_dir_all(&repo_dir).expect("create repo dir");

    // Initialize git repository
    let mut init_cmd = tokio::process::Command::new("git");
    init_cmd.current_dir(&repo_dir);
    init_cmd.args(["init", "-b", "main"]);
    #[cfg(windows)]
    init_cmd.creation_flags(0x08000000);
    let init_res = init_cmd.output().await.expect("git init");
    assert!(init_res.status.success());

    // Configure test user
    let _ = tokio::process::Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.name", "Orca Test"])
        .output()
        .await;
    let _ = tokio::process::Command::new("git")
        .current_dir(&repo_dir)
        .args(["config", "user.email", "test@orca.ide"])
        .output()
        .await;

    // Create initial commit
    std::fs::write(repo_dir.join("README.md"), "# Test Repo\n").expect("write readme");
    let _ = tokio::process::Command::new("git")
        .current_dir(&repo_dir)
        .args(["add", "README.md"])
        .output()
        .await;
    let _ = tokio::process::Command::new("git")
        .current_dir(&repo_dir)
        .args(["commit", "-m", "Initial commit"])
        .output()
        .await;

    let endpoint = make_test_endpoint("git-worktree");
    let daemon = Server::start(&endpoint)
        .await
        .expect("Daemon must start successfully");

    let mut client = test_client::connect(&endpoint)
        .await
        .expect("Client must connect to daemon");

    // 1. Test git.exec: run git status
    let exec_res = client
        .send_raw_request(
            "git.exec",
            Some(json!({
                "cwd": repo_dir.to_string_lossy().to_string(),
                "args": ["status", "--porcelain"]
            })),
        )
        .await
        .expect("git.exec must succeed");

    assert_eq!(
        exec_res.get("exitCode").and_then(|v| v.as_i64()),
        Some(0),
        "git status exit code should be 0"
    );

    // 2. Test worktree.list on the repo
    let list_res = client
        .send_raw_request(
            "worktree.list",
            Some(json!({
                "repo": repo_dir.to_string_lossy().to_string()
            })),
        )
        .await
        .expect("worktree.list must succeed");

    let wts = list_res
        .get("worktrees")
        .and_then(|v| v.as_array())
        .expect("worktrees array");
    assert!(!wts.is_empty());
    assert_eq!(wts[0].get("isMain").and_then(|v| v.as_bool()), Some(true));

    // 3. Test worktree.create
    let wt_path = temp_root.path().join("feature-wt");
    let create_res = client
        .send_raw_request(
            "worktree.create",
            Some(json!({
                "repo": repo_dir.to_string_lossy().to_string(),
                "branch": "feature-1",
                "path": wt_path.to_string_lossy().to_string()
            })),
        )
        .await
        .expect("worktree.create must succeed");

    assert!(create_res
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false));

    // 4. Test worktree.lock
    let lock_res = client
        .send_raw_request(
            "worktree.lock",
            Some(json!({
                "repo": repo_dir.to_string_lossy().to_string(),
                "worktree": wt_path.to_string_lossy().to_string(),
                "reason": "agent executing task"
            })),
        )
        .await
        .expect("worktree.lock must succeed");

    assert!(lock_res
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false));

    // 5. Test worktree.unlock
    let unlock_res = client
        .send_raw_request(
            "worktree.unlock",
            Some(json!({
                "repo": repo_dir.to_string_lossy().to_string(),
                "worktree": wt_path.to_string_lossy().to_string()
            })),
        )
        .await
        .expect("worktree.unlock must succeed");

    assert!(unlock_res
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false));

    // 6. Test worktree.rm
    let rm_res = client
        .send_raw_request(
            "worktree.rm",
            Some(json!({
                "repo": repo_dir.to_string_lossy().to_string(),
                "worktree": wt_path.to_string_lossy().to_string(),
                "force": true
            })),
        )
        .await
        .expect("worktree.rm must succeed");

    assert!(rm_res.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));

    daemon.shutdown().await.expect("clean shutdown");
}
