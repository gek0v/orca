use bytes::Bytes;
use orca_protocol::terminal_stream::{
    decode_terminal_stream_frame, encode_terminal_stream_frame, TerminalStreamFrame,
    TerminalStreamOpcode, HEADER_BYTES, TERMINAL_STREAM_KIND, TERMINAL_STREAM_VERSION,
};

#[test]
fn test_adversarial_opcode_range_exhaustive_0_to_255() {
    // Exactly opcodes 1 through 17 are defined and valid.
    let expected_valid_opcodes = [
        (1, TerminalStreamOpcode::Output),
        (2, TerminalStreamOpcode::SnapshotStart),
        (3, TerminalStreamOpcode::SnapshotChunk),
        (4, TerminalStreamOpcode::SnapshotEnd),
        (5, TerminalStreamOpcode::Resized),
        (6, TerminalStreamOpcode::Error),
        (7, TerminalStreamOpcode::Input),
        (8, TerminalStreamOpcode::Resize),
        (9, TerminalStreamOpcode::Subscribe),
        (10, TerminalStreamOpcode::Unsubscribe),
        (11, TerminalStreamOpcode::SnapshotRequest),
        (12, TerminalStreamOpcode::Metadata),
        (13, TerminalStreamOpcode::Ack),
        (14, TerminalStreamOpcode::ClaimViewport),
        (15, TerminalStreamOpcode::OutputSpan),
        (16, TerminalStreamOpcode::SetOutputPaused),
        (17, TerminalStreamOpcode::WriteUnavailable),
    ];

    for (val, expected_op) in expected_valid_opcodes {
        assert_eq!(
            TerminalStreamOpcode::from_u8(val),
            Some(expected_op),
            "Opcode {val} must decode to {expected_op:?}"
        );
        assert_eq!(
            expected_op.as_u8(),
            val,
            "Opcode {expected_op:?} as_u8 must equal {val}"
        );
    }

    // Every other byte in 0..=255 must return None
    for b in 0u8..=255 {
        if (1..=17).contains(&b) {
            assert!(
                TerminalStreamOpcode::from_u8(b).is_some(),
                "Byte {b} in 1..=17 must be Some"
            );
        } else {
            assert_eq!(
                TerminalStreamOpcode::from_u8(b),
                None,
                "Byte {b} outside 1..=17 must return None"
            );
        }
    }
}

#[test]
fn test_adversarial_magic_byte_invariant() {
    assert_eq!(TERMINAL_STREAM_KIND, 0x74); // 't'

    let frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Output,
        stream_id: 100,
        seq: 500,
        payload: Bytes::from_static(b"magic-check"),
    };
    let encoded = encode_terminal_stream_frame(&frame);
    assert_eq!(encoded[0], 0x74, "First byte must be magic 0x74 ('t')");

    // Decoding with any magic byte other than 0x74 must fail
    for bad_magic in 0u8..=255 {
        if bad_magic == 0x74 {
            continue;
        }
        let mut corrupt = encoded.to_vec();
        corrupt[0] = bad_magic;
        assert_eq!(
            decode_terminal_stream_frame(&corrupt),
            None,
            "Magic byte 0x{bad_magic:02X} must be rejected"
        );
    }
}

#[test]
fn test_adversarial_version_invariant() {
    assert_eq!(TERMINAL_STREAM_VERSION, 1);

    let frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Output,
        stream_id: 101,
        seq: 501,
        payload: Bytes::from_static(b"version-check"),
    };
    let encoded = encode_terminal_stream_frame(&frame);
    assert_eq!(encoded[1], 1, "Second byte must be version 1");

    // Decoding with any version other than 1 must fail
    for bad_version in 0u8..=255 {
        if bad_version == 1 {
            continue;
        }
        let mut corrupt = encoded.to_vec();
        corrupt[1] = bad_version;
        assert_eq!(
            decode_terminal_stream_frame(&corrupt),
            None,
            "Version byte {bad_version} must be rejected"
        );
    }
}

#[test]
fn test_adversarial_16_byte_header_length_invariants() {
    assert_eq!(HEADER_BYTES, 16);

    let frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::SnapshotStart,
        stream_id: 1,
        seq: 1,
        payload: Bytes::from_static(b"payload-1234"),
    };
    let encoded = encode_terminal_stream_frame(&frame);

    // Truncated frames: any length strictly less than 16 must return None
    for len in 0..16 {
        assert_eq!(
            decode_terminal_stream_frame(&encoded[..len]),
            None,
            "Truncated header of length {len} (< 16) must return None"
        );
    }

    // Exactly 16 bytes with empty payload: valid frame with len 0 payload
    let empty_frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Ack,
        stream_id: 777,
        seq: 888,
        payload: Bytes::new(),
    };
    let encoded_empty = encode_terminal_stream_frame(&empty_frame);
    assert_eq!(encoded_empty.len(), 16, "Empty payload must result in exactly 16 bytes");
    let decoded_empty = decode_terminal_stream_frame(&encoded_empty)
        .expect("16-byte empty payload frame must decode");
    assert_eq!(decoded_empty.opcode, TerminalStreamOpcode::Ack);
    assert_eq!(decoded_empty.stream_id, 777);
    assert_eq!(decoded_empty.seq, 888);
    assert!(decoded_empty.payload.is_empty());
}

