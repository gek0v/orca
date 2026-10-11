use orca_protocol::terminal_stream::{
    decode_terminal_stream_frame, encode_terminal_stream_frame, TerminalStreamFrame,
    TerminalStreamOpcode,
};

#[test]
fn test_roundtrip_terminal_stream_frame() {
    let frame = TerminalStreamFrame {
        opcode: TerminalStreamOpcode::Output,
        stream_id: 42,
        seq: 100500,
        payload: bytes::Bytes::from_static(b"\x1b[32mhello orca rust\x1b[0m"),
    };
    let encoded = encode_terminal_stream_frame(&frame);
    assert_eq!(encoded[0], 0x74); // 't'
    assert_eq!(encoded[1], 1); // version 1
    assert_eq!(encoded[2], 1); // Output opcode
    assert_eq!(encoded[3], 0); // reserved

    let decoded = decode_terminal_stream_frame(&encoded).expect("frame must decode correctly");
    assert_eq!(decoded.opcode, TerminalStreamOpcode::Output);
    assert_eq!(decoded.stream_id, 42);
    assert_eq!(decoded.seq, 100500);
    assert_eq!(decoded.payload.as_ref(), b"\x1b[32mhello orca rust\x1b[0m");
}

#[test]
fn test_corrupt_or_truncated_frame() {
    assert!(decode_terminal_stream_frame(b"short").is_none());
    assert!(decode_terminal_stream_frame(&[0x00; 16]).is_none());
}
