use orcad::git_response_stream::*;
use serde_json::Value;
use std::time::Duration;
use tokio::sync::mpsc;

#[test]
fn test_base64_rfc4648_test_vectors() {
    assert_eq!(to_standard_base64(b""), "");
    assert_eq!(to_standard_base64(b"f"), "Zg==");
    assert_eq!(to_standard_base64(b"fo"), "Zm8=");
    assert_eq!(to_standard_base64(b"foo"), "Zm9v");
    assert_eq!(to_standard_base64(b"foob"), "Zm9vYg==");
    assert_eq!(to_standard_base64(b"fooba"), "Zm9vYmE=");
    assert_eq!(to_standard_base64(b"foobar"), "Zm9vYmFy");

    assert_eq!(from_standard_base64("").unwrap(), b"");
    assert_eq!(from_standard_base64("Zg==").unwrap(), b"f");
    assert_eq!(from_standard_base64("Zm8=").unwrap(), b"fo");
    assert_eq!(from_standard_base64("Zm9v").unwrap(), b"foo");
    assert_eq!(from_standard_base64("Zm9vYg==").unwrap(), b"foob");
    assert_eq!(from_standard_base64("Zm9vYmE=").unwrap(), b"fooba");
    assert_eq!(from_standard_base64("Zm9vYmFy").unwrap(), b"foobar");
}

#[test]
fn test_base64_arbitrary_binary_roundtrip() {
    // Test all 256 byte values
    let all_bytes: Vec<u8> = (0..=255).collect();
    let encoded = to_standard_base64(&all_bytes);
    let decoded = from_standard_base64(&encoded).expect("decode should succeed");
    assert_eq!(decoded, all_bytes);

    // Test buffer with length not multiple of 3
    let sample =
        b"Orca Daemon Git Response Streaming Protocol with Backpressure 1234567890!@#$%^&*()_+";
    let enc = to_standard_base64(sample);
    let dec = from_standard_base64(&enc).expect("decode should succeed");
    assert_eq!(&dec, sample);
}

#[test]
fn test_chunking_and_threshold_logic() {
    assert!(!should_stream_response(100 * 1024, false));
    assert!(!should_stream_response(100 * 1024, true));
    assert!(!should_stream_response(256 * 1024, true));
    assert!(!should_stream_response(500 * 1024, false));
    assert!(should_stream_response(256 * 1024 + 1, true));
    assert!(should_stream_response(1024 * 1024, true));

    // Test encoding chunks
    let small_payload = vec![b'x'; 50 * 1024];
    let chunks = encode_chunks(&small_payload, GIT_RESPONSE_CHUNK_SIZE);
    assert_eq!(chunks.len(), 1);

    let large_payload = vec![b'a'; 300 * 1024];
    let chunks = encode_chunks(&large_payload, GIT_RESPONSE_CHUNK_SIZE);
    // 300 KB / 128 KB -> 3 chunks (128 KB + 128 KB + 44 KB)
    assert_eq!(chunks.len(), 3);
}

