use orcad::agent_status_store::{AgentStatusRow, AgentStatusStore, AgentVerdict};

#[tokio::test]
async fn test_agent_status_transitions_and_flush() {
    let temp_dir = tempfile::tempdir().unwrap();
    let status_path = temp_dir.path().join("last-status.json");
    let store = AgentStatusStore::new(&status_path);

    // Initial state
    assert!(store.get_status("session-1").await.is_none());

    // Update status to Live
    store
        .update_status("session-1", AgentVerdict::Live, "Planning task")
        .await;
    let row = store.get_status("session-1").await.unwrap();
    assert_eq!(row.session_id, "session-1");
    assert_eq!(row.verdict, AgentVerdict::Live);
    assert_eq!(row.description, "Planning task");

    // Transition to Unverifiable
    store.mark_unverifiable("session-1").await;
    let row = store.get_status("session-1").await.unwrap();
    assert_eq!(row.verdict, AgentVerdict::Unverifiable);

    // Transition to Exited
    store.mark_exited("session-1").await;
    let row = store.get_status("session-1").await.unwrap();
    assert_eq!(row.verdict, AgentVerdict::Exited);

    // Atomic flush to disk
    store
        .flush_atomic()
        .await
        .expect("Atomic flush must succeed");
    assert!(status_path.exists());

    // Read back and verify persistence
    let file_content = tokio::fs::read_to_string(&status_path).await.unwrap();
    let rows: Vec<AgentStatusRow> = serde_json::from_str(&file_content).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session_id, "session-1");
    assert_eq!(rows[0].verdict, AgentVerdict::Exited);
}

#[tokio::test]
async fn test_agent_status_subscription_broadcast() {
    let temp_dir = tempfile::tempdir().unwrap();
    let status_path = temp_dir.path().join("last-status.json");
    let store = AgentStatusStore::new(&status_path);

    let mut rx = store.subscribe();

    store
        .update_status("sub-session", AgentVerdict::Live, "Running tests")
        .await;

    let received = rx.recv().await.expect("Must receive broadcast update");
    assert_eq!(received.session_id, "sub-session");
    assert_eq!(received.verdict, AgentVerdict::Live);
    assert_eq!(received.description, "Running tests");

    store.mark_unverifiable("sub-session").await;
    let received_unverifiable = rx.recv().await.expect("Must receive unverifiable update");
    assert_eq!(received_unverifiable.verdict, AgentVerdict::Unverifiable);
}
