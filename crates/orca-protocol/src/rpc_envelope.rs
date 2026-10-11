use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetaSuccess {
    pub runtime_id: String,
    #[serde(flatten)]
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MetaFailure {
    pub runtime_id: Option<String>,
    #[serde(flatten)]
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpcSuccess<T> {
    pub id: String,
    pub ok: bool,
    pub result: T,
    pub _meta: MetaSuccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpcFailure {
    pub id: String,
    pub ok: bool,
    pub error: RpcErrorDetail,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub _meta: Option<MetaFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RpcKeepalive {
    pub _keepalive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum RuntimeRpcEnvelope<T> {
    Success(RpcSuccess<T>),
    Failure(RpcFailure),
    Keepalive(RpcKeepalive),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRpcRequest {
    pub id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl<T> RuntimeRpcEnvelope<T> {
    pub fn success(id: impl Into<String>, result: T, runtime_id: impl Into<String>) -> Self {
        Self::Success(RpcSuccess {
            id: id.into(),
            ok: true,
            result,
            _meta: MetaSuccess {
                runtime_id: runtime_id.into(),
                extra: None,
            },
        })
    }

    pub fn failure(
        id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
        runtime_id: Option<String>,
    ) -> Self {
        Self::Failure(RpcFailure {
            id: id.into(),
            ok: false,
            error: RpcErrorDetail {
                code: code.into(),
                message: message.into(),
                data: None,
            },
            _meta: runtime_id.map(|rt| MetaFailure {
                runtime_id: Some(rt),
                extra: None,
            }),
        })
    }

    pub fn keepalive() -> Self {
        Self::Keepalive(RpcKeepalive { _keepalive: true })
    }
}
