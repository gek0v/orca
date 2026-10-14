use orca_core::credentials::{delete_credential, get_credential, set_credential};
use orca_core::persistence::actor::PersistenceActor;
use orca_core::process::cmd_shim::{
    parse_windows_cmd_shim, resolve_windows_cmd_shim, ParsedWindowsCmdShim,
    MAX_SHIM_BYTES,
};
use orca_core::process::command_line::{
    build_windows_cmd_shim_command_line, quote_windows_argument,
    quote_windows_cmd_argument, validate_windows_cmd_arguments, CommandEscapingError,
};
use orca_core::rpc::client::{OrcadClient, OrcadClientError};
use rusqlite::Connection;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

// -----------------------------------------------------------------------------
// Test Corpus for Command Line Escaping
// -----------------------------------------------------------------------------
const WINDOWS_ARGUMENT_CORPUS: &[(&str, &str)] = &[
    ("plain", "hello"),
    ("empty", ""),
    ("space", "hello world"),
    ("double-quote", "say \"hi\" ok"),
    ("quote-only", "\""),
    ("two-quotes", "\"\""),
    ("caret", "a^b"),
    ("ampersand", "a&b"),
    ("pipe", "a|b"),
    ("redirect", "a<b>c"),
    ("percent-pair", "e%F%g"),
    ("percent-after-backslash", "C:\\Users\\%F%\\x"),
    ("percent-after-two-backslashes", "C:\\\\%F%"),
    ("percent-lone", "100% done"),
    ("bang", "q!VAR!r"),
    ("parens", "a(b)c"),
    ("trailing-backslash", "C:\\dir\\"),
    ("backslash-quote", "a\\\"b"),
    ("double-backslash-quote", "a\\\\\"b"),
    ("only-backslashes", "\\\\\\"),
    ("semicolon-comma", "a;b,c"),
    ("unicode", "日本語 café"),
    ("combined", "x\"y&z%F%"),
    (
        "agent-prompt",
        "Fix \"src/a b.ts\" & run tests 100% !now! ^ (v2)",
    ),
];

fn parse_command_line_to_argv(line: &str) -> Vec<String> {
    let mut argv = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if !started && ch.is_whitespace() {
            i += 1;
            continue;
        }
        started = true;

        if ch == '\\' {
            let mut backslashes = 0;
            while i < chars.len() && chars[i] == '\\' {
                backslashes += 1;
                i += 1;
            }
            if i < chars.len() && chars[i] == '"' {
                for _ in 0..(backslashes / 2) {
                    current.push('\\');
                }
                if backslashes % 2 == 1 {
                    current.push('"');
                    i += 1;
                }
            } else {
                for _ in 0..backslashes {
                    current.push('\\');
                }
            }
            continue;
        }

        if ch == '"' {
            if quoted && i + 1 < chars.len() && chars[i + 1] == '"' {
                current.push('"');
                i += 2;
                continue;
            }
            quoted = !quoted;
            i += 1;
            continue;
        }

        if !quoted && ch.is_whitespace() {
            argv.push(current);
            current = String::new();
            started = false;
            i += 1;
            continue;
        }

        current.push(ch);
        i += 1;
    }

    if started {
        argv.push(current);
    }

    argv
}

fn quote_parity(line: &str) -> usize {
    line.chars().filter(|&c| c == '"').count() % 2
}

// =============================================================================
// CHALLENGE 1: cmd_shim.rs Stress Testing
// =============================================================================