#[tokio::test]
async fn test_sliding_credit_window_backpressure() {
    let registry = GitResponseStreamRegistry::new();
    let (tx, mut rx) = mpsc::channel::<String>(1024);

    // Create a 1 MB payload -> 8 chunks of 128 KB
    let payload = vec![b'Z'; 8 * GIT_RESPONSE_CHUNK_SIZE];
    let marker = registry
        .start_stream(&payload, 1, tx)
        .await
        .expect("start_stream should succeed");

    assert_eq!(marker.stream_marker.stream_id, 1);
    assert_eq!(marker.stream_marker.chunk_count, 8);
    assert_eq!(
        marker.stream_marker.total_bytes,
        8 * GIT_RESPONSE_CHUNK_SIZE
    );

    // Exactly 4 chunks (seq 0, 1, 2, 3) must arrive before parking on backpressure
    let mut received_seqs = Vec::new();
    for _ in 0..4 {
        let msg = tokio::time::timeout(Duration::from_millis(500), rx.recv())
            .await
            .expect("timeout receiving chunk")
            .expect("channel closed unexpectedly");

        let val: Value = serde_json::from_str(&msg).expect("valid json");
        assert_eq!(val["method"], "git.responseChunk");
        let seq = val["params"]["seq"].as_u64().expect("seq");
        received_seqs.push(seq);
    }
    assert_eq!(received_seqs, vec![0, 1, 2, 3]);

    // Verify pump is now PARKED on backpressure (seq 4 must NOT arrive yet)
    let stalled = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await;
    assert!(
        stalled.is_err(),
        "pump should be parked on credit window limit"
    );

    // Acknowledge seq 0 -> window slides by 1, chunk 4 should arrive
    assert!(registry.record_ack(1, 0).await);

    let msg = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("timeout receiving chunk 4")
        .expect("channel closed");
    let val: Value = serde_json::from_str(&msg).expect("valid json");
    assert_eq!(val["method"], "git.responseChunk");
    assert_eq!(val["params"]["seq"], 4);

    // Chunk 5 must NOT arrive yet (acked is 0, seq 5 - 0 = 5 > 4)
    let stalled = tokio::time::timeout(Duration::from_millis(100), rx.recv()).await;
    assert!(
        stalled.is_err(),
        "pump should still be parked on credit limit"
    );

    // Acknowledge seq 1 -> chunk 5 arrives
    assert!(registry.record_ack(1, 1).await);
    let msg = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("timeout receiving chunk 5")
        .expect("channel closed");
    let val: Value = serde_json::from_str(&msg).expect("valid json");
    assert_eq!(val["params"]["seq"], 5);

    // Send cumulative ACK for seq 5 -> chunks 6 and 7 arrive, then git.responseEnd
    assert!(registry.record_ack(1, 5).await);

    let msg6 = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("chunk 6")
        .unwrap();
    let val6: Value = serde_json::from_str(&msg6).unwrap();
    assert_eq!(val6["params"]["seq"], 6);

    let msg7 = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("chunk 7")
        .unwrap();
    let val7: Value = serde_json::from_str(&msg7).unwrap();
    assert_eq!(val7["params"]["seq"], 7);

    // Final frame is git.responseEnd
    let end_msg = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("responseEnd")
        .unwrap();
    let end_val: Value = serde_json::from_str(&end_msg).unwrap();
    assert_eq!(end_val["method"], "git.responseEnd");
    assert_eq!(end_val["params"]["streamId"], 1);

    // Stream should be removed from registry
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(registry.active_streams_count().await, 0);
}

#[tokio::test]
async fn test_end_to_end_streaming_and_reassembly_integrity() {
    let registry = GitResponseStreamRegistry::new();
    let (tx, mut rx) = mpsc::channel::<String>(1024);

    // Generate arbitrary pseudo-realistic git log payload (512 KB)
    let mut original_data = Vec::with_capacity(512 * 1024);
    for i in 0..(512 * 1024) {
        original_data.push(((i * 31 + 17) % 256) as u8);
    }

    let marker = registry
        .start_stream(&original_data, 42, tx)
        .await
        .expect("stream started");

    let stream_id = marker.stream_marker.stream_id;
    let expected_chunks = marker.stream_marker.chunk_count;
    assert_eq!(expected_chunks, 4);

    let mut reassembled_bytes = Vec::new();

    for expected_seq in 0..expected_chunks {
        let msg = tokio::time::timeout(Duration::from_millis(1000), rx.recv())
            .await
            .expect("timeout")
            .expect("channel open");

        let val: Value = serde_json::from_str(&msg).expect("json");
        assert_eq!(val["method"], "git.responseChunk");
        let sid = val["params"]["streamId"].as_u64().unwrap();
        let seq = val["params"]["seq"].as_u64().unwrap();
        let data = val["params"]["data"].as_str().unwrap();

        assert_eq!(sid, stream_id);
        assert_eq!(seq, expected_seq as u64);

        let decoded = from_standard_base64(data).expect("base64 decode");
        reassembled_bytes.extend_from_slice(&decoded);

        // Client sends ACK
        let _ = registry.record_ack(stream_id, seq).await;
    }

    let end_msg = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("timeout")
        .expect("channel open");
    let end_val: Value = serde_json::from_str(&end_msg).unwrap();
    assert_eq!(end_val["method"], "git.responseEnd");
    assert_eq!(end_val["params"]["streamId"], stream_id);

    // Verify 100% byte-for-byte fidelity
    assert_eq!(reassembled_bytes.len(), original_data.len());
    assert_eq!(reassembled_bytes, original_data);

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(registry.active_streams_count().await, 0);
}

#[tokio::test]
async fn test_client_cancellation_abort() {
    let registry = GitResponseStreamRegistry::new();
    let (tx, mut rx) = mpsc::channel::<String>(1024);

    let payload = vec![b'C'; 10 * GIT_RESPONSE_CHUNK_SIZE];
    let marker = registry
        .start_stream(&payload, 99, tx)
        .await
        .expect("stream started");

    let stream_id = marker.stream_marker.stream_id;

    // Read first chunk
    let msg = tokio::time::timeout(Duration::from_millis(500), rx.recv())
        .await
        .expect("timeout")
        .expect("msg");
    let val: Value = serde_json::from_str(&msg).unwrap();
    assert_eq!(val["params"]["seq"], 0);

    // Client aborts the stream
    assert!(registry.abort(stream_id).await);

    // Verify pump halts: no git.responseEnd, no further chunks beyond in-flight buffer
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(registry.active_streams_count().await, 0);
}

