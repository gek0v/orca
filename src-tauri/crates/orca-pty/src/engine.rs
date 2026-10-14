//! High-performance PTY engine powered by portable-pty.
//!
//! Provides cross-platform pseudo-terminal management (ConPTY on Windows, POSIX /dev/ptmx on Unix)
//! with 16-byte binary framing and streaming callbacks.

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use orca_core::process::ProcessJobObject;

use crate::framing::{encode_pty_frame, PtyFrameOpcode};
use crate::{PtyDimensions, PtyError, PtySessionDescriptor};

struct ActiveSession {
    _stream_id: u32,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[allow(dead_code)]
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    #[allow(dead_code)]
    job_object: Option<ProcessJobObject>,
}

#[derive(Clone, Default)]
pub struct PortablePtyEngine {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
    next_stream_id: Arc<AtomicU32>,
}

impl PortablePtyEngine {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_stream_id: Arc::new(AtomicU32::new(1)),
        }
    }

    /// Spawns a new PTY session and launches a background thread streaming binary frames to `on_frame`.
    pub fn spawn<F>(
        &self,
        descriptor: PtySessionDescriptor,
        on_frame: F,
    ) -> Result<String, PtyError>
    where
        F: Fn(Vec<u8>) + Send + Sync + 'static,
    {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: descriptor.rows,
                cols: descriptor.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::SpawnError(format!("Failed to open PTY pair: {}", e)))?;

        let mut cmd = CommandBuilder::new(&descriptor.command);
        cmd.args(&descriptor.args);
        if let Some(ref cwd) = descriptor.cwd {
            cmd.cwd(cwd);
        }

        // Win32 Job Object guard: ensures child processes never escape
        let job_object = ProcessJobObject::create().ok();

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::SpawnError(format!("Failed to spawn command in PTY: {}", e)))?;

        // On Windows, retrieve raw handle and assign to Job Object to contain process and children
        #[cfg(windows)]
        if let Some(ref job) = job_object {
            if let Some(handle) = child.as_raw_handle() {
                if let Err(e) = job.assign_process(handle) {
                    tracing::warn!("Failed to assign child process to Job Object: {}", e);
                }
            }
        }

        let killer = child.clone_killer();

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::IoError(format!("Failed to clone PTY reader: {}", e)))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::IoError(format!("Failed to take PTY writer: {}", e)))?;

        let stream_id = self.next_stream_id.fetch_add(1, Ordering::Relaxed);
        let session_id = descriptor.session_id.clone();
        let writer_arc = Arc::new(Mutex::new(writer));
        let child_arc = Arc::new(Mutex::new(child));

        {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.insert(
                session_id.clone(),
                ActiveSession {
                    _stream_id: stream_id,
                    master: Some(pair.master),
                    writer: writer_arc.clone(),
                    killer,
                    child: child_arc.clone(),
                    job_object,
                },
            );
        }

        // Spawn background reader thread streaming chunks as 16-byte framed binary packets
        let child_arc_reader = child_arc.clone();
        let sessions_ref = self.sessions.clone();
        let sess_id_clone = session_id.clone();

        // Background watcher that unblocks reader when child process finishes
        let child_arc_watcher = child_arc.clone();
        let sessions_map_watcher = self.sessions.clone();
        let sess_id_watcher = session_id.clone();

        thread::spawn(move || {
            let _ = {
                let mut child_guard = child_arc_watcher.lock().unwrap();
                child_guard.wait()
            };
            // Child process has exited. Retire master to signal EOF on the ConPTY output pipe
            // (ClosePseudoConsole), enabling the reader thread to drain trailing output cleanly.
            let mut sessions = sessions_map_watcher.lock().unwrap();
            if let Some(session) = sessions.get_mut(&sess_id_watcher) {
                let _ = session.master.take();
            }
        });

        thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut sequence: u64 = 0;

            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let frame = encode_pty_frame(
                            PtyFrameOpcode::Output,
                            stream_id,
                            sequence,
                            &buffer[..n],
                        );
                        sequence += 1;
                        on_frame(frame);
                    }
                    Err(_) => break, // Pipe broken / closed
                }
            }

            // Retrieve child exit code and emit Exit frame
            let exit_code: u32 = {
                let mut child_guard = child_arc_reader.lock().unwrap();
                match child_guard.try_wait() {
                    Ok(Some(status)) => status.exit_code(),
                    Ok(None) => match child_guard.wait() {
                        Ok(status) => status.exit_code(),
                        Err(_) => 0,
                    },
                    Err(_) => 0,
                }
            };

            let exit_frame = encode_pty_frame(
                PtyFrameOpcode::Exit,
                stream_id,
                sequence,
                &exit_code.to_le_bytes(),
            );
            on_frame(exit_frame);

            // Clean up session entry from registry if not already removed
            let mut sessions = sessions_ref.lock().unwrap();
            sessions.remove(&sess_id_clone);
        });


        Ok(session_id)
    }

    /// Writes raw input bytes to the PTY session.
    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), PtyError> {
        let writer_arc = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(session_id)
                .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;
            session.writer.clone()
        };

        let mut writer = writer_arc.lock().unwrap();
        writer
            .write_all(data)
            .map_err(|e| PtyError::IoError(format!("Write failed: {}", e)))?;
        writer
            .flush()
            .map_err(|e| PtyError::IoError(format!("Flush failed: {}", e)))?;
        Ok(())
    }

    /// Resizes the PTY session window dimensions.
    pub fn resize(&self, session_id: &str, dimensions: PtyDimensions) -> Result<(), PtyError> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;

        if let Some(ref mut master) = session.master {
            master
                .resize(PtySize {
                    rows: dimensions.rows,
                    cols: dimensions.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| PtyError::IoError(format!("Resize failed: {}", e)))?;
        }

        Ok(())
    }

    /// Terminates the PTY session without deadlocking child watcher threads.
    pub fn kill(&self, session_id: &str) -> Result<(), PtyError> {
        let mut session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(session_id)
        }
        .ok_or_else(|| PtyError::SessionNotFound(session_id.to_string()))?;

        if let Some(ref job) = session.job_object {
            let _ = job.terminate(1);
        }
        let _ = session.killer.kill();
        let _ = session.master.take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    use crate::framing::decode_pty_frame;

    #[test]
    fn test_engine_spawn_echo_and_exit() {
        let engine = PortablePtyEngine::new();
        let (tx, rx) = mpsc::channel();

        #[cfg(windows)]
        let (cmd, args) = ("cmd.exe".to_string(), vec!["/c".to_string(), "echo HELLO_PTY_ENGINE".to_string()]);
        #[cfg(not(windows))]
        let (cmd, args) = ("sh".to_string(), vec!["-c".to_string(), "echo HELLO_PTY_ENGINE".to_string()]);

        let descriptor = PtySessionDescriptor {
            session_id: "test-echo".to_string(),
            command: cmd,
            args,
            cwd: None,
            cols: 80,
            rows: 24,
        };

        let session_id = engine.spawn(descriptor, move |frame| {
            let _ = tx.send(frame);
        }).expect("spawn succeeds");

        assert_eq!(session_id, "test-echo");

        let mut received_output = false;
        let mut received_exit = false;

        while let Ok(frame_data) = rx.recv_timeout(Duration::from_secs(5)) {
            let frame = decode_pty_frame(&frame_data).expect("valid frame");
            match frame.opcode {
                PtyFrameOpcode::Output => {
                    let text = String::from_utf8_lossy(&frame.payload);
                    if text.contains("HELLO_PTY_ENGINE") {
                        received_output = true;
                    }
                }
                PtyFrameOpcode::Exit => {
                    received_exit = true;
                    break;
                }
            }
        }

        assert!(received_output, "Did not receive expected PTY output containing HELLO_PTY_ENGINE");
        assert!(received_exit, "Did not receive exit opcode frame");
    }

    #[test]
    fn test_engine_kill_running_process_no_deadlock() {
        let engine = PortablePtyEngine::new();
        let (tx, rx) = mpsc::channel();

        #[cfg(windows)]
        let (cmd, args) = (
            "cmd.exe".to_string(),
            vec!["/c".to_string(), "ping -n 60 127.0.0.1 >nul".to_string()],
        );
        #[cfg(not(windows))]
        let (cmd, args) = ("sh".to_string(), vec!["-c".to_string(), "sleep 60".to_string()]);

        let descriptor = PtySessionDescriptor {
            session_id: "test-kill-deadlock".to_string(),
            command: cmd,
            args,
            cwd: None,
            cols: 80,
            rows: 24,
        };

        let session_id = engine
            .spawn(descriptor, move |frame| {
                let _ = tx.send(frame);
            })
            .expect("spawn succeeds");

        // Allow child process to start
        thread::sleep(Duration::from_millis(150));

        let start_time = std::time::Instant::now();
        let kill_result = engine.kill(&session_id);
        let elapsed = start_time.elapsed();

        assert!(kill_result.is_ok(), "kill must succeed on running session");
        assert!(
            elapsed < Duration::from_secs(2),
            "kill must not deadlock or block indefinitely, took {:?}",
            elapsed
        );

        // Verify Exit frame is received promptly
        let mut got_exit = false;
        while let Ok(frame_data) = rx.recv_timeout(Duration::from_secs(4)) {
            let frame = decode_pty_frame(&frame_data).expect("valid frame");
            if frame.opcode == PtyFrameOpcode::Exit {
                got_exit = true;
                break;
            }
        }
        assert!(got_exit, "Should receive Exit frame after kill");
    }

    #[cfg(windows)]
    #[test]
    fn test_job_object_assignment_and_containment() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use orca_core::process::ProcessJobObject;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();

        let job = ProcessJobObject::create().expect("Win32 Job Object creation succeeds");
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.args(&["/c", "ping -n 10 127.0.0.1 >nul"]);
        let child = pair.slave.spawn_command(cmd).expect("Child spawned");

        let raw_handle = child.as_raw_handle();
        assert!(
            raw_handle.is_some(),
            "Child process handle must be obtainable on Windows"
        );

        let assign_res = job.assign_process(raw_handle.unwrap());
        assert!(
            assign_res.is_ok(),
            "Process must be successfully assigned to Job Object: {:?}",
            assign_res.err()
        );

        // Terminating job reaps the process
        let term_res = job.terminate(1);
        assert!(term_res.is_ok(), "Job termination must succeed");
    }
}

