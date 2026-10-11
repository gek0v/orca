use assert_cmd::Command;
use predicates::prelude::*;

#[test]
fn test_orca_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Next-gen IDE for parallel agentic development",
        ))
        .stdout(predicate::str::contains("ps"))
        .stdout(predicate::str::contains("terminal"))
        .stdout(predicate::str::contains("worktree"))
        .stdout(predicate::str::contains("ping"))
        .stdout(predicate::str::contains("--pipe"))
        .stdout(predicate::str::contains("--socket"))
        .stdout(predicate::str::contains("--json"));
}

#[test]
fn test_orca_no_args_shows_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.assert().success().stdout(predicate::str::contains(
        "Next-gen IDE for parallel agentic development",
    ));
}

#[test]
fn test_orca_version() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.arg("--version")
        .assert()
        .success()
        .stdout(predicate::str::contains("orca 1.4.214"));
}

#[test]
fn test_orca_ps_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["ps", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "List running agents, tasks, and worktrees",
        ))
        .stdout(predicate::str::contains("--worktree"))
        .stdout(predicate::str::contains("--all"))
        .stdout(predicate::str::contains("--json"));
}

#[test]
fn test_orca_ping_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["ping", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Ping the orcad daemon"));
}

#[test]
fn test_orca_terminal_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["terminal", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--shell"))
        .stdout(predicate::str::contains("--command"))
        .stdout(predicate::str::contains("--cwd"));
}

#[test]
fn test_orca_worktree_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["worktree", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("create"))
        .stdout(predicate::str::contains("list"))
        .stdout(predicate::str::contains("rm"));
}

#[test]
fn test_orca_command_parsing_json_flag() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    // Test --json on ping with a custom invalid pipe to ensure clean exit and valid json error response
    let assert = cmd
        .args(["--pipe", "test-pipe-missing", "--json", "ping"])
        .assert()
        .code(predicate::eq(1));

    let output = assert.get_output();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("Stdout must be valid JSON");
    assert_eq!(parsed["ok"], false);
    assert!(parsed["error"].is_string());
}

#[test]
fn test_orca_command_parsing_ps_json_flag() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    // Test ps --json with a custom invalid pipe
    let assert = cmd
        .args(["--pipe", "test-pipe-missing", "ps", "--json"])
        .assert()
        .code(predicate::eq(1));

    let output = assert.get_output();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(&stdout).expect("Stdout must be valid JSON");
    assert_eq!(parsed["ok"], false);
    assert!(parsed["error"].is_string());
}

#[test]
fn test_orca_status_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["status", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Show app/runtime/daemon readiness",
        ));
}

#[test]
fn test_orca_diagnostics_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["diagnostics", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "Diagnostics and process resource snapshots",
        ))
        .stdout(predicate::str::contains("memory"));

    let mut mem_cmd = Command::cargo_bin("orca").unwrap();
    mem_cmd
        .args(["diagnostics", "memory", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("Collect a memory snapshot"));
}

#[test]
fn test_orca_terminal_expanded_subcommands_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["terminal", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("send"))
        .stdout(predicate::str::contains("read"))
        .stdout(predicate::str::contains("wait"))
        .stdout(predicate::str::contains("close"))
        .stdout(predicate::str::contains("split"));

    let mut send_cmd = Command::cargo_bin("orca").unwrap();
    send_cmd
        .args(["terminal", "send", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--text"))
        .stdout(predicate::str::contains("--enter"))
        .stdout(predicate::str::contains("--interrupt"));

    let mut read_cmd = Command::cargo_bin("orca").unwrap();
    read_cmd
        .args(["terminal", "read", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--cursor"))
        .stdout(predicate::str::contains("--limit"))
        .stdout(predicate::str::contains("--screen"));

    let mut wait_cmd = Command::cargo_bin("orca").unwrap();
    wait_cmd
        .args(["terminal", "wait", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--for"))
        .stdout(predicate::str::contains("--timeout-ms"));

    let mut close_cmd = Command::cargo_bin("orca").unwrap();
    close_cmd
        .args(["terminal", "close", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--tab"))
        .stdout(predicate::str::contains("--worktree"))
        .stdout(predicate::str::contains("--all"));

    let mut split_cmd = Command::cargo_bin("orca").unwrap();
    split_cmd
        .args(["terminal", "split", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("--direction"))
        .stdout(predicate::str::contains("--command"));
}

#[test]
fn test_orca_worktree_expanded_subcommands_help() {
    let mut cmd = Command::cargo_bin("orca").unwrap();
    cmd.args(["worktree", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("list"))
        .stdout(predicate::str::contains("show"))
        .stdout(predicate::str::contains("create"))
        .stdout(predicate::str::contains("rm"));
}
