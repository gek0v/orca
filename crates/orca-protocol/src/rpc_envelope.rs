use serde::{Deserialize, Serialize};

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaSuccess {
    #[serde(default)]
    pub runtime_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaFailure {
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpcSuccess<T> {
    pub id: String,
    #[serde(default = "default_true")]
    pub ok: bool,
    pub result: T,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub _meta: Option<MetaSuccess>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RpcErrorDetail {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpcFailure {
    pub id: String,
    #[serde(default)]
    pub ok: bool,
    pub error: RpcErrorDetail,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub auth_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl<T> RuntimeRpcEnvelope<T> {
    pub fn success(id: impl Into<String>, result: T, runtime_id: impl Into<String>) -> Self {
        Self::Success(RpcSuccess {
            id: id.into(),
            ok: true,
            result,
            _meta: Some(MetaSuccess {
                runtime_id: runtime_id.into(),
                extra: None,
            }),
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