#[test]
fn test_challenge_cmd_shim_corrupted_and_multiple_boms() {
    let base_shim = r#"@echo off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\cli.js" %*
"#;

    // 1. Single BOM
    let single_bom = format!("\u{feff}{}", base_shim);
    assert!(parse_windows_cmd_shim(&single_bom).is_some());

    // 2. Double BOM
    let double_bom = format!("\u{feff}\u{feff}{}", base_shim);
    assert!(parse_windows_cmd_shim(&double_bom).is_some());

    // 3. Triple BOM - canonicalize_shim_contents strips up to 2 BOMs. A 3rd leaves '\u{feff}@echo off', which must be rejected!
    let triple_bom = format!("\u{feff}\u{feff}\u{feff}{}", base_shim);
    assert_eq!(
        parse_windows_cmd_shim(&triple_bom),
        None,
        "Triple BOM must be rejected safely"
    );

    // 4. Inverted BOM / UTF-16 LE marker
    let inverted_bom = format!("\u{fffe}{}", base_shim);
    assert_eq!(
        parse_windows_cmd_shim(&inverted_bom),
        None,
        "Inverted BOM must be rejected safely"
    );

    // 5. Embedded BOM in the middle of a line
    let mid_bom = base_shim.replace("GOTO start", "GOTO\u{feff}start");
    assert_eq!(
        parse_windows_cmd_shim(&mid_bom),
        None,
        "Embedded BOM in line must be rejected safely"
    );
}

#[test]
fn test_challenge_cmd_shim_malformed_and_injection_payloads() {
    // 1. Empty and whitespace-only
    assert_eq!(parse_windows_cmd_shim(""), None);
    assert_eq!(parse_windows_cmd_shim("   \r\n\t\r\n   "), None);

    // 2. Truncated shims
    assert_eq!(parse_windows_cmd_shim("@echo off\r\n"), None);
    assert_eq!(parse_windows_cmd_shim("@SETLOCAL\r\n"), None);

    // 3. Command injection payloads in target path
    let injection_cases = &[
        r#"@echo off
"%~dp0\tool.exe & calc.exe" %*
"#,
        r#"@echo off
"%~dp0\tool.exe | calc.exe" %*
"#,
        r#"@echo off
"%~dp0\tool.exe > pwned.txt" %*
"#,
        r#"@echo off
"%~dp0\tool.exe < in.txt" %*
"#,
        r#"@echo off
"%~dp0\%PATH%\tool.exe" %*
"#,
        r#"@echo off
"%~dp0\tool^.exe" %*
"#,
        r#"@echo off
"%~dp0\tool"quote.exe" %*
"#,
        "@echo off\r\n\"%~dp0\\tool.exe\ncalc.exe\" %*\r\n",
        "@echo off\r\n\"%~dp0\\tool.exe\r\ncalc.exe\" %*\r\n",
    ];

    for (idx, payload) in injection_cases.iter().enumerate() {
        assert_eq!(
            parse_windows_cmd_shim(payload),
            None,
            "Injection payload {} must be rejected: {:?}",
            idx,
            payload
        );
    }
}

#[test]
fn test_challenge_cmd_shim_relative_and_drive_relative_paths() {
    // Drive-relative paths (e.g. C:evil.exe)
    let drive_rel = r#"@echo off
"%~dp0\C:evil.exe" %*
"#;
    assert_eq!(
        parse_windows_cmd_shim(drive_rel),
        None,
        "Drive-relative path C:evil.exe must be rejected"
    );

    // Root-relative paths
    let root_rel_backslash = r#"@echo off
"%~dp0\\evil.exe" %*
"#;
    assert_eq!(
        parse_windows_cmd_shim(root_rel_backslash),
        None,
        "Root-relative path \\evil.exe must be rejected"
    );

    let root_rel_slash = r#"@echo off
"%~dp0\/evil.exe" %*
"#;
    assert_eq!(
        parse_windows_cmd_shim(root_rel_slash),
        None,
        "Root-relative path /evil.exe must be rejected"
    );
}

