use orca_protocol::binary_stream::*;

#[test]
fn test_event_frame_roundtrip() {
    let event = serde_json::json!({
        "type": "event",
        "event": "exit",
        "terminalId": "term-123",
        "code": 0
    });
    let event_bytes = serde_json::to_vec(&event).unwrap();
    let encoded = encode_binary_stream_event_frame(&event_bytes);

    let mut decoder = BinaryStreamDecoder::new();
    decoder.feed(&encoded);
    let frame = decoder.next_frame().unwrap().expect("frame expected");

    match frame {
        BinaryStreamDecodedFrame::Event(decoded_event) => {
            assert_eq!(decoded_event, event);
        }
        _ => panic!("expected event frame"),
    }
}

#[test]
fn test_data_frame_roundtrip_with_unicode() {
    let session_id = "term-456";
    let text = "Hello 🦀 🚀 UTF-8 world!\r\n";
    let data_bytes = text.as_bytes();
    let meta = serde_json::json!({ "seq": 42, "rawLength": data_bytes.len() });

    let encoded = encode_binary_stream_data_frame(session_id, data_bytes, Some(&meta)).unwrap();

    let mut decoder = BinaryStreamDecoder::new();
    // Simulate chunked delivery
    decoder.feed(&encoded[..3]);
    assert!(decoder.next_frame().unwrap().is_none());
    decoder.feed(&encoded[3..10]);
    assert!(decoder.next_frame().unwrap().is_none());
    decoder.feed(&encoded[10..]);

    let frame = decoder.next_frame().unwrap().expect("frame expected");

    match frame {
        BinaryStreamDecodedFrame::Data {
            session_id: sid,
            payload_meta,
            data,
        } => {
            assert_eq!(sid, session_id);
            assert_eq!(payload_meta["seq"], 42);
            assert_eq!(String::from_utf8(data).unwrap(), text);
        }
        _ => panic!("expected data frame"),
    }
}

#[test]
fn test_hello_protocol_deserialization() {
    let json_str = r#"{"type":"hello","version":1,"role":"stream","streamFraming":"binary-v1","clientId":"client-1"}"#;
    let msg: HelloMessage = serde_json::from_str(json_str).unwrap();
    assert_eq!(msg.role.as_deref(), Some("stream"));
    assert_eq!(msg.stream_framing.as_deref(), Some("binary-v1"));

    let resp = HelloResponse {
        msg_type: "hello".to_string(),
        ok: true,
        error: None,
        stream_framing: Some("binary-v1".to_string()),
        daemon_identity: Some(DaemonEndpointIdentity {
            pid: 1234,
            started_at_ms: 1000000,
            launch_nonce: "nonce-abc".to_string(),
            entry_path: None,
            app_version: Some("1.4.214".to_string()),
        }),
    };
    let resp_str = serde_json::to_string(&resp).unwrap();
    assert!(resp_str.contains("\"streamFraming\":\"binary-v1\""));
}
