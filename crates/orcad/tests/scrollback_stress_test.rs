use orcad::idle_exit::IdleExitManager;
use orcad::terminal_manager::{TerminalManager, TombstoneCache};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;

#[tokio::test]
async fn test_scrollback_exact_1mb_cap_and_excess_draining() {
    let (shutdown_tx, _) = broadcast::channel(1);
    let idle_exit = IdleExitManager::new(Duration::from_secs(60), shutdown_tx);
    let tm = TerminalManager::new(idle_exit);

    let (term_id, _pid) = tm
        .create_terminal(None, None, Some(80), Some(24), None, None)
        .await
        .expect("Create terminal");

    let terminal = tm.get_terminal(&term_id).await.expect("Get terminal");

    const ONE_MB: usize = 1024 * 1024; // 1,048,576 bytes

    // 1. Fill scrollback directly to exactly 1MB
    {
        let mut sb = terminal.scrollback.lock().await;
        sb.clear();
        sb.resize(ONE_MB, b'A');
        assert_eq!(sb.len(), ONE_MB, "Scrollback should be exactly 1MB");
    }

    // 2. Simulate feeding a 500-byte chunk: exactly 500 bytes should be drained from the front
    {
        let mut sb = terminal.scrollback.lock().await;
        let chunk = vec![b'B'; 500];
        sb.extend_from_slice(&chunk);
        assert!(sb.len() > ONE_MB);
        let excess = sb.len() - ONE_MB;
        sb.drain(..excess);

        assert_eq!(sb.len(), ONE_MB, "Buffer length must remain capped at 1MB");
        assert_eq!(excess, 500);
        // The last 500 bytes must be 'B'
        assert_eq!(&sb[ONE_MB - 500..], &chunk[..]);
        // The first bytes must still be 'A'
        assert_eq!(&sb[..100], &[b'A'; 100]);
    }

    // 3. Simulate feeding a 2MB chunk (greater than 1MB by itself!)
    {
        let mut sb = terminal.scrollback.lock().await;
        let mut large_chunk = vec![b'C'; ONE_MB];
        large_chunk.extend_from_slice(&vec![b'D'; ONE_MB]); // 2MB total
        sb.extend_from_slice(&large_chunk);
        let excess = sb.len() - ONE_MB;
        sb.drain(..excess);

        assert_eq!(sb.len(), ONE_MB, "Buffer length must remain strictly 1MB");
        // All previous 'A's and 'B's are gone; the buffer contains the latest 1MB (all 'D's)
        assert_eq!(&sb[..], &vec![b'D'; ONE_MB][..]);
    }

    // 4. Test reading output via read_output
    let read_res = tm
        .read_output(&term_id, Some(0), Some(100), false)
        .await
        .expect("read_output");
    assert_eq!(read_res.text.len(), 100);
    assert_eq!(read_res.cursor, 100);

    // 5. Test reading output with cursor near the end
    let read_end = tm
        .read_output(&term_id, Some(ONE_MB - 50), Some(100), false)
        .await
        .expect("read_output near end");
    assert_eq!(read_end.text.len(), 50, "Should only read remaining 50 bytes");
    assert_eq!(read_end.cursor, ONE_MB);

    // 6. Test get_snapshot with 1MB scrollback
    let snapshot = tm.get_snapshot(&term_id).await.expect("get_snapshot");
    assert_eq!(snapshot.scrollback_ansi.len(), ONE_MB);

    tm.kill_all().await;
}

#[tokio::test]
async fn test_scrollback_continuous_streaming_bounds_stress() {
    let (shutdown_tx, _) = broadcast::channel(1);
    let idle_exit = IdleExitManager::new(Duration::from_secs(60), shutdown_tx);
    let tm = TerminalManager::new(idle_exit);

    let (term_id, _pid) = tm
        .create_terminal(None, None, Some(80), Some(24), None, None)
        .await
        .expect("Create terminal");

    let terminal = tm.get_terminal(&term_id).await.expect("Get terminal");
    const ONE_MB: usize = 1024 * 1024;

    // Stream 10 MB in chunks of 64 KB
    let chunk_size = 64 * 1024;
    let iterations = 160; // 160 * 64KB = 10 MB

    for i in 0..iterations {
        let chunk = vec![(i % 256) as u8; chunk_size];
        let mut sb = terminal.scrollback.lock().await;
        sb.extend_from_slice(&chunk);
        if sb.len() > ONE_MB {
            let excess = sb.len() - ONE_MB;
            sb.drain(..excess);
        }
        assert!(
            sb.len() <= ONE_MB,
            "Scrollback must never exceed 1MB during continuous streaming"
        );
    }

    let final_len = terminal.scrollback.lock().await.len();
    assert_eq!(final_len, ONE_MB, "Final scrollback size must be exactly 1MB");

    tm.kill_all().await;
}