#[test]
fn test_challenge_cmd_shim_extension_boundaries() {
    let forbidden_extensions = &[
        "script.bat",
        "script.cmd",
        "script.sh",
        "script.ps1",
        "script.txt",
        "script.dll",
        "script.exe.bat",
        "script.com.cmd",
        "script.exe ",
        "script.exe::$DATA",
        "script",
    ];

    for ext in forbidden_extensions {
        let shim = format!("@echo off\n\"%~dp0\\{}\" %*\n", ext);
        assert_eq!(
            parse_windows_cmd_shim(&shim),
            None,
            "Direct target with extension {:?} must be rejected",
            ext
        );
    }

    // Permitted extensions (case variations)
    let allowed = &[
        ("tool.exe", "tool.exe"),
        ("TOOL.EXE", "TOOL.EXE"),
        ("tool.com", "tool.com"),
        ("TOOL.COM", "TOOL.COM"),
        ("subdir\\tool.exe", "subdir\\tool.exe"),
    ];

    for (spelled, expected) in allowed {
        let shim = format!("@echo off\n\"%~dp0\\{}\" %*\n", spelled);
        let parsed = parse_windows_cmd_shim(&shim);
        assert_eq!(
            parsed,
            Some(ParsedWindowsCmdShim::Direct {
                target: expected.to_string(),
            }),
            "Direct target {:?} should be accepted",
            spelled
        );
    }
}

#[test]
fn test_challenge_cmd_shim_file_size_and_relative_path_resolution() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orca_challenge_cmd_shim_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&temp_dir).unwrap();

    // 1. Relative path rejected
    assert_eq!(
        resolve_windows_cmd_shim(Path::new("some/relative/shim.cmd")),
        None
    );
    assert_eq!(
        resolve_windows_cmd_shim(Path::new("./shim.cmd")),
        None
    );

    // 2. File size exceeding MAX_SHIM_BYTES (64KB)
    let large_shim = temp_dir.join("large.cmd");
    let mut large_content = String::with_capacity(MAX_SHIM_BYTES + 1024);
    large_content.push_str("@echo off\r\nREM ");
    while large_content.len() < MAX_SHIM_BYTES + 10 {
        large_content.push_str("AAAAAAAAAAAAAAAA");
    }
    large_content.push_str("\r\n\"%~dp0\\tool.exe\" %*\r\n");
    std::fs::write(&large_shim, large_content).unwrap();

    assert_eq!(
        resolve_windows_cmd_shim(&large_shim),
        None,
        "Shims exceeding 64KB must be rejected without memory exhaustion"
    );

    // 3. Non-existent file
    let missing_shim = temp_dir.join("nonexistent.cmd");
    assert_eq!(resolve_windows_cmd_shim(&missing_shim), None);

    // 4. Directory passed instead of file
    assert_eq!(resolve_windows_cmd_shim(&temp_dir), None);

    // Cleanup
    let _ = std::fs::remove_file(&large_shim);
    let _ = std::fs::remove_dir_all(&temp_dir);
}

// =============================================================================
// CHALLENGE 2: Command Line Argument Escaping Stress Testing
// =============================================================================

#[test]
fn test_challenge_command_line_corpus_roundtrip() {
    for (name, value) in WINDOWS_ARGUMENT_CORPUS {
        // Test quote_windows_argument
        let quoted = quote_windows_argument(value);
        assert_eq!(
            quote_parity(&quoted),
            0,
            "Corpus entry '{}' has odd quote parity in quote_windows_argument: {}",
            name,
            quoted
        );
        let parsed = parse_command_line_to_argv(&quoted);
        assert_eq!(
            parsed,
            vec![value.to_string()],
            "Corpus entry '{}' failed CommandLineToArgvW roundtrip: encoded as {}",
            name,
            quoted
        );

        // Test quote_windows_cmd_argument
        let cmd_quoted = quote_windows_cmd_argument(value);
        assert_eq!(
            quote_parity(&cmd_quoted),
            0,
            "Corpus entry '{}' has odd quote parity in quote_windows_cmd_argument: {}",
            name,
            cmd_quoted
        );

        // For cmd argument: if value contains '%', verify that it has been neutralized as '"^%"'
        if value.contains('%') {
            assert!(
                cmd_quoted.contains("\"^%\""),
                "Corpus entry '{}' with '%' must neutralize percent signs: {}",
                name,
                cmd_quoted
            );
        }
    }
}