#[test]
fn test_adversarial_endianness_and_boundary_integers() {
    let test_cases = [
        (0u32, 0u64),
        (1u32, 1u64),
        (u32::MAX, u64::MAX),
        (0x12345678, 0x1122334455667788),
        (0xDEADBEEF, 0xFEEDBEEFCAFEBABE),
    ];

    for (stream_id, seq) in test_cases {
        let frame = TerminalStreamFrame {
            opcode: TerminalStreamOpcode::OutputSpan,
            stream_id,
            seq,
            payload: Bytes::from_static(b"endian-check"),
        };
        let encoded = encode_terminal_stream_frame(&frame);

        // Verify little-endian encoding in raw bytes
        assert_eq!(&encoded[4..8], &stream_id.to_le_bytes());
        assert_eq!(&encoded[8..16], &seq.to_le_bytes());

        // Verify roundtrip decoding
        let decoded = decode_terminal_stream_frame(&encoded).expect("Decode frame");
        assert_eq!(decoded.stream_id, stream_id);
        assert_eq!(decoded.seq, seq);
    }
}

#[test]
fn test_adversarial_all_opcodes_roundtrip() {
    let all_opcodes = [
        TerminalStreamOpcode::Output,
        TerminalStreamOpcode::SnapshotStart,
        TerminalStreamOpcode::SnapshotChunk,
        TerminalStreamOpcode::SnapshotEnd,
        TerminalStreamOpcode::Resized,
        TerminalStreamOpcode::Error,
        TerminalStreamOpcode::Input,
        TerminalStreamOpcode::Resize,
        TerminalStreamOpcode::Subscribe,
        TerminalStreamOpcode::Unsubscribe,
        TerminalStreamOpcode::SnapshotRequest,
        TerminalStreamOpcode::Metadata,
        TerminalStreamOpcode::Ack,
        TerminalStreamOpcode::ClaimViewport,
        TerminalStreamOpcode::OutputSpan,
        TerminalStreamOpcode::SetOutputPaused,
        TerminalStreamOpcode::WriteUnavailable,
    ];

    for (idx, opcode) in all_opcodes.into_iter().enumerate() {
        let stream_id = (idx as u32) + 1000;
        let seq = (idx as u64) + 50000;
        let payload = Bytes::from(format!("payload-for-{:?}", opcode));

        let frame = TerminalStreamFrame {
            opcode,
            stream_id,
            seq,
            payload: payload.clone(),
        };

        let encoded = encode_terminal_stream_frame(&frame);
        assert_eq!(encoded[0], 0x74);
        assert_eq!(encoded[1], 1);
        assert_eq!(encoded[2], opcode.as_u8());
        assert_eq!(encoded[3], 0); // reserved

        let decoded = decode_terminal_stream_frame(&encoded)
            .unwrap_or_else(|| panic!("Opcode {:?} must decode cleanly", opcode));
        assert_eq!(decoded.opcode, opcode);
        assert_eq!(decoded.stream_id, stream_id);
        assert_eq!(decoded.seq, seq);
        assert_eq!(decoded.payload, payload);
    }
}

#[test]
fn test_adversarial_large_and_binary_payloads() {
    // Binary payload with null bytes and high ASCII
    let mut binary_data = Vec::with_capacity(256);
    for i in 0u8..=255 {
        binary_data.push(i);
    }
    let frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Output,
        stream_id: 42,
        seq: 99,
        payload: Bytes::from(binary_data.clone()),
    };
    let encoded = encode_terminal_stream_frame(&frame);
    let decoded = decode_terminal_stream_frame(&encoded).expect("Decode binary payload");
    assert_eq!(decoded.payload.as_ref(), binary_data.as_slice());

    // 1 MB payload roundtrip
    let large_data = vec![0xABu8; 1024 * 1024];
    let large_frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Output,
        stream_id: 123,
        seq: 456,
        payload: Bytes::from(large_data.clone()),
    };
    let encoded_large = encode_terminal_stream_frame(&large_frame);
    assert_eq!(encoded_large.len(), 16 + 1024 * 1024);
    let decoded_large = decode_terminal_stream_frame(&encoded_large).expect("Decode 1MB payload");
    assert_eq!(decoded_large.payload.len(), 1024 * 1024);
    assert_eq!(decoded_large.payload.as_ref(), large_data.as_slice());
}
