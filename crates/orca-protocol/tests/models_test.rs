use orca_protocol::models::*;

#[test]
fn test_terminal_send_params_serde() {
    let json_data =
        r#"{"terminalId":"term-1","text":"echo hi","enter":true,"interrupt":false,"waitSubmit":5}"#;
    let params: TerminalSendParams = serde_json::from_str(json_data).unwrap();
    assert_eq!(params.terminal_id.as_deref(), Some("term-1"));
    assert_eq!(params.text.as_deref(), Some("echo hi"));
    assert!(params.enter);
    assert!(!params.interrupt);
    assert_eq!(params.wait_submit, Some(5));

    let serialized = serde_json::to_string(&params).unwrap();
    assert!(serialized.contains("\"terminalId\":\"term-1\""));
    assert!(serialized.contains("\"enter\":true"));
}

#[test]
fn test_terminal_read_params_serde() {
    let json_data = r#"{"terminalId":"term-1","cursor":120,"limit":500,"screen":true}"#;
    let params: TerminalReadParams = serde_json::from_str(json_data).unwrap();
    assert_eq!(params.terminal_id.as_deref(), Some("term-1"));
    assert_eq!(params.cursor, Some(120));
    assert_eq!(params.limit, Some(500));
    assert!(params.screen);
}

#[test]
fn test_terminal_wait_params_serde() {
    let json_data = r#"{"terminalId":"term-1","for":"tui-idle","timeoutMs":2000}"#;
    let params: TerminalWaitParams = serde_json::from_str(json_data).unwrap();
    assert_eq!(params.terminal_id.as_deref(), Some("term-1"));
    assert_eq!(params.for_condition, "tui-idle");
    assert_eq!(params.timeout_ms, Some(2000));
}

#[test]
fn test_worktree_models_serde() {
    let create_data = r#"{"name":"feature-x","branch":"feat/x","baseBranch":"main"}"#;
    let params: WorktreeCreateParams = serde_json::from_str(create_data).unwrap();
    assert_eq!(params.name.as_deref(), Some("feature-x"));
    assert_eq!(params.branch.as_deref(), Some("feat/x"));
    assert_eq!(params.base_branch.as_deref(), Some("main"));

    let item = WorktreeItem {
        id: "wt-1".to_string(),
        branch: "main".to_string(),
        path: "C:\\repo".to_string(),
        head: Some("abc1234".to_string()),
        status: "clean".to_string(),
        is_main: true,
    };
    let item_json = serde_json::to_string(&item).unwrap();
    assert!(item_json.contains("\"isMain\":true"));
}