#[test]
fn test_challenge_command_line_composed_line_parity() {
    let values: Vec<&str> = WINDOWS_ARGUMENT_CORPUS.iter().map(|(_, v)| *v).collect();
    let composed = build_windows_cmd_shim_command_line("C:\\tools\\agent.cmd", &values).unwrap();

    assert!(
        composed.starts_with("/d /v:off /s /c \""),
        "Must enforce cmd security flags"
    );
    assert!(composed.ends_with('"'), "Must end with outer quote");

    // The inner line (between outer quotes) must have even quote count
    let inner = composed
        .strip_prefix("/d /v:off /s /c \"")
        .expect("prefix")
        .strip_suffix('"')
        .expect("suffix");
    assert_eq!(
        quote_parity(inner),
        0,
        "Composed command line inner segment must have even quote parity"
    );
}

#[test]
fn test_challenge_command_line_line_break_rejection() {
    let line_break_inputs = &[
        "arg1\narg2",
        "arg1\rarg2",
        "arg1\r\narg2",
        "\n",
        "\r",
        "trailing\n",
        "trailing\r",
        "\nleading",
        "\rleading",
    ];

    for input in line_break_inputs {
        assert_eq!(
            validate_windows_cmd_arguments(&[input]),
            Err(CommandEscapingError::LineBreakNotAllowed),
            "Line break in argument {:?} must be rejected",
            input
        );

        assert_eq!(
            build_windows_cmd_shim_command_line("agent.cmd", &[input]),
            Err(CommandEscapingError::LineBreakNotAllowed),
            "Line break in arg {:?} must be rejected in build_windows_cmd_shim_command_line",
            input
        );

        assert_eq!(
            build_windows_cmd_shim_command_line(input, &["valid_arg"]),
            Err(CommandEscapingError::LineBreakNotAllowed),
            "Line break in program {:?} must be rejected in build_windows_cmd_shim_command_line",
            input
        );
    }
}

#[test]
fn test_challenge_command_line_backslash_and_quote_storms() {
    let adversarial_strings = &[
        r#"\\\""#,
        r#"\\\\\\\""#,
        r#"\"\"\"\""#,
        r#"C:\a\b\c\"#,
        r#"C:\a\b\c\\"#,
        r#"C:\a\b\c\\\"#,
        r#""""""#,
        r#"""""#,
        r#"a\"b\"c\"d"#,
        r#"\\server\share\path with spaces\"#,
        r#"%PATH%%VAR%%TEMP%%"#,
        r#"C:\Users\%USERNAME%\AppData\Local\"#,
        r#"foo "bar" %baz% ^& | < >"#,
    ];

    for s in adversarial_strings {
        let quoted = quote_windows_argument(s);
        assert_eq!(quote_parity(&quoted), 0, "Odd quote parity on {:?}", s);
        let decoded = parse_command_line_to_argv(&quoted);
        assert_eq!(decoded, vec![s.to_string()], "Mismatch on {:?}", s);

        let cmd_quoted = quote_windows_cmd_argument(s);
        assert_eq!(
            quote_parity(&cmd_quoted),
            0,
            "Odd quote parity in cmd_quote on {:?}",
            s
        );
    }
}

