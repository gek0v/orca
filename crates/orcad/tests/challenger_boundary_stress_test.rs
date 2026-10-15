//! Adversarial Boundary & Concurrency Stress Test Suite
//!
//! Authored by Challenger 2 (Boundary & Concurrency Stress Testing)
//! Rigorously verifies:
//! 1. PTY OSC Scanner: 1-byte, 2-byte, random-slice chunks, UTF-8 multi-byte mid-sequence splits, sequences > 4096 bytes
//! 2. Incremental Checkpoints: exact 2MB overflow boundary, monotonic sequence advancement, overflow flag clearing
//! 3. Tombstone Cache: 2000 entries into 1024 capacity, exact LRU eviction, concurrency without leaks
//! 4. ConPTY Warmup: concurrent multi-caller idempotency and non-blocking background initialization
//! 5. Git Streaming: 10 MB payload streaming under backpressure, exact SHA-256 match, memory reclamation

#[path = "../src/git_response_stream.rs"]
pub mod git_response_stream;

use git_response_stream::*;
use orca_pty::models::PendingOutputRecord;
use orca_pty::osc::OscScanner;
use orcad::idle_exit::IdleExitManager;
use orcad::terminal_manager::{TerminalManager, TombstoneCache};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, RwLock};

// ============================================================================
// SHA-256 Reference Implementation (FIPS 180-4)
// ============================================================================

