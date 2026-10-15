use std::time::Instant;

pub struct ProcessMemoryInfo {
    pub working_set_bytes: usize,
    pub private_bytes: usize,
}

#[cfg(windows)]
pub fn get_process_memory() -> ProcessMemoryInfo {
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;

    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;

        if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb).as_bool() {
            ProcessMemoryInfo {
                working_set_bytes: counters.WorkingSetSize,
                private_bytes: counters.PagefileUsage,
            }
        } else {
            ProcessMemoryInfo {
                working_set_bytes: 0,
                private_bytes: 0,
            }
        }
    }
}

#[cfg(unix)]
pub fn get_process_memory() -> ProcessMemoryInfo {
    if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
        let parts: Vec<&str> = statm.split_whitespace().collect();
        if parts.len() >= 2 {
            let page_size = 4096;
            let resident_pages = parts[1].parse::<usize>().unwrap_or(0);
            return ProcessMemoryInfo {
                working_set_bytes: resident_pages * page_size,
                private_bytes: resident_pages * page_size,
            };
        }
    }

    ProcessMemoryInfo {
        working_set_bytes: 0,
        private_bytes: 0,
    }
}

pub struct DaemonMetrics {
    started_at: Instant,
    started_at_ms: u64,
    launch_nonce: String,
}

impl DaemonMetrics {
    pub fn new() -> Self {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let nonce = format!("{:08x}{:016x}", std::process::id(), nanos);
        Self {
            started_at: Instant::now(),
            started_at_ms: now_ms,
            launch_nonce: nonce,
        }
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }

    pub fn started_at_ms(&self) -> u64 {
        self.started_at_ms
    }

    pub fn launch_nonce(&self) -> &str {
        &self.launch_nonce
    }
}

impl Default for DaemonMetrics {
    fn default() -> Self {
        Self::new()
    }
}
