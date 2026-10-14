//! RPC envelope types and serialization models for orcad communication.
//!
//! Follows the canonical Orca RPC contract defined in `src/shared/runtime-rpc-envelope.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcRequest<P = serde_json::Value> {
    pub id: String,
    pub method: String,
    pub params: P,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcMeta {
    #[serde(rename = "runtimeId")]
    pub runtime_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RpcResponse<R = serde_json::Value> {
    Success {
        id: String,
        ok: bool,
        result: R,
        #[serde(skip_serializing_if = "Option::is_none")]
        _meta: Option<RpcMeta>,
    },
    Failure {
        id: String,
        ok: bool,
        error: RpcErrorPayload,
        #[serde(skip_serializing_if = "Option::is_none")]
        _meta: Option<RpcMeta>,
    },
    Keepalive {
        _keepalive: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rpc_request_serialization() {
        let req = RpcRequest {
            id: "req-1".to_string(),
            method: "agent.status".to_string(),
            params: serde_json::json!({ "worktreeId": "wt-123" }),
        };

        let json = serde_json::to_string(&req).expect("serialize request");
        assert!(json.contains(r#""id":"req-1""#));
        assert!(json.contains(r#""method":"agent.status""#));
    }

    #[test]
    fn test_rpc_response_success_deserialization() {
        let json = r#"{"id":"req-1","ok":true,"result":{"status":"live"},"_meta":{"runtimeId":"rt-1"}}"#;
        let resp: RpcResponse = serde_json::from_str(json).expect("deserialize response");
        match resp {
            RpcResponse::Success { id, ok, result, _meta } => {
                assert_eq!(id, "req-1");
                assert!(ok);
                assert_eq!(result["status"], "live");
                assert_eq!(_meta.unwrap().runtime_id, Some("rt-1".to_string()));
            }
            _ => panic!("Expected Success variant"),
        }
    }

    #[test]
    fn test_rpc_response_failure_deserialization() {
        let json = r#"{"id":"req-2","ok":false,"error":{"code":"ERR_NOT_FOUND","message":"Session not found"}}"#;
        let resp: RpcResponse = serde_json::from_str(json).expect("deserialize error");
        match resp {
            RpcResponse::Failure { id, ok, error, .. } => {
                assert_eq!(id, "req-2");
                assert!(!ok);
                assert_eq!(error.code, "ERR_NOT_FOUND");
            }
            _ => panic!("Expected Failure variant"),
        }
    }

    #[test]
    fn test_rpc_keepalive_deserialization() {
        let json = r#"{"_keepalive":true}"#;
        let resp: RpcResponse = serde_json::from_str(json).expect("deserialize keepalive");
        match resp {
            RpcResponse::Keepalive { _keepalive } => assert!(_keepalive),
            _ => panic!("Expected Keepalive variant"),
        }
    }
}
