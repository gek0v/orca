use crate::session::{PtyError, PtySessionConfig};
use bytes::Bytes;
use nix::fcntl::{fcntl, FcntlArg, OFlag};
use nix::pty::openpty;
use nix::sys::signal::{kill, Signal};
use nix::unistd::{close, dup2, execvp, fork, setsid, ForkResult, Pid};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::Duration;
use tokio::io::unix::AsyncFd;
use tokio::sync::{mpsc, Mutex};
use tokio::time::sleep;

pub struct UnixPtySession {
    master_fd: OwnedFd,
    child_pid: i32,
    output_rx: Mutex<mpsc::Receiver<Bytes>>,
    paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pause_notify: std::sync::Arc<tokio::sync::Notify>,
}

pub async fn spawn_unix_pty(config: PtySessionConfig) -> Result<UnixPtySession, PtyError> {
    let pty = openpty(None, None)
        .map_err(|e| PtyError::SpawnFailed(format!("openpty failed: {:?}", e)))?;

    let master_fd = pty.master;
    let slave_fd = pty.slave;

    // Set master non-blocking
    let flags = fcntl(master_fd.as_raw_fd(), FcntlArg::F_GETFL)
        .map_err(|e| PtyError::SpawnFailed(format!("fcntl F_GETFL failed: {:?}", e)))?;
    let oflags = OFlag::from_bits_truncate(flags) | OFlag::O_NONBLOCK;
    fcntl(master_fd.as_raw_fd(), FcntlArg::F_SETFL(oflags))
        .map_err(|e| PtyError::SpawnFailed(format!("fcntl F_SETFL failed: {:?}", e)))?;

    match unsafe { fork() } {
        Ok(ForkResult::Parent { child }) => {
            // Close slave in parent
            drop(slave_fd);

            let (output_tx, output_rx) = mpsc::channel(256);
            let raw_master = master_fd.as_raw_fd();

            // Spawn reader task
            tokio::spawn(async move {
                let Ok(async_fd) = AsyncFd::new(raw_master) else {
                    return;
                };
                let mut buf = [0u8; 8192];
                loop {
                    let Ok(mut guard) = async_fd.readable().await else {
                        break;
                    };
                    match guard.try_io(|fd| {
                        let res = nix::unistd::read(*fd, &mut buf);
                        res.map_err(std::io::Error::from)
                    }) {
                        Ok(Ok(n)) if n > 0 => {
                            let chunk = Bytes::copy_from_slice(&buf[..n]);
                            if output_tx.send(chunk).await.is_err() {
                                break;
                            }
                        }
                        Ok(Ok(_)) => break,
                        Ok(Err(_)) => break,
                        Err(_would_block) => continue,
                    }
                }
            });

            let paused = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let pause_notify = std::sync::Arc::new(tokio::sync::Notify::new());

            Ok(UnixPtySession {
                master_fd,
                child_pid: child.as_raw(),
                output_rx: Mutex::new(output_rx),
                paused,
                pause_notify,
            })
        }
        Ok(ForkResult::Child) => {
            drop(master_fd);

            // Create new session & process group
            let _ = setsid();

            // Duplicate slave to stdin, stdout, stderr
            let slave_raw = slave_fd.as_raw_fd();
            let _ = dup2(slave_raw, 0);
            let _ = dup2(slave_raw, 1);
            let _ = dup2(slave_raw, 2);
            if slave_raw > 2 {
                let _ = close(slave_raw);
            }

            if let Some(ref cwd) = config.cwd {
                let _ = std::env::set_current_dir(cwd);
            }

            for (k, v) in &config.env {
                std::env::set_var(k, v);
            }

            let cmd_c = CString::new(config.command.clone()).unwrap_or_default();
            let mut args_c = vec![cmd_c.clone()];
            for a in &config.args {
                if let Ok(c) = CString::new(a.clone()) {
                    args_c.push(c);
                }
            }

            let _ = execvp(&cmd_c, &args_c);
            std::process::exit(1);
        }
        Err(e) => Err(PtyError::SpawnFailed(format!("fork failed: {:?}", e))),
    }
}

impl UnixPtySession {
    pub fn pid(&self) -> u32 {
        self.child_pid as u32
    }

    pub fn pause(&self) {
        self.paused.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn resume(&self) {
        self.paused
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.pause_notify.notify_waiters();
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub async fn write_input(&self, data: &[u8]) -> Result<(), PtyError> {
        nix::unistd::write(&self.master_fd, data)
            .map_err(|e| PtyError::Io(std::io::Error::from_raw_os_error(e as i32)))?;
        Ok(())
    }

    pub async fn next_output(&self) -> Option<Bytes> {
        loop {
            if self.paused.load(std::sync::atomic::Ordering::SeqCst) {
                self.pause_notify.notified().await;
                continue;
            }
            let chunk = {
                let mut rx = self.output_rx.lock().await;
                rx.recv().await
            };
            if self.paused.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(c) = chunk {
                    self.pause_notify.notified().await;
                    return Some(c);
                } else {
                    return None;
                }
            }
            return chunk;
        }
    }

    pub async fn signal(&self, sig: &str) -> Result<(), PtyError> {
        let s = sig.trim().to_ascii_uppercase();
        let signal = match s.as_str() {
            "SIGINT" | "INT" => Signal::SIGINT,
            "SIGTERM" | "TERM" => Signal::SIGTERM,
            "SIGHUP" | "HUP" => Signal::SIGHUP,
            "SIGKILL" | "KILL" => Signal::SIGKILL,
            "SIGQUIT" | "QUIT" => Signal::SIGQUIT,
            "SIGWINCH" | "WINCH" => Signal::SIGWINCH,
            "SIGUSR1" | "USR1" => Signal::SIGUSR1,
            "SIGUSR2" | "USR2" => Signal::SIGUSR2,
            _ => {
                return Err(PtyError::OperationFailed(format!(
                    "Unsupported signal: {}",
                    sig
                )));
            }
        };
        if signal == Signal::SIGINT {
            let _ = nix::unistd::write(&self.master_fd, b"\x03");
        }
        if kill(Pid::from_raw(-self.child_pid), signal).is_err() {
            let _ = kill(Pid::from_raw(self.child_pid), signal);
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        #[repr(C)]
        struct Winsize {
            ws_row: u16,
            ws_col: u16,
            ws_xpixel: u16,
            ws_ypixel: u16,
        }
        let ws = Winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        const TIOCSWINSZ: nix::sys::ioctl::ioctl_num_type = 0x5414;
        let res = unsafe { libc::ioctl(self.master_fd.as_raw_fd(), TIOCSWINSZ as _, &ws) };
        if res < 0 {
            Err(PtyError::ResizeFailed("ioctl TIOCSWINSZ failed".into()))
        } else {
            Ok(())
        }
    }

    pub async fn terminate(&self) -> Result<(), PtyError> {
        let _pgid = Pid::from_raw(self.child_pid);
        // Send SIGHUP/SIGTERM to process group
        let _ = kill(Pid::from_raw(-self.child_pid), Signal::SIGTERM);
        sleep(Duration::from_millis(100)).await;
        // Escalate to SIGKILL if still running
        let _ = kill(Pid::from_raw(-self.child_pid), Signal::SIGKILL);
        Ok(())
    }
}

pub fn warm_windows_conpty_once() {}
