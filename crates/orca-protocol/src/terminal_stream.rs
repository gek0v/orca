use bytes::{BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};

pub const TERMINAL_STREAM_KIND: u8 = 0x74; // 't'
pub const TERMINAL_STREAM_VERSION: u8 = 1;
pub const HEADER_BYTES: usize = 16;
pub const TERMINAL_STREAM_JSON_MAX_BYTES: usize = 8 * 1024 * 1024;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalStreamOpcode {
    Output = 1,
    SnapshotStart = 2,
    SnapshotChunk = 3,
    SnapshotEnd = 4,
    Resized = 5,
    Error = 6,
    Input = 7,
    Resize = 8,
    Subscribe = 9,
    Unsubscribe = 10,
    SnapshotRequest = 11,
    Metadata = 12,
    Ack = 13,
    ClaimViewport = 14,
    OutputSpan = 15,
    SetOutputPaused = 16,
    WriteUnavailable = 17,
}

impl TerminalStreamOpcode {
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Output),
            2 => Some(Self::SnapshotStart),
            3 => Some(Self::SnapshotChunk),
            4 => Some(Self::SnapshotEnd),
            5 => Some(Self::Resized),
            6 => Some(Self::Error),
            7 => Some(Self::Input),
            8 => Some(Self::Resize),
            9 => Some(Self::Subscribe),
            10 => Some(Self::Unsubscribe),
            11 => Some(Self::SnapshotRequest),
            12 => Some(Self::Metadata),
            13 => Some(Self::Ack),
            14 => Some(Self::ClaimViewport),
            15 => Some(Self::OutputSpan),
            16 => Some(Self::SetOutputPaused),
            17 => Some(Self::WriteUnavailable),
            _ => None,
        }
    }

    pub fn as_u8(&self) -> u8 {
        *self as u8
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalStreamFrame {
    pub opcode: TerminalStreamOpcode,
    pub stream_id: u32,
    pub seq: u64,
    pub payload: Bytes,
}

pub fn encode_terminal_stream_frame(frame: &TerminalStreamFrame) -> Bytes {
    let mut buf = BytesMut::with_capacity(HEADER_BYTES + frame.payload.len());
    buf.put_u8(TERMINAL_STREAM_KIND);
    buf.put_u8(TERMINAL_STREAM_VERSION);
    buf.put_u8(frame.opcode.as_u8());
    buf.put_u8(0); // reserved
    buf.put_u32_le(frame.stream_id);
    buf.put_u64_le(frame.seq);
    buf.extend_from_slice(&frame.payload);
    buf.freeze()
}

pub fn decode_terminal_stream_frame(bytes: &[u8]) -> Option<TerminalStreamFrame> {
    if bytes.len() < HEADER_BYTES {
        return None;
    }
    if bytes[0] != TERMINAL_STREAM_KIND || bytes[1] != TERMINAL_STREAM_VERSION {
        return None;
    }
    let opcode = TerminalStreamOpcode::from_u8(bytes[2])?;
    let stream_id = u32::from_le_bytes(bytes[4..8].try_into().ok()?);
    let seq = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let payload = Bytes::copy_from_slice(&bytes[HEADER_BYTES..]);

    Some(TerminalStreamFrame {
        opcode,
        stream_id,
        seq,
        payload,
    })
}