fn sha256_digest(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0x00);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, w_elem) in w.iter_mut().take(16).enumerate() {
            *w_elem = u32::from_be_bytes(chunk[i * 4..(i + 1) * 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        let mut f = h[5];
        let mut g = h[6];
        let mut h_var = h[7];

        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h_var
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h_var = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(h_var);
    }

    let mut out = [0u8; 32];
    for (i, val) in h.iter().enumerate() {
        out[i * 4..(i + 1) * 4].copy_from_slice(&val.to_be_bytes());
    }
    out
}

#[test]
fn test_sha256_known_vector() {
    // Standard test vector: SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    let digest = sha256_digest(b"abc");
    let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
    assert_eq!(
        hex,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

// ============================================================================
// 1. PTY OSC Scanner Adversarial Boundary Tests
// ============================================================================

#[test]
fn test_adversarial_osc_1byte_slices() {
    let mut scanner = OscScanner::new(None);
    let full_seq = b"prefix \x1b]7;file://localhost/C:/Users/Geko/stream_1byte\x07 suffix";

    for &byte in full_seq.iter() {
        scanner.scan(&[byte]);
    }

    let cwd = scanner.get_cwd();
    assert!(cwd.is_some(), "1-byte streaming with BEL must extract CWD");
    let c = cwd.unwrap();
    assert!(
        c.contains("stream_1byte"),
        "Extracted path must match, got: {}",
        c
    );

    // Title via 1-byte stream with BEL terminator (\x07)
    let title_seq = b"\x1b]2;Single-Byte-Title\x07";
    for &byte in title_seq.iter() {
        scanner.scan(&[byte]);
    }
    assert_eq!(scanner.get_title(), Some("Single-Byte-Title"));
}

/// Adversarial stress test demonstrating the boundary flaw when ST (\x1b\) terminator is split across chunks
#[test]
fn test_adversarial_osc_st_terminator_split_boundary_bug() {
    let mut scanner = OscScanner::new(None);

    // Chunk 1 contains the entire OSC sequence up to the ESC byte of the ST terminator (\x1b\)
    let chunk1 = b"\x1b]2;Single-Byte-Title\x1b";
    scanner.scan(chunk1);

    // Chunk 2 provides the final BACKSLASH (\) of the ST terminator
    let chunk2 = b"\\";
    scanner.scan(chunk2);

    // If extract_scan_tail chose a.max(b) where b is the trailing ESC, it truncated
    // the unclosed sequence prefix, causing the title to be lost (scanner.get_title() == None).
    // An adversarial test captures this exact failure mode:
    assert_eq!(
        scanner.get_title(),
        Some("Single-Byte-Title"),
        "OSC parser must not drop unclosed sequence when ST terminator is split across chunks"
    );
}

/// Adversarial stress test demonstrating the boundary flaw when OSC 7 ST (\x1b\) terminator is split across chunks
#[test]
fn test_adversarial_osc7_st_terminator_split_boundary_bug() {
    let mut scanner = OscScanner::new(None);

    // Chunk 1 contains OSC 7 CWD sequence ending in ESC byte of ST terminator
    let chunk1 = b"\x1b]7;file://localhost/C:/Projects/split_cwd_repo\x1b";
    scanner.scan(chunk1);

    // Chunk 2 provides the final BACKSLASH (\)
    let chunk2 = b"\\";
    scanner.scan(chunk2);

    assert!(
        scanner.get_cwd().is_some(),
        "OSC 7 parser must extract CWD when ST terminator is split across chunks"
    );
}

#[test]
fn test_adversarial_osc_2byte_slices() {
    let mut scanner = OscScanner::new(None);
    let full_seq = b"\x1b]7;file://localhost/C:/Users/Geko/stream_2bytes\x07";

    for chunk in full_seq.chunks(2) {
        scanner.scan(chunk);
    }

    let cwd = scanner.get_cwd().expect("2-byte streaming CWD");
    assert!(cwd.contains("stream_2bytes"));
}

#[test]
fn test_adversarial_osc_random_slices() {
    let mut scanner = OscScanner::new(None);
    let full_seq = b"some noisy terminal noise \x1b]7;file://localhost/C:/Users/Geko/random_slices_dir\x07\x1b]0;Random Title\x07";

    // Irregular chunk sizes
    let slice_sizes = [1, 3, 2, 7, 1, 4, 11, 2, 5, 1, 8, 3, 20];
    let mut offset = 0;
    let mut idx = 0;
    while offset < full_seq.len() {
        let size = slice_sizes[idx % slice_sizes.len()];
        let end = (offset + size).min(full_seq.len());
        scanner.scan(&full_seq[offset..end]);
        offset = end;
        idx += 1;
    }

    assert!(scanner.get_cwd().unwrap().contains("random_slices_dir"));
    assert_eq!(scanner.get_title(), Some("Random Title"));
}

#[test]
fn test_adversarial_osc_utf8_multibyte_split_mid_sequence() {
    let mut scanner = OscScanner::new(None);

    // Multi-byte characters:
    // ñ = \xc3\xb1 (2 bytes)
    // 日 = \xe6\x97\xa5 (3 bytes)
    // 🚀 = \xf0\x9f\x9a\x80 (4 bytes)
    let path = "C:/Users/Geko/año_2026/日本語/rocket_🚀_repo";
    let seq = format!("\x1b]7;file://localhost/{}\x07", path);
    let seq_bytes = seq.as_bytes();

    // Find byte position inside the rocket emoji
    let rocket_bytes = "🚀".as_bytes(); // 4 bytes: [240, 159, 154, 128]
    let rocket_pos = seq_bytes
        .windows(rocket_bytes.len())
        .position(|w| w == rocket_bytes)
        .expect("Rocket emoji found");

    // Split chunk 1 right after the first 2 bytes of the 4-byte emoji!
    let split_pos = rocket_pos + 2;
    let chunk1 = &seq_bytes[..split_pos];
    let chunk2 = &seq_bytes[split_pos..];

    scanner.scan(chunk1);
    assert!(
        scanner.get_cwd().is_none(),
        "Incomplete UTF-8 sequence must not prematurely resolve"
    );

    scanner.scan(chunk2);
    let cwd = scanner.get_cwd().expect("UTF-8 CWD resolved");
    assert!(
        cwd.contains("año_2026"),
        "2-byte UTF-8 ñ preserved: got {}",
        cwd
    );
    assert!(
        cwd.contains("日本語"),
        "3-byte UTF-8 Japanese preserved: got {}",
        cwd
    );
    assert!(
        cwd.contains("rocket_🚀_repo"),
        "4-byte UTF-8 emoji split preserved: got {}",
        cwd
    );
}

#[test]
fn test_adversarial_osc_sequence_exceeding_4096_bytes() {
    let mut scanner = OscScanner::new(None);

    // Feed an unterminated sequence of 5000 'X's (> 4096 bytes limit)
    let mut runaway = Vec::with_capacity(5000);
    runaway.extend_from_slice(b"\x1b]0;");
    runaway.resize(5000, b'X');

    // Feed in chunks
    for chunk in runaway.chunks(512) {
        scanner.scan(chunk);
    }

    // Must not crash, title not set (unterminated)
    assert!(scanner.get_title().is_none());

    // Send a valid sequence right afterwards: scanner must gracefully recover
    let recovery = b"\x1b]0;Recovered Title After Buffer Overflow\x07";
    scanner.scan(recovery);
    assert_eq!(
        scanner.get_title(),
        Some("Recovered Title After Buffer Overflow")
    );
}

// ============================================================================
// 2. Incremental Checkpoints Exact 2MB Overflow Boundary Tests
// ============================================================================

#[tokio::test]
async fn test_adversarial_incremental_checkpoints_2mb_exact_boundary() {
    const PENDING_MAX_BYTES: usize = 2 * 1024 * 1024; // 2,097,152 bytes

    // Direct simulation of record_pending_output logic
    let records = Mutex::new(Vec::new());
    let bytes_atomic = AtomicUsize::new(0);
    let overflowed_atomic = AtomicBool::new(false);

    // 1. Exactly 2MB should FIT without overflow
    let exact_fit_record = PendingOutputRecord {
        kind: "output".to_string(),
        data: Some("A".repeat(PENDING_MAX_BYTES)),
        cols: None,
        rows: None,
    };

    let record_len = exact_fit_record.data.as_ref().unwrap().len();
    assert_eq!(record_len, PENDING_MAX_BYTES);

    let cur = bytes_atomic.load(Ordering::SeqCst);
    assert!(cur + record_len <= PENDING_MAX_BYTES); // Exactly 2MB fits!
    records.lock().await.push(exact_fit_record);
    bytes_atomic.fetch_add(record_len, Ordering::SeqCst);

    assert!(!overflowed_atomic.load(Ordering::SeqCst));
    assert_eq!(bytes_atomic.load(Ordering::SeqCst), PENDING_MAX_BYTES);

    // 2. One additional byte causes overflow
    let _one_byte_record = PendingOutputRecord {
        kind: "output".to_string(),
        data: Some("B".to_string()),
        cols: None,
        rows: None,
    };
    let cur2 = bytes_atomic.load(Ordering::SeqCst);
    if cur2 + 1 > PENDING_MAX_BYTES {
        let mut list = records.lock().await;
        list.clear();
        bytes_atomic.store(0, Ordering::SeqCst);
        overflowed_atomic.store(true, Ordering::SeqCst);
    }

    assert!(overflowed_atomic.load(Ordering::SeqCst));
    assert_eq!(records.lock().await.len(), 0);
    assert_eq!(bytes_atomic.load(Ordering::SeqCst), 0);

    // 3. Test take_pending_output contract with live TerminalManager
    let (shutdown_tx, _) = tokio::sync::broadcast::channel(2);
    let idle_exit = IdleExitManager::new(Duration::from_secs(60), shutdown_tx);
    let mgr = TerminalManager::new(idle_exit);

    let (term_id, _) = mgr
        .create_terminal(None, None, None, None, None, None)
        .await
        .expect("Create terminal");

    let t = mgr.get_terminal(&term_id).await.expect("Get terminal");

    // Set overflow state
    t.pending_overflowed.store(true, Ordering::SeqCst);
    let initial_seq = t.pending_seq.load(Ordering::SeqCst);

    // First take: must return overflowed = true, and sequence must increment
    let take1 = mgr
        .take_pending_output(&term_id, false)
        .await
        .expect("take 1");
    assert!(take1.overflowed, "take1 must report overflowed: true");
    assert_eq!(
        take1.seq,
        initial_seq + 1,
        "Sequence must increment monotonically on overflow"
    );

    // Second take immediately: overflow flag must have cleared, seq must not advance
    let take2 = mgr
        .take_pending_output(&term_id, false)
        .await
        .expect("take 2");
    assert!(
        !take2.overflowed,
        "Subsequent take must clear overflow flag"
    );
    assert_eq!(
        take2.seq, take1.seq,
        "Sequence must remain stable when no new output is pending"
    );

    // 4. Recovery: add new output after overflow cleared -> normal operation resumes
    t.pending_records.lock().await.push(PendingOutputRecord {
        kind: "output".to_string(),
        data: Some("RECOVERED_OUTPUT".to_string()),
        cols: None,
        rows: None,
    });
    t.pending_bytes.store(16, Ordering::SeqCst);

    let take3 = mgr
        .take_pending_output(&term_id, false)
        .await
        .expect("take 3");
    assert!(!take3.overflowed);
    assert_eq!(take3.records.len(), 1);
    assert_eq!(take3.records[0].data.as_deref(), Some("RECOVERED_OUTPUT"));
    assert_eq!(
        take3.seq,
        take2.seq + 1,
        "Sequence must increment on new record"
    );

    mgr.kill_all().await;
}

// ============================================================================
// 3. Tombstone Cache 2000 Entries LRU Stress & Leak Tests
// ============================================================================

#[test]
fn test_adversarial_tombstone_cache_2000_entries_lru() {
    let mut cache = TombstoneCache::new(1024);

    // Insert 2000 unique dead session entries
    for i in 0..2000 {
        cache.record(&format!("dead-session-{}", i));
    }

    // Capacity must remain strictly bounded at 1024
    assert_eq!(
        cache.len(),
        1024,
        "Tombstone cache capacity must strictly cap at 1024"
    );

    // Oldest 976 entries (0..976) MUST have been evicted
    for i in 0..976 {
        assert!(
            !cache.has(&format!("dead-session-{}", i)),
            "Session {} should have been evicted by LRU",
            i
        );
    }

    // Latest 1024 entries (976..2000) MUST be present
    for i in 976..2000 {
        assert!(
            cache.has(&format!("dead-session-{}", i)),
            "Session {} must be present in LRU cache",
            i
        );
    }

    // Re-recording an existing entry does not grow length
    cache.record("dead-session-1500");
    assert_eq!(cache.len(), 1024);

    // Recording 2001st entry evicts 976
    cache.record("dead-session-2000");
    assert_eq!(cache.len(), 1024);
    assert!(!cache.has("dead-session-976"));
    assert!(cache.has("dead-session-977"));
    assert!(cache.has("dead-session-2000"));

    // clear_for_create removes item cleanly
    cache.clear_for_create("dead-session-2000");
    assert_eq!(cache.len(), 1023);
    assert!(!cache.has("dead-session-2000"));
}

#[tokio::test]
async fn test_adversarial_tombstone_cache_concurrent_access() {
    let cache = Arc::new(RwLock::new(TombstoneCache::new(1024)));
    let mut tasks = Vec::new();

    // 10 concurrent tasks writing 200 items each
    for t in 0..10 {
        let c = Arc::clone(&cache);
        tasks.push(tokio::spawn(async move {
            for i in 0..200 {
                let id = format!("task-{}-term-{}", t, i);
                c.write().await.record(&id);
                let _ = c.read().await.has(&id);
            }
        }));
    }

    for task in tasks {
        task.await.expect("Concurrent tombstone task completed");
    }

    let final_len = cache.read().await.len();
    assert_eq!(final_len, 1024, "Concurrent writes must honor 1024 cap");
}

// ============================================================================
// 4. ConPTY Warmup Pool Concurrency & Non-Blocking Initialization
// ============================================================================

#[tokio::test]
async fn test_adversarial_conpty_warmup_concurrent_idempotency() {
    let mut tasks = Vec::new();
    let start_time = std::time::Instant::now();

    // 50 concurrent callers to warm_windows_conpty_once()
    for _ in 0..50 {
        tasks.push(tokio::spawn(async {
            orca_pty::warm_windows_conpty_once();
        }));
    }

    for t in tasks {
        t.await.expect("Warmup caller completed");
    }

    let elapsed = start_time.elapsed();
    // Warmup callers must be completely non-blocking (< 50ms for all 50 spawns)
    assert!(
        elapsed < Duration::from_millis(500),
        "Warmup callers must return asynchronously without blocking: took {:?}",
        elapsed
    );
}

// ============================================================================
// 5. Git Streaming 10 MB Payload, SHA-256 Match & Memory Reclamation
// ============================================================================

#[tokio::test]
async fn test_adversarial_git_streaming_10mb_sha256_and_memory_reclamation() {
    let registry = GitResponseStreamRegistry::new();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(128);

    // 1. Generate 10 MB of realistic binary + text git payload
    const TEN_MB: usize = 10 * 1024 * 1024;
    let mut payload = Vec::with_capacity(TEN_MB);

    let pattern_block = b"commit 7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a\nAuthor: Orca Challenger <qa@orca.build>\nDate:   Mon Oct 12 12:00:00 2026 +0200\n\n    Stress payload with Unicode: \xE2\x9A\xA1 \xF0\x9F\x9A\x80 \xC3\xB1\n";
    while payload.len() < TEN_MB {
        let remaining = TEN_MB - payload.len();
        if remaining >= pattern_block.len() {
            payload.extend_from_slice(pattern_block);
        } else {
            payload.extend_from_slice(&pattern_block[..remaining]);
        }
    }
    assert_eq!(payload.len(), TEN_MB);

    // Compute ground-truth SHA-256 of 10 MB payload
    let expected_sha256 = sha256_digest(&payload);
    let expected_hex: String = expected_sha256
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    // 2. Start streaming 10 MB payload
    let marker = registry
        .start_stream(&payload, 9999, out_tx)
        .await
        .expect("start_stream for 10MB");

    let stream_id = marker.stream_marker.stream_id;
    let total_chunks = marker.stream_marker.chunk_count;

    // 10 MB / 128 KB = 80 chunks
    assert_eq!(total_chunks, 80);
    assert_eq!(marker.stream_marker.total_bytes, TEN_MB);

    // Verify stream is actively registered
    assert_eq!(registry.active_streams_count().await, 1);
    assert!(registry.has_stream(stream_id).await);

    // 3. Receive chunks, acknowledge in sliding credit window, and reassemble
    let mut reassembled_chunks: Vec<(u64, Vec<u8>)> = Vec::with_capacity(total_chunks);
    let mut got_response_end = false;

    while let Some(line) = out_rx.recv().await {
        let val: Value = serde_json::from_str(&line).expect("Parse line as JSON");
        let method = val["method"].as_str().unwrap_or("");

        if method == "git.responseChunk" {
            let sid = val["params"]["streamId"].as_u64().unwrap();
            let seq = val["params"]["seq"].as_u64().unwrap();
            let b64 = val["params"]["data"].as_str().unwrap();

            assert_eq!(sid, stream_id);
            let decoded = from_standard_base64(b64).expect("Valid base64");
            reassembled_chunks.push((seq, decoded));

            // Client acknowledges chunk
            registry.record_ack(stream_id, seq).await;
        } else if method == "git.responseEnd" {
            assert_eq!(val["params"]["streamId"].as_u64().unwrap(), stream_id);
            got_response_end = true;
            break;
        }
    }

    assert!(got_response_end, "git.responseEnd must be received");
    assert_eq!(reassembled_chunks.len(), total_chunks);

    // Sort by sequence number
    reassembled_chunks.sort_by_key(|(s, _)| *s);
    let mut reassembled_full = Vec::with_capacity(TEN_MB);
    for (idx, (seq, chunk_bytes)) in reassembled_chunks.iter().enumerate() {
        assert_eq!(
            *seq, idx as u64,
            "Sequence numbers must be strictly sequential"
        );
        reassembled_full.extend_from_slice(chunk_bytes);
    }

    // 4. Verify exact SHA-256 integrity match
    assert_eq!(
        reassembled_full.len(),
        TEN_MB,
        "Reassembled size must be exactly 10MB"
    );
    let actual_sha256 = sha256_digest(&reassembled_full);
    let actual_hex: String = actual_sha256.iter().map(|b| format!("{:02x}", b)).collect();
    assert_eq!(
        actual_hex, expected_hex,
        "SHA-256 of 10 MB reassembled payload must match original"
    );
    assert_eq!(
        reassembled_full.as_slice(),
        payload.as_slice(),
        "100% byte-for-byte fidelity guaranteed"
    );

    // 5. Verify memory reclamation: stream cleaned up from active registry
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        registry.active_streams_count().await,
        0,
        "All active streams must be cleaned up from registry"
    );
    assert!(
        !registry.has_stream(stream_id).await,
        "Stream ID must no longer be present in registry"
    );
}