#[tokio::test]
async fn test_client_disconnect_wakeup() {
    let registry = GitResponseStreamRegistry::new();
    let (tx, rx) = mpsc::channel::<String>(1024);

    let payload = vec![b'D'; 8 * GIT_RESPONSE_CHUNK_SIZE];
    let marker = registry
        .start_stream(&payload, 101, tx)
        .await
        .expect("stream started");
    let stream_id = marker.stream_marker.stream_id;

    // Client disconnects by dropping rx
    drop(rx);

    // Trigger disconnect wakeup
    registry.wake_all().await;

    // Pump must exit cleanly when detecting channel disconnection
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(registry.active_streams_count().await, 0);
    assert!(!registry.has_stream(stream_id).await);
}

#[tokio::test]
async fn test_stall_recheck_timeout() {
    // Registry with 50ms stall recheck and 2-chunk window
    let registry = GitResponseStreamRegistry::with_config(50, 2);
    let (tx, mut rx) = mpsc::channel::<String>(1024);

    let payload = vec![b'S'; 4 * GIT_RESPONSE_CHUNK_SIZE];
    let marker = registry
        .start_stream(&payload, 55, tx)
        .await
        .expect("stream started");
    let stream_id = marker.stream_marker.stream_id;

    // Read 2 chunks (window size = 2)
    let _ = rx.recv().await.unwrap();
    let _ = rx.recv().await.unwrap();

    // Pump is now parked. Let 3 stall recheck intervals (150ms) expire without ACK
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(registry.has_stream(stream_id).await);

    // Now send ACK, verifying the pump unparks and completes
    registry.record_ack(stream_id, 1).await;

    let _ = rx.recv().await.unwrap();
    let _ = rx.recv().await.unwrap();
    let end_msg = rx.recv().await.unwrap();
    let end_val: Value = serde_json::from_str(&end_msg).unwrap();
    assert_eq!(end_val["method"], "git.responseEnd");
}

#[tokio::test]
async fn test_out_of_order_and_duplicate_acks() {
    let registry = GitResponseStreamRegistry::new();
    let (tx, _rx) = mpsc::channel::<String>(1024);

    let payload = vec![b'O'; 8 * GIT_RESPONSE_CHUNK_SIZE];
    let marker = registry
        .start_stream(&payload, 77, tx)
        .await
        .expect("stream started");
    let stream_id = marker.stream_marker.stream_id;

    // Initial acked through seq is -1
    assert_eq!(registry.acked_through_seq(stream_id).await, Some(-1));

    // Jump to seq 3
    assert!(registry.record_ack(stream_id, 3).await);
    assert_eq!(registry.acked_through_seq(stream_id).await, Some(3));

    // Stale ACK for seq 1 should not regress seq 3
    assert!(registry.record_ack(stream_id, 1).await);
    assert_eq!(registry.acked_through_seq(stream_id).await, Some(3));

    // Advance to seq 5
    assert!(registry.record_ack(stream_id, 5).await);
    assert_eq!(registry.acked_through_seq(stream_id).await, Some(5));

    // Clean up
    registry.abort(stream_id).await;
}

#[tokio::test]
async fn test_registry_disposal_and_reopen() {
    let registry = GitResponseStreamRegistry::new();
    let (tx, _rx) = mpsc::channel::<String>(1024);

    let payload = vec![b'X'; 4 * GIT_RESPONSE_CHUNK_SIZE];
    let _marker = registry
        .start_stream(&payload, 88, tx.clone())
        .await
        .expect("started");

    assert_eq!(registry.active_streams_count().await, 1);
    assert!(!registry.is_disposed());

    // Dispose
    registry.dispose_all().await;
    assert!(registry.is_disposed());

    // Creating stream on disposed registry fails
    let err = registry.start_stream(&payload, 88, tx.clone()).await;
    assert!(err.is_err());
    assert_eq!(err.unwrap_err(), "git_response_stream_disposed");

    // Reopen
    registry.reopen();
    assert!(!registry.is_disposed());

    let marker2 = registry.start_stream(&payload, 88, tx).await;
    assert!(marker2.is_ok());
}
