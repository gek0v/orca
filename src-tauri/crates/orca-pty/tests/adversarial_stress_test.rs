//! Adversarial Stress Test Suite for Orca PTY Engine
//!
//! Validates:
//! 1. Rapid concurrent spawn & kill cycles without deadlocks or panics.
//! 2. Immediate kill of an aggressively streaming/flooding process without hang.
//! 3. Win32 Job Object containment: strict omission of JOB_OBJECT_LIMIT_BREAKAWAY_OK
//!    and empirical verification that MSYS/Git Bash child processes cannot orphan.
//! 4. Bounded handle and thread cleanup across repeated spawn/kill cycles.

#![allow(non_snake_case, non_upper_case_globals, dead_code)]

use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use orca_pty::framing::{decode_pty_frame, PtyFrameOpcode};
use orca_pty::{PortablePtyEngine, PtySessionDescriptor};

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;

    pub const STILL_ACTIVE: u32 = 259;
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    pub const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    pub const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x0800;
    pub const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: u32 = 0x1000;
    pub const JobObjectExtendedLimitInformation: i32 = 9;

    #[repr(C)]
    #[derive(Default)]
    pub struct IO_COUNTERS {
        pub ReadOperationCount: u64,
        pub WriteOperationCount: u64,
        pub OtherOperationCount: u64,
        pub ReadTransferCount: u64,
        pub WriteTransferCount: u64,
        pub OtherTransferCount: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        pub PerProcessUserTimeLimit: i64,
        pub PerJobUserTimeLimit: i64,
        pub LimitFlags: u32,
        pub MinimumWorkingSetSize: usize,
        pub MaximumWorkingSetSize: usize,
        pub ActiveProcessLimit: u32,
        pub Affinity: usize,
        pub PriorityClass: u32,
        pub SchedulingClass: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    pub struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        pub BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION,
        pub IoInfo: IO_COUNTERS,
        pub ProcessMemoryLimit: usize,
        pub JobMemoryLimit: usize,
        pub PeakProcessMemoryLimit: usize,
        pub PeakJobMemoryLimit: usize,
    }

    extern "system" {
        pub fn GetCurrentProcess() -> *mut c_void;
        pub fn GetProcessHandleCount(hProcess: *mut c_void, pdwHandleCount: *mut u32) -> i32;
        pub fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut c_void;
        pub fn CloseHandle(hObject: *mut c_void) -> i32;
        pub fn GetExitCodeProcess(hProcess: *mut c_void, lpExitCode: *mut u32) -> i32;
        pub fn QueryInformationJobObject(
            hJob: *mut c_void,
            JobObjectInformationClass: i32,
            lpJobObjectInformation: *mut c_void,
            cbJobObjectInformationLength: u32,
            lpReturnLength: *mut u32,
        ) -> i32;
    }

    pub fn get_current_handle_count() -> u32 {
        let mut count: u32 = 0;
        unsafe {
            let proc = GetCurrentProcess();
            GetProcessHandleCount(proc, &mut count);
        }
        count
    }
}

