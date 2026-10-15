//! Background automation and decoupled task runner for Orca Relay.
//!
//! Tracks scheduled/external automation jobs, executes background tasks,
//! and maintains execution run histories.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationJob {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub run_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRunRecord {
    pub run_id: u64,
    pub job_id: String,
    pub exit_code: i32,
    pub success: bool,
    pub output_tail: String,
    pub timestamp_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum AutomationError {
    #[error("Job not found: {0}")]
    NotFound(String),
    #[error("Execution error: {0}")]
    ExecutionFailed(String),
}

pub struct AutomationManager {
    counter: AtomicU64,
    jobs: Arc<RwLock<HashMap<String, AutomationJob>>>,
    runs: Arc<RwLock<Vec<JobRunRecord>>>,
}

impl Default for AutomationManager {
    fn default() -> Self {
        Self::new()
    }
}

impl AutomationManager {
    pub fn new() -> Self {
        Self {
            counter: AtomicU64::new(1),
            jobs: Arc::new(RwLock::new(HashMap::new())),
            runs: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Registers a new automation job.
    pub async fn create_job(
        &self,
        name: impl Into<String>,
        command: impl Into<String>,
        args: Vec<String>,
        cwd: Option<String>,
    ) -> String {
        let job_id = format!("job-{}", self.counter.fetch_add(1, Ordering::SeqCst));
        let job = AutomationJob {
            id: job_id.clone(),
            name: name.into(),
            command: command.into(),
            args,
            cwd,
            run_count: 0,
        };

        let mut lock = self.jobs.write().await;
        lock.insert(job_id.clone(), job);
        job_id
    }

    /// Lists all registered jobs.
    pub async fn list_jobs(&self) -> Vec<AutomationJob> {
        let lock = self.jobs.read().await;
        lock.values().cloned().collect()
    }

    /// Runs a job in the background and records the result.
    pub async fn run_job(&self, job_id: &str) -> Result<JobRunRecord, AutomationError> {
        let job = {
            let mut lock = self.jobs.write().await;
            if let Some(j) = lock.get_mut(job_id) {
                j.run_count += 1;
                j.clone()
            } else {
                return Err(AutomationError::NotFound(job_id.to_string()));
            }
        };

        let mut cmd = tokio::process::Command::new(&job.command);
        cmd.args(&job.args);
        if let Some(ref cwd) = job.cwd {
            cmd.current_dir(cwd);
        }

        let output = cmd.output().await.map_err(|e| {
            AutomationError::ExecutionFailed(format!("Failed to spawn command: {e}"))
        })?;

        let exit_code = output.status.code().unwrap_or(-1);
        let success = output.status.success();
        let stdout_str = String::from_utf8_lossy(&output.stdout);
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        let output_tail = format!("{}\n{}", stdout_str, stderr_str).trim().to_string();

        let run_record = JobRunRecord {
            run_id: self.counter.fetch_add(1, Ordering::SeqCst),
            job_id: job_id.to_string(),
            exit_code,
            success,
            output_tail,
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };

        {
            let mut runs_lock = self.runs.write().await;
            runs_lock.push(run_record.clone());
        }

        Ok(run_record)
    }

    /// Lists run history for a specific job or all jobs.
    pub async fn list_runs(&self, job_id: Option<&str>) -> Vec<JobRunRecord> {
        let lock = self.runs.read().await;
        if let Some(jid) = job_id {
            lock.iter().filter(|r| r.job_id == jid).cloned().collect()
        } else {
            lock.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_automation_manager_lifecycle() {
        let manager = AutomationManager::new();

        let echo_cmd = if cfg!(windows) { "cmd.exe" } else { "echo" };
        let echo_args = if cfg!(windows) {
            vec![
                "/c".to_string(),
                "echo".to_string(),
                "hello automation".to_string(),
            ]
        } else {
            vec!["hello automation".to_string()]
        };

        let jid = manager
            .create_job("echo-job", echo_cmd, echo_args, None)
            .await;

        let jobs = manager.list_jobs().await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, jid);

        let run = manager.run_job(&jid).await.unwrap();
        assert!(run.success);
        assert!(run.output_tail.contains("hello automation"));

        let history = manager.list_runs(Some(&jid)).await;
        assert_eq!(history.len(), 1);
    }
}