// =============================================================================
// CHALLENGE 3: PersistenceActor SQLite WAL Concurrency Stress Testing
// =============================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn test_challenge_persistence_actor_wal_mode_and_high_concurrency() {
    let temp_dir = std::env::temp_dir().join(format!(
        "orca_challenge_wal_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&temp_dir).unwrap();
    let db_path = temp_dir.join("orca_test.db");

    // 1. Open PersistenceActor backed by file
    let actor = PersistenceActor::open(&db_path).expect("open PersistenceActor");

    // 2. Direct inspection of pragmas via a separate connection
    {
        let conn = Connection::open(&db_path).expect("open inspection connection");
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode;", [], |row| row.get(0))
            .expect("read journal_mode");
        assert_eq!(
            journal_mode.to_lowercase(),
            "wal",
            "Database must operate in WAL journal mode"
        );

        let busy_timeout: i64 = conn
            .query_row("PRAGMA busy_timeout;", [], |row| row.get(0))
            .expect("read busy_timeout");
        assert_eq!(busy_timeout, 5000, "busy_timeout must be configured to 5000ms");
    }

    // 3. High-concurrency stress test: 50 concurrent tasks performing 1,000 mixed operations
    const NUM_TASKS: usize = 50;
    const OPS_PER_TASK: usize = 20;
    let mut join_handles = Vec::with_capacity(NUM_TASKS);
    let success_count = Arc::new(AtomicUsize::new(0));

    for task_id in 0..NUM_TASKS {
        let actor_clone = actor.clone();
        let counter = Arc::clone(&success_count);

        let handle = tokio::spawn(async move {
            for op in 0..OPS_PER_TASK {
                let key = format!("task_{}_setting_{}", task_id, op);
                let val = format!("val_{}_{}", task_id, op);

                // Write
                actor_clone.set_setting(&key, &val).await.unwrap();

                // Read back
                let retrieved = actor_clone.get_setting(&key).await.unwrap();
                assert_eq!(retrieved, Some(val.clone()));

                // Session store
                let sess_id = format!("sess_{}_{}", task_id, op);
                let sess_data = format!(r#"{{"task":{},"op":{}}}"#, task_id, op);
                actor_clone
                    .store_session(&sess_id, "Test Title", &sess_data)
                    .await
                    .unwrap();

                // Session get
                let sess_retrieved = actor_clone.get_session(&sess_id).await.unwrap();
                assert_eq!(sess_retrieved, Some(sess_data));

                counter.fetch_add(1, Ordering::Relaxed);
            }
        });
        join_handles.push(handle);
    }

    // Concurrently, run an external reader reading from the SQLite file in a background thread
    let db_path_clone = db_path.clone();
    let reader_handle = std::thread::spawn(move || {
        let conn = Connection::open(&db_path_clone).expect("open concurrent reader");
        for _ in 0..50 {
            let count: i64 = conn
                .query_row("SELECT count(*) FROM settings", [], |row| row.get(0))
                .unwrap_or(0);
            assert!(count >= 0);
            std::thread::sleep(Duration::from_millis(5));
        }
    });

    for h in join_handles {
        h.await.expect("task join");
    }
    reader_handle.join().expect("reader join");

    assert_eq!(
        success_count.load(Ordering::SeqCst),
        NUM_TASKS * OPS_PER_TASK,
        "All concurrent operations must succeed without lockup or dropped messages"
    );

    // Verify database state integrity
    let settings = actor.list_settings().await.expect("list settings");
    assert_eq!(settings.len(), NUM_TASKS * OPS_PER_TASK);

    // Cleanup
    drop(actor);
    // Allow actor thread to terminate
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

// =============================================================================
// CHALLENGE 4: Keyring and orcad IPC Fallback Behavior
// =============================================================================

#[test]
fn test_challenge_keyring_fallback_behavior() {
    let non_existent_service = "com.stablyai.orca.nonexistent.service.test";
    let non_existent_user = "nobody_user_123456789";

    // 1. Missing entry get returns Ok(None)
    let res_get = get_credential(non_existent_service, non_existent_user);
    assert!(
        res_get.is_ok(),
        "Querying non-existent credential must return Ok(None), got: {:?}",
        res_get
    );
    assert_eq!(res_get.unwrap(), None);

    // 2. Missing entry delete returns Ok(false)
    let res_del = delete_credential(non_existent_service, non_existent_user);
    assert!(
        res_del.is_ok(),
        "Deleting non-existent credential must return Ok(false), got: {:?}",
        res_del
    );
    assert_eq!(res_del.unwrap(), false);

    // 3. Unicode and special characters in credential value
    let service = "com.stablyai.orca.unicode.test";
    let user = "test_user_unicode";
    let unicode_secret = "token_🔒_日本語_café_123$%^&*()";

    // Ensure clean start
    let _ = delete_credential(service, user);

    let set_res = set_credential(service, user, unicode_secret);
    if set_res.is_ok() {
        let retrieved = get_credential(service, user).unwrap();
        assert_eq!(retrieved, Some(unicode_secret.to_string()));
        assert!(delete_credential(service, user).unwrap());
    }
}

#[tokio::test]
async fn test_challenge_orcad_ipc_missing_pipe_fallback() {
    // Attempting to invoke against a non-existent endpoint must fail with IoError without hanging
    let missing_endpoint = r#"\\.\pipe\orca-challenge-nonexistent-pipe-99999"#;
    let client = OrcadClient::new(missing_endpoint);

    let start = std::time::Instant::now();
    let res = client
        .invoke("ping", serde_json::json!({}))
        .await;

    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_millis(500),
        "Missing pipe invoke must fail quickly without hang (took {:?})",
        elapsed
    );

    assert!(
        matches!(res, Err(OrcadClientError::IoError(_))),
        "Expected IoError for missing pipe, got: {:?}",
        res
    );
}

#[cfg(windows)]
#[tokio::test]
async fn test_challenge_orcad_ipc_connection_drop_and_reconnection_probe() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = format!(r#"\\.\pipe\orca-test-pipe-{}"#, std::process::id());

    // 1. Start a named pipe server
    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&pipe_name)
        .expect("create server pipe");

    let server_task = tokio::spawn(async move {
        server.connect().await.expect("server connect");
        let mut reader = BufReader::new(server);
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("server read line");

        // Parse request and respond with valid canonical RpcResponse (ok: true)
        let req: serde_json::Value = serde_json::from_str(&line).expect("parse json");
        let id = req["id"].as_str().unwrap();
        let resp = format!(
            "{{\"id\":\"{}\",\"ok\":true,\"result\":{{\"status\":\"ok\"}}}}\n",
            id
        );
        reader.get_mut().write_all(resp.as_bytes()).await.expect("server write");
        reader.get_mut().flush().await.expect("server flush");

        // Server exits here, dropping the pipe
    });

    let client = OrcadClient::new(&pipe_name);

    // Call 1: Server is alive and responds
    let res1 = client.invoke("test_method", serde_json::json!({})).await;
    assert!(res1.is_ok(), "First call should succeed: {:?}", res1);
    assert_eq!(res1.unwrap(), serde_json::json!({"status": "ok"}));

    server_task.await.expect("server task finish");

    // Small delay to ensure OS pipe teardown
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Call 2: Server dropped the pipe.
    // Client attempts to write/read on dropped connection:
    let res2 = client.invoke("test_method", serde_json::json!({})).await;
    println!("PROBE OBSERVATION: Call 2 returned: {:?}", res2);
    assert!(
        res2.is_err(),
        "Second call after server drop must return an Err, got: {:?}",
        res2
    );

    // Call 3: Now probe whether client can recover if a NEW server starts on the pipe
    let server2 = ServerOptions::new()
        .first_pipe_instance(false)
        .create(&pipe_name);

    if let Ok(server2) = server2 {
        let server2_task = tokio::spawn(async move {
            tokio::select! {
                res = server2.connect() => {
                    if res.is_ok() {
                        let mut reader = BufReader::new(server2);
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.is_ok() {
                            let _ = reader.get_mut().write_all(b"{\"id\":\"1\",\"ok\":true,\"result\":{}}\n").await;
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(500)) => {
                    // Timed out because client never initiated a new connection
                }
            }
        });

        let res3 = client.invoke("test_reconnect", serde_json::json!({})).await;
        println!("PROBE OBSERVATION: Call 3 (reconnect attempt) returned: {:?}", res3);

        // Crucial empirical finding:
        // Because OrcadClient does NOT clear *guard = None on error, Call 3 attempts
        // to write to the dead pipe handle instead of connecting to server2, returning BrokenPipe.
        assert!(
            matches!(res3, Err(OrcadClientError::IoError(ref e)) if e.kind() == std::io::ErrorKind::BrokenPipe),
            "Client should fail with BrokenPipe on Call 3 because dead pipe handle is retained in *guard"
        );

        let _ = server2_task.await;
    }
}
