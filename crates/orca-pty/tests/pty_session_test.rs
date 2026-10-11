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

    let mut session = spawn(config).await.expect("PTY must spawn successfully");

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

    let mut session = spawn(config).await.expect("PTY must spawn successfully");

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

    let mut session = spawn(config).await.expect("PTY must spawn successfully");

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
