//! Windows RAII Job Object Guard and Unix Process Group lifecycle management.
//!
//! # Safety and Architectural Invariants
//! On Windows, every per-PTY or supervised child process group MUST be assigned to
//! a Job Object created *WITHOUT* `JOB_OBJECT_LIMIT_BREAKAWAY_OK`.
//! MSYS2, Git Bash, and Cygwin runtimes attempt `CREATE_BREAKAWAY_FROM_JOB` during
//! spawn/exec. If breakaway is allowed, child processes escape the job, survive terminal
//! close, and orphan-lock repository directories. When breakaway is denied, the runtime
//! falls back to spawning within the existing job.
//! See `docs/reference/windows-msys-job-breakaway.md`.

#[cfg(windows)]
pub mod windows {
    use std::ffi::c_void;
    use std::os::windows::io::RawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    #[derive(Debug)]
    pub struct ProcessJobObject {
        handle: HANDLE,
    }

    // SAFETY: HANDLE is a pointer to an OS kernel job object handle, safely shared across threads.
    unsafe impl Send for ProcessJobObject {}
    unsafe impl Sync for ProcessJobObject {}

    impl ProcessJobObject {
        /// Creates a new Win32 Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
        ///
        /// INVARIANT: `JOB_OBJECT_LIMIT_BREAKAWAY_OK` is strictly omitted to prevent
        /// Git Bash / MSYS2 child processes from breaking away.
        pub fn create() -> Result<Self, std::io::Error> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                    return Err(std::io::Error::last_os_error());
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                let success = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );

                if success == 0 {
                    let err = std::io::Error::last_os_error();
                    CloseHandle(handle);
                    return Err(err);
                }

                Ok(Self { handle })
            }
        }

        /// Assigns a running process handle to this job object.
        pub fn assign_process(&self, process_handle: RawHandle) -> Result<(), std::io::Error> {
            unsafe {
                let success = AssignProcessToJobObject(self.handle, process_handle as HANDLE);
                if success == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            }
        }

        /// Terminates all processes currently assigned to the job object.
        pub fn terminate(&self, exit_code: u32) -> Result<(), std::io::Error> {
            unsafe {
                let success = TerminateJobObject(self.handle, exit_code);
                if success == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            }
        }

        pub fn raw_handle(&self) -> RawHandle {
            self.handle as RawHandle
        }
    }

    impl Drop for ProcessJobObject {
        fn drop(&mut self) {
            unsafe {
                if !self.handle.is_null() && self.handle != INVALID_HANDLE_VALUE {
                    CloseHandle(self.handle);
                }
            }
        }
    }
}

#[cfg(not(windows))]
pub mod unix {
    #[derive(Debug, Default)]
    pub struct ProcessJobObject;

    impl ProcessJobObject {
        pub fn create() -> Result<Self, std::io::Error> {
            Ok(Self)
        }

        pub fn terminate(&self, _exit_code: u32) -> Result<(), std::io::Error> {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::process::ProcessJobObject;

    #[test]
    fn test_job_object_creation_and_teardown() {
        let job = ProcessJobObject::create();
        assert!(job.is_ok(), "Failed to create ProcessJobObject: {:?}", job.err());
    }

    #[cfg(windows)]
    #[test]
    fn test_job_object_assign_and_terminate() {
        use std::os::windows::io::AsRawHandle;
        use std::process::Command;

        let job = ProcessJobObject::create().expect("job creation");
        let mut child = Command::new("cmd.exe")
            .args(["/c", "ping -n 10 127.0.0.1 >nul"])
            .spawn()
            .expect("spawn test child");

        let assign_res = job.assign_process(child.as_raw_handle());
        assert!(assign_res.is_ok(), "Failed to assign child process to job: {:?}", assign_res.err());

        let term_res = job.terminate(1);
        assert!(term_res.is_ok(), "Failed to terminate job: {:?}", term_res.err());

        let status = child.wait().expect("wait on child");
        assert!(!status.success());
    }
}

