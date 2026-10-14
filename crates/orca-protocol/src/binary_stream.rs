use bytes::{BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const BINARY_STREAM_FRAMING: &str = "binary-v1";
pub const EVENT_FRAME: u8 = 1;
pub const DATA_FRAME: u8 = 2;
pub const FRAME_HEADER_BYTES: usize = 5;
pub const DATA_META_LENGTH_BYTES: usize = 2;
pub const MAX_DATA_META_BYTES: usize = 0xffff;
pub const BINARY_STREAM_MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Error, Debug, PartialEq, Eq)]
pub enum BinaryStreamError {
    #[error("Invalid frame kind: {0}")]
    InvalidKind(u8),
    #[error("Frame body exceeds maximum allowed size ({0} > {1})")]
    FrameTooLarge(usize, usize),
    #[error("Data frame metadata exceeds maximum size: {0}")]
    MetaTooLarge(usize),
    #[error("Malformed data frame: body shorter than metadata header")]
    MalformedBody,
    #[error("JSON error: {0}")]
    Json(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub version: u32,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(rename = "clientId", default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(rename = "streamFraming", default)]
    pub stream_framing: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "streamFraming", skip_serializing_if = "Option::is_none")]
    pub stream_framing: Option<String>,
    #[serde(rename = "daemonIdentity", skip_serializing_if = "Option::is_none")]
    pub daemon_identity: Option<DaemonEndpointIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonEndpointIdentity {
    pub pid: u32,
    #[serde(rename = "startedAtMs")]
    pub started_at_ms: u64,
    #[serde(rename = "launchNonce")]
    pub launch_nonce: String,
    #[serde(rename = "entryPath", skip_serializing_if = "Option::is_none")]
    pub entry_path: Option<String>,
    #[serde(rename = "appVersion", skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinaryStreamDecodedFrame {
    Event(serde_json::Value),
    Data {
        session_id: String,
        payload_meta: serde_json::Value,
        data: Vec<u8>,
    },
}

pub fn encode_binary_stream_event_frame(event_json: &[u8]) -> Bytes {
    let mut buf = BytesMut::with_capacity(FRAME_HEADER_BYTES + event_json.len());
    buf.put_u8(EVENT_FRAME);
    buf.put_u32(event_json.len() as u32);
    buf.put_slice(event_json);
    buf.freeze()
}

pub fn encode_binary_stream_data_frame(
    session_id: &str,
    data: &[u8],
    payload_meta: Option<&serde_json::Value>,
) -> Result<Bytes, BinaryStreamError> {
    let default_payload = serde_json::json!({});
    let payload_val = payload_meta.unwrap_or(&default_payload);
    let meta_obj = serde_json::json!({
        "type": "event",
        "event": "data",
        "sessionId": session_id,
        "payload": payload_val
    });
    let meta_bytes = serde_json::to_vec(&meta_obj)
        .map_err(|e| BinaryStreamError::Json(e.to_string()))?;

    if meta_bytes.len() > MAX_DATA_META_BYTES {
        return Err(BinaryStreamError::MetaTooLarge(meta_bytes.len()));
    }

    let body_len = DATA_META_LENGTH_BYTES + meta_bytes.len() + data.len();
    if body_len > BINARY_STREAM_MAX_FRAME_BYTES {
        return Err(BinaryStreamError::FrameTooLarge(
            body_len,
            BINARY_STREAM_MAX_FRAME_BYTES,
        ));
    }

    let mut buf = BytesMut::with_capacity(FRAME_HEADER_BYTES + body_len);
    buf.put_u8(DATA_FRAME);
    buf.put_u32(body_len as u32);
    buf.put_u16(meta_bytes.len() as u16);
    buf.put_slice(&meta_bytes);
    buf.put_slice(data);
    Ok(buf.freeze())
}

#[derive(Default)]
pub struct BinaryStreamDecoder {
    buffer: BytesMut,
}

impl BinaryStreamDecoder {
    pub fn new() -> Self {
        Self {
            buffer: BytesMut::new(),
        }
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
    }

    pub fn next_frame(&mut self) -> Result<Option<BinaryStreamDecodedFrame>, BinaryStreamError> {
        if self.buffer.len() < FRAME_HEADER_BYTES {
            return Ok(None);
        }

        let kind = self.buffer[0];
        let body_len = u32::from_be_bytes(self.buffer[1..5].try_into().unwrap()) as usize;

        if kind != EVENT_FRAME && kind != DATA_FRAME {
            return Err(BinaryStreamError::InvalidKind(kind));
        }

        if body_len > BINARY_STREAM_MAX_FRAME_BYTES {
            return Err(BinaryStreamError::FrameTooLarge(
                body_len,
                BINARY_STREAM_MAX_FRAME_BYTES,
            ));
        }

        let total_frame_len = FRAME_HEADER_BYTES + body_len;
        if self.buffer.len() < total_frame_len {
            return Ok(None);
        }

        let frame_bytes = self.buffer.split_to(total_frame_len);
        let body = &frame_bytes[FRAME_HEADER_BYTES..];

        match kind {
            EVENT_FRAME => {
                let val: serde_json::Value = serde_json::from_slice(body)
                    .map_err(|e| BinaryStreamError::Json(e.to_string()))?;
                Ok(Some(BinaryStreamDecodedFrame::Event(val)))
            }
            DATA_FRAME => {
                if body.len() < DATA_META_LENGTH_BYTES {
                    return Err(BinaryStreamError::MalformedBody);
                }
                let meta_len = u16::from_be_bytes(body[0..2].try_into().unwrap()) as usize;
                let meta_end = DATA_META_LENGTH_BYTES + meta_len;
                if meta_end > body.len() {
                    return Err(BinaryStreamError::MalformedBody);
                }
                let meta_json: serde_json::Value =
                    serde_json::from_slice(&body[DATA_META_LENGTH_BYTES..meta_end])
                        .map_err(|e| BinaryStreamError::Json(e.to_string()))?;

                let session_id = meta_json
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                let payload_meta = meta_json
                    .get("payload")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));

                let data = body[meta_end..].to_vec();

                Ok(Some(BinaryStreamDecodedFrame::Data {
                    session_id,
                    payload_meta,
                    data,
                }))
            }
            _ => unreachable!(),
        }
    }
}
