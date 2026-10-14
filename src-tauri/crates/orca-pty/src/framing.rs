//! 16-byte binary framing protocol for high-performance terminal streaming.
//!
//! Frame Layout:
//! - Offset 0: Kind `'t'` (0x74)
//! - Offset 1: Version 1 (0x01)
//! - Offset 2: Opcode (1: Output, 2: Exit)
//! - Offset 3: Reserved (0x00)
//! - Offset 4..8: Stream ID (u32 little-endian)
//! - Offset 8..12: Sequence High (u32 little-endian)
//! - Offset 12..16: Sequence Low (u32 little-endian)
//! - Offset 16..: Raw terminal payload bytes

use thiserror::Error;

pub const PTY_FRAME_KIND: u8 = 0x74; // 't'
pub const PTY_FRAME_VERSION: u8 = 0x01;
pub const PTY_FRAME_HEADER_SIZE: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyFrameOpcode {
    Output = 1,
    Exit = 2,
}

impl TryFrom<u8> for PtyFrameOpcode {
    type Error = PtyFramingError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(PtyFrameOpcode::Output),
            2 => Ok(PtyFrameOpcode::Exit),
            other => Err(PtyFramingError::InvalidOpcode(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyFrame {
    pub opcode: PtyFrameOpcode,
    pub stream_id: u32,
    pub sequence: u64,
    pub payload: Vec<u8>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PtyFramingError {
    #[error("Frame truncated: expected at least 16 bytes, got {0}")]
    TruncatedHeader(usize),
    #[error("Invalid frame kind: expected 0x74, got 0x{0:02x}")]
    InvalidKind(u8),
    #[error("Unsupported frame version: expected 1, got {0}")]
    UnsupportedVersion(u8),
    #[error("Invalid opcode: {0}")]
    InvalidOpcode(u8),
}

/// Encodes raw payload bytes into a 16-byte framed binary packet.
pub fn encode_pty_frame(
    opcode: PtyFrameOpcode,
    stream_id: u32,
    sequence: u64,
    payload: &[u8],
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(PTY_FRAME_HEADER_SIZE + payload.len());
    frame.push(PTY_FRAME_KIND);
    frame.push(PTY_FRAME_VERSION);
    frame.push(opcode as u8);
    frame.push(0x00); // Reserved

    frame.extend_from_slice(&stream_id.to_le_bytes()); // Offset 4..8

    let seq_high = (sequence >> 32) as u32;
    let seq_low = (sequence & 0xFFFF_FFFF) as u32;
    frame.extend_from_slice(&seq_high.to_le_bytes()); // Offset 8..12
    frame.extend_from_slice(&seq_low.to_le_bytes());  // Offset 12..16

    frame.extend_from_slice(payload);
    frame
}

/// Decodes a 16-byte framed binary packet.
pub fn decode_pty_frame(data: &[u8]) -> Result<PtyFrame, PtyFramingError> {
    if data.len() < PTY_FRAME_HEADER_SIZE {
        return Err(PtyFramingError::TruncatedHeader(data.len()));
    }

    if data[0] != PTY_FRAME_KIND {
        return Err(PtyFramingError::InvalidKind(data[0]));
    }

    if data[1] != PTY_FRAME_VERSION {
        return Err(PtyFramingError::UnsupportedVersion(data[1]));
    }

    let opcode = PtyFrameOpcode::try_from(data[2])?;

    let stream_id = u32::from_le_bytes(
        data[4..8]
            .try_into()
            .expect("slice length verified by header size"),
    );

    let seq_high = u32::from_le_bytes(
        data[8..12]
            .try_into()
            .expect("slice length verified by header size"),
    );
    let seq_low = u32::from_le_bytes(
        data[12..16]
            .try_into()
            .expect("slice length verified by header size"),
    );
    let sequence = ((seq_high as u64) << 32) | (seq_low as u64);

    let payload = data[PTY_FRAME_HEADER_SIZE..].to_vec();

    Ok(PtyFrame {
        opcode,
        stream_id,
        sequence,
        payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pty_frame_encode_decode_roundtrip() {
        let payload = b"Hello, Orca Terminal with ANSI \x1b[32mColors\x1b[0m!\r\n";
        let stream_id = 42;
        let sequence = 0x0000_0001_8000_1234u64;

        let encoded = encode_pty_frame(PtyFrameOpcode::Output, stream_id, sequence, payload);
        assert_eq!(encoded.len(), PTY_FRAME_HEADER_SIZE + payload.len());

        let decoded = decode_pty_frame(&encoded).expect("frame decoding succeeded");
        assert_eq!(decoded.opcode, PtyFrameOpcode::Output);
        assert_eq!(decoded.stream_id, stream_id);
        assert_eq!(decoded.sequence, sequence);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn test_pty_frame_exit_opcode() {
        let exit_code_payload = 0u32.to_le_bytes();
        let encoded = encode_pty_frame(PtyFrameOpcode::Exit, 1, 100, &exit_code_payload);
        let decoded = decode_pty_frame(&encoded).unwrap();
        assert_eq!(decoded.opcode, PtyFrameOpcode::Exit);
        assert_eq!(decoded.payload, exit_code_payload);
    }

    #[test]
    fn test_pty_frame_rejects_truncated() {
        let err = decode_pty_frame(&[0x74, 1, 1]).unwrap_err();
        assert_eq!(err, PtyFramingError::TruncatedHeader(3));
    }

    #[test]
    fn test_pty_frame_rejects_invalid_kind() {
        let mut bytes = [0u8; 16];
        bytes[0] = 0x55; // Not 't'
        bytes[1] = 1;
        bytes[2] = 1;
        let err = decode_pty_frame(&bytes).unwrap_err();
        assert_eq!(err, PtyFramingError::InvalidKind(0x55));
    }
}
