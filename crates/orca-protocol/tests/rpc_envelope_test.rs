use orca_protocol::rpc_envelope::RuntimeRpcEnvelope;

#[test]
fn test_roundtrip_rpc_success() {
    let envelope = RuntimeRpcEnvelope::success(
        "req-123",
        serde_json::json!({ "status": "ok" }),
        "rt-node-1",
    );
    let serialized = serde_json::to_string(&envelope).unwrap();
    assert!(serialized.contains("\"id\":\"req-123\""));
    assert!(serialized.contains("\"ok\":true"));
    assert!(serialized.contains("\"runtimeId\":\"rt-node-1\""));

    let deserialized: RuntimeRpcEnvelope<serde_json::Value> =
        serde_json::from_str(&serialized).unwrap();
    match deserialized {
        RuntimeRpcEnvelope::Success(s) => {
            assert_eq!(s.id, "req-123");
            assert_eq!(s._meta.as_ref().unwrap().runtime_id, "rt-node-1");
        }
        _ => panic!("Expected Success variant"),
    }
}

#[test]
fn test_deserialization_without_meta() {
    let raw = r#"{"id":"req-999","ok":true,"result":{"key":"value"}}"#;
    let env: RuntimeRpcEnvelope<serde_json::Value> = serde_json::from_str(raw).unwrap();
    match env {
        RuntimeRpcEnvelope::Success(s) => {
            assert_eq!(s.id, "req-999");
            assert!(s._meta.is_none());
            assert_eq!(s.result["key"], "value");
        }
        _ => panic!("Expected Success variant"),
    }
}

#[test]
fn test_roundtrip_rpc_failure() {
    let envelope: RuntimeRpcEnvelope<()> =
        RuntimeRpcEnvelope::failure("req-456", "NOT_FOUND", "Tab not found", Some("rt-1".into()));
    let serialized = serde_json::to_string(&envelope).unwrap();
    assert!(serialized.contains("\"ok\":false"));
    assert!(serialized.contains("\"code\":\"NOT_FOUND\""));

    let deserialized: RuntimeRpcEnvelope<()> = serde_json::from_str(&serialized).unwrap();
    match deserialized {
        RuntimeRpcEnvelope::Failure(f) => {
            assert_eq!(f.id, "req-456");
            assert_eq!(f.error.code, "NOT_FOUND");
        }
        _ => panic!("Expected Failure variant"),
    }
}

#[test]
fn test_roundtrip_rpc_keepalive() {
    let envelope: RuntimeRpcEnvelope<()> = RuntimeRpcEnvelope::keepalive();
    let serialized = serde_json::to_string(&envelope).unwrap();
    assert_eq!(serialized, "{\"_keepalive\":true}");

    let deserialized: RuntimeRpcEnvelope<()> = serde_json::from_str(&serialized).unwrap();
    match deserialized {
        RuntimeRpcEnvelope::Keepalive(k) => assert!(k._keepalive),
        _ => panic!("Expected Keepalive variant"),
    }
}