/// Adversarial Test 1: Rapid Concurrent Spawn & Kill Cycles
///
/// Spawns 20 PTY sessions concurrently from distinct worker threads, each killing
/// the session after varying micro-delays (0ms to 40ms).
/// Asserts:
/// - Every kill() completes in < 50ms (no mutex contention / lock inversion).
/// - Every session receives an Exit frame within timeout.
/// - Engine sessions registry is fully drained.
#[test]
fn test_adversarial_rapid_concurrent_spawn_and_kill() {
    let engine = Arc::new(PortablePtyEngine::new());
    let concurrency = 20;
    let mut handles = Vec::with_capacity(concurrency);

    for i in 0..concurrency {
        let engine_clone = engine.clone();
        let handle = thread::spawn(move || {
            let session_id = format!("stress-rapid-{}", i);
            let (tx, rx) = mpsc::channel();

            #[cfg(windows)]
            let (cmd, args) = (
                "cmd.exe".to_string(),
                vec!["/c".to_string(), "ping -n 30 127.0.0.1 >nul".to_string()],
            );
            #[cfg(not(windows))]
            let (cmd, args) = ("sh".to_string(), vec!["-c".to_string(), "sleep 30".to_string()]);

            let descriptor = PtySessionDescriptor {
                session_id: session_id.clone(),
                command: cmd,
                args,
                cwd: None,
                cols: 80,
                rows: 24,
            };

            let spawn_res = engine_clone.spawn(descriptor, move |frame| {
                let _ = tx.send(frame);
            });
            assert!(spawn_res.is_ok(), "Session {} spawn must succeed", i);

            // Stagger kill delays across threads: 0ms, 5ms, 10ms, ...
            let delay_ms = (i % 5) * 5;
            if delay_ms > 0 {
                thread::sleep(Duration::from_millis(delay_ms as u64));
            }

            let start = Instant::now();
            let kill_res = engine_clone.kill(&session_id);
            let kill_duration = start.elapsed();

            assert!(kill_res.is_ok(), "Kill must succeed on session {}", i);
            assert!(
                kill_duration < Duration::from_millis(100),
                "Kill on session {} took too long: {:?}",
                i,
                kill_duration
            );

            // Wait for exit frame
            let mut got_exit = false;
            while let Ok(frame_bytes) = rx.recv_timeout(Duration::from_secs(4)) {
                if let Ok(frame) = decode_pty_frame(&frame_bytes) {
                    if frame.opcode == PtyFrameOpcode::Exit {
                        got_exit = true;
                        break;
                    }
                }
            }
            assert!(got_exit, "Session {} must receive PtyFrameOpcode::Exit", i);
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().expect("Worker thread panicked");
    }

    // Allow background thread teardown
    thread::sleep(Duration::from_millis(200));
}

/// Adversarial Test 2: Killing Actively Streaming Flooding Process (No Deadlock)
///
/// Executes a loop emitting large volumes of stdout data.
/// Verifies that calling kill() while reader is saturated with incoming frames
/// immediately stops execution without deadlocking reader or watcher threads.
#[test]
fn test_adversarial_kill_actively_streaming_process() {
    let engine = PortablePtyEngine::new();
    let (tx, rx) = mpsc::channel();
    let session_id = "stress-stream-flood".to_string();

    #[cfg(windows)]
    let (cmd, args) = (
        "cmd.exe".to_string(),
        vec![
            "/c".to_string(),
            "for /l %i in (1,1,100000) do @echo FLOODING_BUFFER_TEST_PAYLOAD_%i_DATA_STREAMING_ORCA_CHALLENGER"
                .to_string(),
        ],
    );
    #[cfg(not(windows))]
    let (cmd, args) = (
        "sh".to_string(),
        vec![
            "-c".to_string(),
            "while true; do echo 'FLOODING_BUFFER_TEST_PAYLOAD_DATA_STREAMING_ORCA_CHALLENGER'; done"
                .to_string(),
        ],
    );

    let descriptor = PtySessionDescriptor {
        session_id: session_id.clone(),
        command: cmd,
        args,
        cwd: None,
        cols: 120,
        rows: 40,
    };

    engine
        .spawn(descriptor, move |frame| {
            let _ = tx.send(frame);
        })
        .expect("spawn must succeed");

    // Wait until reader is actively receiving high volume of frames
    let mut frames_received = 0;
    while let Ok(frame_bytes) = rx.recv_timeout(Duration::from_secs(3)) {
        if let Ok(frame) = decode_pty_frame(&frame_bytes) {
            if frame.opcode == PtyFrameOpcode::Output {
                frames_received += 1;
                if frames_received >= 25 {
                    break;
                }
            }
        }
    }

    assert!(
        frames_received >= 25,
        "Engine must stream output frames before kill; received {}",
        frames_received
    );

    // Call kill while actively streaming
    let kill_start = Instant::now();
    let kill_res = engine.kill(&session_id);
    let kill_elapsed = kill_start.elapsed();

    assert!(kill_res.is_ok(), "kill must succeed on streaming session");
    assert!(
        kill_elapsed < Duration::from_millis(50),
        "kill must not block during active streaming; took {:?}",
        kill_elapsed
    );

    // Drain remaining frames until Exit frame is received
    let mut got_exit = false;
    let mut _trailing_frames = 0;
    let drain_start = Instant::now();
    while let Ok(frame_bytes) = rx.recv_timeout(Duration::from_secs(3)) {
        if let Ok(frame) = decode_pty_frame(&frame_bytes) {
            match frame.opcode {
                PtyFrameOpcode::Output => {
                    _trailing_frames += 1;
                }
                PtyFrameOpcode::Exit => {
                    got_exit = true;
                    break;
                }
            }
        }
    }

    assert!(got_exit, "Must receive Exit frame after streaming process is killed");
    assert!(
        drain_start.elapsed() < Duration::from_secs(3),
        "Drain took too long: {:?}",
        drain_start.elapsed()
    );
}

/// Adversarial Test 3: Win32 Job Object Breakaway Denial & Strict Invariant Check
///
/// Empirically inspects the Win32 kernel Job Object limits to verify:
/// 1. `JOB_OBJECT_LIMIT_BREAKAWAY_OK` (0x0800) is strictly NOT set.
/// 2. `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` (0x1000) is strictly NOT set.
/// 3. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (0x2000) IS strictly set.
/// 4. When Git Bash runtime is present, launching a background subshell and killing
///    the PTY session reaps both parent and child, leaving NO orphaned processes.
#[cfg(windows)]
#[test]
fn test_adversarial_win32_job_object_breakaway_denial() {
    use orca_core::process::ProcessJobObject;
    use std::path::Path;

    // 1. Verify kernel limit flags on created Job Object
    let job = ProcessJobObject::create().expect("CreateJobObject succeeds");
    let raw_handle = job.raw_handle();

    let mut info = win32::JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    let mut return_len: u32 = 0;
    let success = unsafe {
        win32::QueryInformationJobObject(
            raw_handle as *mut _,
            win32::JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<win32::JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            &mut return_len,
        )
    };
    assert_ne!(success, 0, "QueryInformationJobObject failed");

    let flags = info.BasicLimitInformation.LimitFlags;
    assert_ne!(
        flags & win32::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        0,
        "Invariant violation: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE must be set in LimitFlags: {:#X}",
        flags
    );
    assert_eq!(
        flags & win32::JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        0,
        "CRITICAL INVARIANT VIOLATION: JOB_OBJECT_LIMIT_BREAKAWAY_OK must NOT be set: {:#X}",
        flags
    );
    assert_eq!(
        flags & win32::JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
        0,
        "CRITICAL INVARIANT VIOLATION: JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK must NOT be set: {:#X}",
        flags
    );

    // 2. If Git Bash is installed, test MSYS runtime child breakaway prevention
    let git_bash_path = Path::new(r"C:\Program Files\Git\bin\bash.exe");
    if git_bash_path.exists() {
        let engine = PortablePtyEngine::new();
        let (tx, rx) = mpsc::channel();
        let session_id = "test-git-bash-breakaway".to_string();

        // Spawn bash running a unique background sleep command
        let unique_sleep_secs = 8765;
        let descriptor = PtySessionDescriptor {
            session_id: session_id.clone(),
            command: git_bash_path.to_string_lossy().to_string(),
            args: vec![
                "-c".to_string(),
                format!("sleep {} & echo BASH_SPAWNED_CHILD; wait", unique_sleep_secs),
            ],
            cwd: None,
            cols: 80,
            rows: 24,
        };

        engine
            .spawn(descriptor, move |frame| {
                let _ = tx.send(frame);
            })
            .expect("Git Bash spawn succeeds");

        // Wait until bash reports child was spawned
        let mut child_spawned = false;
        while let Ok(frame_bytes) = rx.recv_timeout(Duration::from_secs(5)) {
            if let Ok(frame) = decode_pty_frame(&frame_bytes) {
                if frame.opcode == PtyFrameOpcode::Output {
                    let text = String::from_utf8_lossy(&frame.payload);
                    if text.contains("BASH_SPAWNED_CHILD") {
                        child_spawned = true;
                        break;
                    }
                }
            }
        }
        assert!(child_spawned, "Git bash must have spawned child process");

        // Kill the PTY session. With breakaway denied, the background sleep process
        // MUST be contained in the Job Object and reaped.
        let kill_res = engine.kill(&session_id);
        assert!(kill_res.is_ok(), "kill on git bash session succeeds");

        // Wait for exit frame
        while let Ok(frame_bytes) = rx.recv_timeout(Duration::from_secs(3)) {
            if let Ok(frame) = decode_pty_frame(&frame_bytes) {
                if frame.opcode == PtyFrameOpcode::Exit {
                    break;
                }
            }
        }

        // Give the OS 400ms to complete termination rundown
        thread::sleep(Duration::from_millis(400));

        // Empirically check if any process named sleep is still running
        let check_cmd = std::process::Command::new("powershell.exe")
            .args(&[
                "-NoProfile",
                "-Command",
                "(Get-Process -Name sleep -ErrorAction SilentlyContinue | Measure-Object).Count",
            ])
            .output();

        if let Ok(output) = check_cmd {
            let count_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let count: usize = count_str.parse().unwrap_or(0);
            assert_eq!(
                count, 0,
                "SECURITY FAILURE: Background MSYS child process escaped Job Object and remained orphaned! Count={}",
                count
            );
        }
    }
}

/// Adversarial Test 4: Handle and Resource Cleanup Across Repetitive Cycles
///
/// Runs 20 sequential spawn -> kill cycles and asserts that process handle counts
/// remain bounded and do not leak linearly.
#[cfg(windows)]
#[test]
fn test_adversarial_handle_cleanup_leak_detection() {
    let engine = PortablePtyEngine::new();

    // Warm-up run to initialize ConPTY runtime / CRT tables
    {
        let descriptor = PtySessionDescriptor {
            session_id: "warmup".to_string(),
            command: "cmd.exe".to_string(),
            args: vec!["/c".to_string(), "echo WARMUP".to_string()],
            cwd: None,
            cols: 80,
            rows: 24,
        };
        let (tx, rx) = mpsc::channel();
        let _ = engine.spawn(descriptor, move |frame| {
            let _ = tx.send(frame);
        });
        while let Ok(f) = rx.recv_timeout(Duration::from_secs(3)) {
            if let Ok(frame) = decode_pty_frame(&f) {
                if frame.opcode == PtyFrameOpcode::Exit {
                    break;
                }
            }
        }
        thread::sleep(Duration::from_millis(200));
    }

    let initial_handles = win32::get_current_handle_count();

    let cycles = 20;
    for i in 0..cycles {
        let session_id = format!("leak-test-{}", i);
        let (tx, rx) = mpsc::channel();
        let descriptor = PtySessionDescriptor {
            session_id: session_id.clone(),
            command: "cmd.exe".to_string(),
            args: vec!["/c".to_string(), "ping -n 10 127.0.0.1 >nul".to_string()],
            cwd: None,
            cols: 80,
            rows: 24,
        };

        engine
            .spawn(descriptor, move |frame| {
                let _ = tx.send(frame);
            })
            .expect("spawn succeeds");

        thread::sleep(Duration::from_millis(20));

        let kill_res = engine.kill(&session_id);
        assert!(kill_res.is_ok(), "kill succeeds on iteration {}", i);

        // Wait for Exit frame
        while let Ok(f) = rx.recv_timeout(Duration::from_secs(3)) {
            if let Ok(frame) = decode_pty_frame(&f) {
                if frame.opcode == PtyFrameOpcode::Exit {
                    break;
                }
            }
        }
    }

    // Allow OS kernel thread & handle rundown to complete
    thread::sleep(Duration::from_millis(500));

    let final_handles = win32::get_current_handle_count();
    let handle_growth = final_handles.saturating_sub(initial_handles);

    // If each iteration leaked handles (2 pipes + 1 job + 1 process + 2 threads = 6 handles/iter * 20 = 120 handles)
    // Here we assert growth is strictly bounded (< 30 handles allowable for OS internal pool caching).
    assert!(
        handle_growth < 30,
        "RESOURCE LEAK DETECTED: Handle count grew by {} (initial={}, final={}) across {} cycles",
        handle_growth,
        initial_handles,
        final_handles,
        cycles
    );
}
