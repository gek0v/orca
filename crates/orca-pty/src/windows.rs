use crate::session::{PtyError, PtySessionConfig};
use bytes::Bytes;
use std::ffi::c_void;
use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, STARTUPINFOEXW,
};

pub struct WindowsPtySession {
    job_handle: AtomicUsize,
    process_handle: AtomicUsize,
    hpc: AtomicIsize,
    input_write_handle: AtomicUsize,
    output_rx: Mutex<mpsc::Receiver<Bytes>>,
    pid: u32,
    closed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

unsafe impl Send for WindowsPtySession {}
unsafe impl Sync for WindowsPtySession {}

pub async fn spawn_windows_pty(config: PtySessionConfig) -> Result<WindowsPtySession, PtyError> {
    unsafe {
        // 1. Create Win32 Job Object with strict breakaway denial
        let job_handle = CreateJobObjectW(None, None)
            .map_err(|e| PtyError::SpawnFailed(format!("CreateJobObject failed: {:?}", e)))?;

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags =
            windows::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        SetInformationJobObject(
            job_handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| PtyError::SpawnFailed(format!("SetInformationJobObject failed: {:?}", e)))?;

        // 2. Create pipes for PseudoConsole
        let mut pty_in_read = HANDLE::default();
        let mut pty_in_write = HANDLE::default();
        let mut pty_out_read = HANDLE::default();
        let mut pty_out_write = HANDLE::default();

        CreatePipe(&mut pty_in_read, &mut pty_in_write, None, 0)
            .map_err(|e| PtyError::SpawnFailed(format!("CreatePipe in failed: {:?}", e)))?;
        CreatePipe(&mut pty_out_read, &mut pty_out_write, None, 0)
            .map_err(|e| PtyError::SpawnFailed(format!("CreatePipe out failed: {:?}", e)))?;

        let size = COORD {
            X: config.cols as i16,
            Y: config.rows as i16,
        };

        let hpc = CreatePseudoConsole(size, pty_in_read, pty_out_write, 0)
            .map_err(|e| PtyError::SpawnFailed(format!("CreatePseudoConsole failed: {:?}", e)))?;

        CloseHandle(pty_in_read).ok();
        CloseHandle(pty_out_write).ok();

        // 3. Setup STARTUPINFOEXW with ConPTY attribute
        let mut attr_size: usize = 0;
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attr_size);
        let mut attr_buf = vec![0u8; attr_size];
        let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as *mut c_void);
        InitializeProcThreadAttributeList(Some(attr_list), 1, None, &mut attr_size).map_err(
            |e| PtyError::SpawnFailed(format!("InitializeProcThreadAttributeList failed: {:?}", e)),
        )?;

        const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x00020016;
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            Some(hpc.0 as *const c_void),
            std::mem::size_of::<HPCON>(),
            None,
            None,
        )
        .map_err(|e| PtyError::SpawnFailed(format!("UpdateProcThreadAttribute failed: {:?}", e)))?;

        let mut startup_info: STARTUPINFOEXW = std::mem::zeroed();
        startup_info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup_info.StartupInfo.dwFlags |= windows::Win32::System::Threading::STARTF_USESTDHANDLES;
        startup_info.lpAttributeList = attr_list;

        let mut cmd_line_str = format!("\"{}\"", config.command);
        for arg in &config.args {
            cmd_line_str.push(' ');
            cmd_line_str.push_str(arg);
        }
        let mut cmd_line_utf16: Vec<u16> = cmd_line_str
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        let mut proc_info: PROCESS_INFORMATION = std::mem::zeroed();

        CreateProcessW(
            None,
            Some(PWSTR(cmd_line_utf16.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | windows::Win32::System::Threading::CREATE_SUSPENDED,
            None,
            None,
            &startup_info.StartupInfo,
            &mut proc_info,
        )
        .map_err(|e| PtyError::SpawnFailed(format!("CreateProcessW failed: {:?}", e)))?;

        DeleteProcThreadAttributeList(attr_list);

        let _ = AssignProcessToJobObject(job_handle, proc_info.hProcess);
        windows::Win32::System::Threading::ResumeThread(proc_info.hThread);
        CloseHandle(proc_info.hThread).ok();

        let input_write_handle = pty_in_write.0 as usize;
        let out_std_handle = pty_out_read.0 as usize;
        let (output_tx, output_rx) = mpsc::channel(256);

        std::thread::Builder::new()
            .name("orca-pty-reader".into())
            .spawn(move || {
                let handle = HANDLE(out_std_handle as _);
                let mut buffer = [0u8; 8192];
                loop {
                    let mut bytes_read = 0u32;
                    let res = ReadFile(handle, Some(&mut buffer), Some(&mut bytes_read), None);
                    if res.is_ok() && bytes_read > 0 {
                        let chunk = Bytes::copy_from_slice(&buffer[..bytes_read as usize]);
                        if output_tx.blocking_send(chunk).is_err() {
                            break;
                        }
                    } else {
                        break;
                    }
                }
                CloseHandle(handle).ok();
            })
            .map_err(|e| {
                PtyError::SpawnFailed(format!("Failed to spawn reader thread: {:?}", e))
            })?;

        let closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closed_waiter = std::sync::Arc::clone(&closed);
        let proc_handle_for_wait = proc_info.hProcess.0 as usize;
        let hpc_raw = hpc.0;

        std::thread::Builder::new()
            .name("orca-pty-waiter".into())
            .spawn(move || {
                use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
                WaitForSingleObject(HANDLE(proc_handle_for_wait as _), INFINITE);
                if !closed_waiter.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    ClosePseudoConsole(HPCON(hpc_raw));
                }
            })
            .ok();

        Ok(WindowsPtySession {
            job_handle: AtomicUsize::new(job_handle.0 as usize),
            process_handle: AtomicUsize::new(proc_info.hProcess.0 as usize),
            hpc: AtomicIsize::new(hpc.0),
            input_write_handle: AtomicUsize::new(input_write_handle),
            output_rx: Mutex::new(output_rx),
            pid: proc_info.dwProcessId,
            closed,
        })
    }
}

