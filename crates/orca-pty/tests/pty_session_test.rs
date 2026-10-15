use orca_pty::{spawn, PtySessionConfig};

#[tokio::test]
async fn test_pty_spawn_and_read() {
    let config = if cfg!(windows) {
        PtySessionConfig::new(
            "cmd.exe",
            vec!["/c".into(), "echo ORCA_PTY_OK".into()],
            80,
            24,
        )
    } else {
        PtySessionConfig::new("sh", vec!["-c".into(), "echo ORCA_PTY_OK".into()], 80, 24)
    };

    let session = spawn(config).await.expect("PTY must spawn successfully");

    let mut output = String::new();
    while let Some(chunk) = session.next_output().await {
        output.push_str(&String::from_utf8_lossy(&chunk));
        if output.contains("ORCA_PTY_OK") {
            break;
        }
    }

    assert!(
        output.contains("ORCA_PTY_OK"),
        "Expected token in output: {}",
        output
    );
    session
        .terminate()
        .await
        .expect("PTY must terminate cleanly");
}

#[tokio::test]
async fn test_pty_interactive_input() {
    let config = if cfg!(windows) {
        PtySessionConfig::new("cmd.exe", vec![], 80, 24)
    } else {
        PtySessionConfig::new("sh", vec![], 80, 24)
    };

    let session = spawn(config).await.expect("PTY must spawn successfully");

    // Write interactive command with CRLF
    session
        .write_input(b"echo ORCA_CONPTY_INTERACTIVE_OK\r\n")
        .await
        .expect("Write input must succeed");

    let mut output = String::new();
    while let Some(chunk) = session.next_output().await {
        output.push_str(&String::from_utf8_lossy(&chunk));
        if output.contains("ORCA_CONPTY_INTERACTIVE_OK") {
            break;
        }
    }

    assert!(
        output.contains("ORCA_CONPTY_INTERACTIVE_OK"),
        "Expected token in output: {}",
        output
    );
    session
        .terminate()
        .await
        .expect("PTY must terminate cleanly");
}

#[tokio::test]
async fn test_pty_resize_and_terminate() {
    let config = if cfg!(windows) {
        PtySessionConfig::new("cmd.exe", vec![], 80, 24)
    } else {
        PtySessionConfig::new("sh", vec![], 80, 24)
    };

    let session = spawn(config).await.expect("PTY must spawn successfully");

    // Test resize
    session.resize(120, 30).expect("Resize must succeed");

    // Terminate
    session
        .terminate()
        .await
        .expect("PTY must terminate cleanly");

    // After termination, output channel should close
    let timeout = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while session.next_output().await.is_some() {}
    })
    .await;
    assert!(
        timeout.is_ok(),
        "Session output channel did not close after terminate"
    );
}