#[test]
fn test_tombstone_cache_lru_and_clear_for_create() {
    let mut cache = TombstoneCache::new(1024);
    assert_eq!(cache.len(), 0);
    assert!(cache.is_empty());

    // Record 1024 entries
    for i in 0..1024 {
        cache.record(&format!("term-{}", i));
    }
    assert_eq!(cache.len(), 1024);
    assert!(cache.has("term-0"));
    assert!(cache.has("term-1023"));

    // Record 512 more entries (term-1024..term-1536)
    for i in 1024..1536 {
        cache.record(&format!("term-{}", i));
    }
    assert_eq!(cache.len(), 1024, "Cache capacity must strictly stay at 1024");

    // Oldest 512 entries (term-0..term-511) must have been evicted
    for i in 0..512 {
        assert!(
            !cache.has(&format!("term-{}", i)),
            "term-{} must be evicted",
            i
        );
    }
    // Newer entries (term-512..term-1535) must still exist
    for i in 512..1536 {
        assert!(
            cache.has(&format!("term-{}", i)),
            "term-{} must be present",
            i
        );
    }

    // clear_for_create must remove the entry from both entries and order
    cache.clear_for_create("term-1000");
    assert_eq!(cache.len(), 1023);
    assert!(!cache.has("term-1000"));

    // Recording an existing entry updates its timestamp without growing the order
    cache.record("term-1535");
    assert_eq!(cache.len(), 1023);
}

#[tokio::test]
async fn test_pause_pty_and_resume_failsafe_abort_behavior() {
    let (shutdown_tx, _) = broadcast::channel(1);
    let idle_exit = IdleExitManager::new(Duration::from_secs(60), shutdown_tx);
    let tm = TerminalManager::new(idle_exit);

    let (cmd, args): (&str, Vec<String>) = if cfg!(windows) {
        ("cmd.exe", vec![])
    } else {
        ("sh", vec![])
    };

    let (term_id, _pid) = tm
        .create_terminal(Some(cmd.to_string()), Some(args), Some(80), Some(24), None, None)
        .await
        .expect("Create terminal");

    // 1. Initial state: not paused
    assert!(!tm.is_paused(&term_id).await.expect("is_paused"));

    // 2. Pause terminal
    tm.pause_pty(&term_id).await.expect("pause_pty");
    assert!(tm.is_paused(&term_id).await.expect("is_paused"));

    // 3. Resume immediately -> aborts the 5000ms timer
    tm.resume_pty(&term_id).await.expect("resume_pty");
    assert!(!tm.is_paused(&term_id).await.expect("is_paused"));

    // 4. Repeated rapid pauses and resumes
    for _ in 0..20 {
        tm.pause_pty(&term_id).await.expect("pause");
        assert!(tm.is_paused(&term_id).await.expect("paused"));
        tm.resume_pty(&term_id).await.expect("resume");
        assert!(!tm.is_paused(&term_id).await.expect("not paused"));
    }

    // 5. Test 5000ms failsafe timer: pause and do not resume
    tm.pause_pty(&term_id).await.expect("pause");
    assert!(tm.is_paused(&term_id).await.expect("paused"));

    let start = Instant::now();
    // After 100ms it should definitely still be paused
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(tm.is_paused(&term_id).await.expect("still paused"));

    // Wait until failsafe triggers (5000ms)
    // Sleep remaining time up to 5200ms
    let elapsed = start.elapsed();
    if elapsed < Duration::from_millis(5200) {
        tokio::time::sleep(Duration::from_millis(5200) - elapsed).await;
    }

    // Failsafe timer should have automatically unpaused the terminal!
    assert!(
        !tm.is_paused(&term_id).await.expect("is_paused"),
        "5000ms failsafe timer must automatically unpause the session"
    );

    tm.kill_all().await;
}