impl WindowsPtySession {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub async fn write_input(&self, data: &[u8]) -> Result<(), PtyError> {
        let raw = self.input_write_handle.load(Ordering::SeqCst);
        if raw == 0 {
            return Err(PtyError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "PTY input handle closed",
            )));
        }
        let handle = HANDLE(raw as _);
        let mut written = 0u32;
        unsafe {
            WriteFile(handle, Some(data), Some(&mut written), None)
                .map_err(|e| PtyError::Io(std::io::Error::from_raw_os_error(e.code().0)))?;
        }
        Ok(())
    }

    pub async fn next_output(&self) -> Option<Bytes> {
        let mut rx = self.output_rx.lock().await;
        rx.recv().await
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        let raw_hpc = self.hpc.load(Ordering::SeqCst);
        if raw_hpc == 0 {
            return Ok(());
        }
        let size = COORD {
            X: cols as i16,
            Y: rows as i16,
        };
        unsafe {
            ResizePseudoConsole(HPCON(raw_hpc), size)
                .map_err(|e| PtyError::ResizeFailed(format!("{:?}", e)))
        }
    }

    pub async fn terminate(&self) -> Result<(), PtyError> {
        let job = self.job_handle.swap(0, Ordering::SeqCst);
        let proc = self.process_handle.swap(0, Ordering::SeqCst);
        let in_pipe = self.input_write_handle.swap(0, Ordering::SeqCst);
        let hpc = self.hpc.swap(0, Ordering::SeqCst);

        if job != 0 {
            unsafe {
                let _ = TerminateJobObject(HANDLE(job as _), 1);
                if in_pipe != 0 {
                    let _ = CloseHandle(HANDLE(in_pipe as _));
                }
            }

            let was_closed = self.closed.swap(true, Ordering::SeqCst);
            std::thread::spawn(move || unsafe {
                if !was_closed && hpc != 0 {
                    ClosePseudoConsole(HPCON(hpc));
                }
                if proc != 0 {
                    let _ = CloseHandle(HANDLE(proc as _));
                }
                let _ = CloseHandle(HANDLE(job as _));
            });
        }

        Ok(())
    }
}

impl Drop for WindowsPtySession {
    fn drop(&mut self) {
        let job = self.job_handle.swap(0, Ordering::SeqCst);
        let proc = self.process_handle.swap(0, Ordering::SeqCst);
        let in_pipe = self.input_write_handle.swap(0, Ordering::SeqCst);
        let hpc = self.hpc.swap(0, Ordering::SeqCst);

        if job != 0 {
            unsafe {
                let _ = TerminateJobObject(HANDLE(job as _), 1);
                if in_pipe != 0 {
                    let _ = CloseHandle(HANDLE(in_pipe as _));
                }
            }

            let was_closed = self.closed.swap(true, Ordering::SeqCst);
            std::thread::spawn(move || unsafe {
                if !was_closed && hpc != 0 {
                    ClosePseudoConsole(HPCON(hpc));
                }
                if proc != 0 {
                    let _ = CloseHandle(HANDLE(proc as _));
                }
                let _ = CloseHandle(HANDLE(job as _));
            });
        }
    }
}