#[tokio::test]
async fn test_pty_cwd_and_env_forwarding() {
    let temp_dir = tempfile::tempdir().expect("tempdir");
    let temp_path = temp_dir.path().to_path_buf();
    let temp_canonical = std::fs::canonicalize(&temp_path)
        .unwrap_or(temp_path.clone())
        .to_string_lossy()
        .to_string();

    let mut config = if cfg!(windows) {
        PtySessionConfig::new(
            "cmd.exe",
            vec![
                "/c".into(),
                "echo CWD=%CD% & echo ENV=%TEST_ORCA_CUSTOM_VAR%".into(),
            ],
            80,
            24,
        )
    } else {
        PtySessionConfig::new(
            "sh",
            vec![
                "-c".into(),
                "echo CWD=$(pwd) && echo ENV=$TEST_ORCA_CUSTOM_VAR".into(),
            ],
            80,
            24,
        )
    };
    config.cwd = Some(temp_path);
    config
        .env
        .insert("TEST_ORCA_CUSTOM_VAR".into(), "ORCA_CUSTOM_VAL_999".into());

    let session = spawn(config).await.expect("PTY must spawn successfully");

    let mut output = String::new();
    while let Some(chunk) = session.next_output().await {
        output.push_str(&String::from_utf8_lossy(&chunk));
        if output.contains("ORCA_CUSTOM_VAL_999") {
            break;
        }
    }

    assert!(
        output.contains("ORCA_CUSTOM_VAL_999"),
        "Custom environment variable not forwarded. Output: {}",
        output
    );

    // Verify cwd in output
    let norm_output = output.to_lowercase().replace('/', "\\");
    let norm_path = temp_canonical.to_lowercase().replace('/', "\\");
    // Strip Windows extended path prefix \\?\ if present
    let norm_path_clean = norm_path.strip_prefix(r"\\?\").unwrap_or(&norm_path);
    assert!(
        norm_output.contains(norm_path_clean),
        "Cwd was not applied. Expected cwd {} in output: {}",
        norm_path_clean,
        output
    );

    session
        .terminate()
        .await
        .expect("PTY must terminate cleanly");
}

#[tokio::test]
async fn test_pty_flow_control_pause_resume() {
    let config = if cfg!(windows) {
        PtySessionConfig::new("cmd.exe", vec![], 80, 24)
    } else {
        PtySessionConfig::new("sh", vec![], 80, 24)
    };

    let session = spawn(config).await.expect("PTY must spawn successfully");

    // Pause PTY session
    session.pause();
    assert!(session.is_paused(), "Session must report paused state");

    // Write input while paused
    session
        .write_input(b"echo PAUSE_RESUME_VERIFIED\r\n")
        .await
        .expect("Input write must succeed");

    // Resuming unblocks reader
    session.resume();
    assert!(!session.is_paused(), "Session must report resumed state");

    let mut output = String::new();
    while let Some(chunk) = session.next_output().await {
        output.push_str(&String::from_utf8_lossy(&chunk));
        if output.contains("PAUSE_RESUME_VERIFIED") {
            break;
        }
    }

    assert!(
        output.contains("PAUSE_RESUME_VERIFIED"),
        "Output missing token after resume: {}",
        output
    );

    session
        .terminate()
        .await
        .expect("PTY must terminate cleanly");
}

#[tokio::test]
async fn test_pty_signal_dispatch() {
    let config = if cfg!(windows) {
        PtySessionConfig::new("cmd.exe", vec![], 80, 24)
    } else {
        PtySessionConfig::new("sh", vec![], 80, 24)
    };

    let session = spawn(config).await.expect("PTY must spawn successfully");

    // Test SIGINT
    session
        .signal("SIGINT")
        .await
        .expect("SIGINT dispatch must succeed");

    // Test CTRL_C
    session
        .signal("CTRL_C")
        .await
        .expect("CTRL_C dispatch must succeed");

    // Test SIGTERM terminates process
    session
        .signal("SIGTERM")
        .await
        .expect("SIGTERM dispatch must succeed");
}

#[test]
fn test_osc_scanner_cwd_and_title() {
    use orca_pty::OscScanner;

    let mut scanner = OscScanner::new(None);

    // 1. Scan OSC 7 with BEL
    let osc7_bel = b"\x1b]7;file://localhost/C:/Users/test/workspace\x07";
    scanner.scan(osc7_bel);
    assert_eq!(scanner.get_cwd(), Some(r"C:\Users\test\workspace"));

    // 2. Scan OSC 7 with ST
    let osc7_st = b"\x1b]7;file://localhost/D:/Projects/orca\x1b\\";
    scanner.scan(osc7_st);
    assert_eq!(scanner.get_cwd(), Some(r"D:\Projects\orca"));

    // 3. Scan OSC 0 title with BEL
    let osc0_bel = b"\x1b]0;My Shell Title\x07";
    scanner.scan(osc0_bel);
    assert_eq!(scanner.get_title(), Some("My Shell Title"));

    // 4. Scan OSC 2 title with ST
    let osc2_st = b"\x1b]2;Updated Main Window\x1b\\";
    scanner.scan(osc2_st);
    assert_eq!(scanner.get_title(), Some("Updated Main Window"));
}

#[test]
fn test_osc_scanner_wsl_path_conversion() {
    use orca_pty::OscScanner;

    let mut scanner = OscScanner::new(Some("Ubuntu-24.04".to_string()));

    // drvfs mount: /mnt/c/Users/developer -> C:\Users\developer
    let drvfs_uri = b"\x1b]7;file://localhost/mnt/c/Users/developer\x07";
    scanner.scan(drvfs_uri);
    assert_eq!(scanner.get_cwd(), Some(r"C:\Users\developer"));

    // Native Linux WSL path: /home/developer/code -> \\wsl.localhost\Ubuntu-24.04\home\developer\code
    let linux_uri = b"\x1b]7;file:///home/developer/code\x07";
    scanner.scan(linux_uri);
    assert_eq!(
        scanner.get_cwd(),
        Some(r"\\wsl.localhost\Ubuntu-24.04\home\developer\code")
    );
}

#[test]
fn test_osc_scanner_split_across_chunks() {
    use orca_pty::OscScanner;

    let mut scanner = OscScanner::new(None);

    // Split chunk 1: ends mid-sequence
    let part1 = b"normal output \x1b]7;file://localhost/C:/Projects/";
    scanner.scan(part1);
    assert_eq!(
        scanner.get_cwd(),
        None,
        "CWD must not update until sequence terminates"
    );

    // Split chunk 2: completes sequence
    let part2 = b"split_chunk_test\x07tail output";
    scanner.scan(part2);
    assert_eq!(scanner.get_cwd(), Some(r"C:\Projects\split_chunk_test"));
}

#[test]
fn test_osc_title_bounding() {
    use orca_pty::{bound_osc_title, MAX_OSC_TITLE_CHARS};

    let short_title = "Short Title";
    assert_eq!(bound_osc_title(short_title), short_title);

    let long_title = "A".repeat(3000);
    let bounded = bound_osc_title(&long_title);
    assert_eq!(bounded.len(), MAX_OSC_TITLE_CHARS);
}

#[test]
fn test_conpty_warmup_pool() {
    use orca_pty::warm_windows_conpty_once;

    // Must be callable safely and idempotently
    warm_windows_conpty_once();
    warm_windows_conpty_once();
}

#[test]
fn test_models_and_snapshots() {
    use orca_pty::{PendingOutputRecord, TakePendingOutputResult, TerminalModes, TerminalSnapshot};

    let modes = TerminalModes {
        bracketed_paste: true,
        mouse_tracking: false,
        ..Default::default()
    };
    assert!(modes.bracketed_paste);

    let snapshot = TerminalSnapshot {
        snapshot_ansi: "screen".into(),
        scrollback_ansi: "history".into(),
        pending_escape_tail_ansi: None,
        osc_links: None,
        rehydrate_sequences: String::new(),
        frame_restore_ansi: None,
        cwd: Some("C:\\test".into()),
        modes,
        cols: 80,
        rows: 24,
        scrollback_lines: 1,
        last_title: Some("title".into()),
        output_sequence: Some(42),
        terminal_owner: None,
    };
    assert_eq!(snapshot.cols, 80);
    assert_eq!(snapshot.rows, 24);

    let result = TakePendingOutputResult {
        records: vec![PendingOutputRecord {
            kind: "output".into(),
            data: Some("data".into()),
            cols: None,
            rows: None,
        }],
        seq: 1,
        overflowed: false,
        snapshot: Some(snapshot),
    };
    assert_eq!(result.seq, 1);
    assert_eq!(result.records.len(), 1);
}

#[tokio::test]
async fn test_pty_flow_control_failsafe_timeout() {
    let config = if cfg!(windows) {
        PtySessionConfig::new("cmd.exe", vec![], 80, 24)
    } else {
        PtySessionConfig::new("sh", vec![], 80, 24)
    };

    let session = std::sync::Arc::new(spawn(config).await.expect("Spawn PTY"));
    session.pause();
    assert!(session.is_paused());

    // Auto-resume after 200ms
    let s_clone = std::sync::Arc::clone(&session);
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        s_clone.resume();
    });

    session
        .write_input(b"echo FAILSAFE_AUTO_RESUME_OK\r\n")
        .await
        .expect("write_input");

    let mut output = String::new();
    while let Some(chunk) = session.next_output().await {
        output.push_str(&String::from_utf8_lossy(&chunk));
        if output.contains("FAILSAFE_AUTO_RESUME_OK") {
            break;
        }
    }

    assert!(
        output.contains("FAILSAFE_AUTO_RESUME_OK"),
        "Session did not resume: {}",
        output
    );
    assert!(!session.is_paused());

    session.terminate().await.expect("terminate");
}
