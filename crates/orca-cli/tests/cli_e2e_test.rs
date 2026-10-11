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
        .stdout(predicate::str::contains("remove"));
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
