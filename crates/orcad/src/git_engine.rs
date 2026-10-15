use orca_protocol::git_porcelain::parse_git_worktree_porcelain;
use orca_protocol::models::{GitExecResponse, GitWorktreeInfo};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct GitEngine;

impl GitEngine {
    pub fn new() -> Self {
        Self
    }

    pub async fn exec(
        &self,
        cwd: &Path,
        args: &[String],
        timeout: Duration,
        env: Option<&HashMap<String, String>>,
    ) -> Result<GitExecResponse, String> {
        let mut cmd = tokio::process::Command::new("git");
        cmd.kill_on_drop(true);
        cmd.current_dir(cwd);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Credential and interactive prompt suppression
        cmd.arg("-c").arg("core.askPass=");
        cmd.arg("-c").arg("credential.helper=");
        cmd.env("GIT_TERMINAL_PROMPT", "0");

        if let Some(custom_env) = env {
            for (k, v) in custom_env {
                cmd.env(k, v);
            }
        }

        for arg in args {
            cmd.arg(arg);
        }

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let start = Instant::now();
        let output = match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(format!("Failed to execute git: {e}")),
            Err(_) => return Err(format!("Git command timed out after {:?}", timeout)),
        };
        let duration_ms = start.elapsed().as_millis() as u64;

        let exit_code = output.status.code().unwrap_or(-1);
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        Ok(GitExecResponse {
            exit_code,
            stdout,
            stderr,
            duration_ms,
        })
    }

    pub async fn status_porcelain(&self, cwd: &Path) -> Result<String, String> {
        let res = self
            .exec(
                cwd,
                &["status".into(), "--porcelain=v1".into()],
                Duration::from_secs(5),
                None,
            )
            .await?;
        if res.exit_code == 0 {
            Ok(res.stdout)
        } else {
            Err(res.stderr)
        }
    }

    pub async fn worktree_list(&self, repo: &Path) -> Result<Vec<GitWorktreeInfo>, String> {
        let res = self
            .exec(
                repo,
                &["worktree".into(), "list".into(), "--porcelain".into()],
                Duration::from_secs(5),
                None,
            )
            .await?;
        if res.exit_code == 0 {
            Ok(parse_git_worktree_porcelain(&res.stdout, false))
        } else {
            Err(res.stderr)
        }
    }

    pub async fn worktree_add(
        &self,
        repo: &Path,
        path: &Path,
        branch: Option<&str>,
        base_commit: Option<&str>,
    ) -> Result<(), String> {
        let mut args: Vec<String> = vec!["worktree".into(), "add".into()];
        if let Some(b) = branch {
            args.push("-b".into());
            args.push(b.into());
        }
        args.push(path.to_string_lossy().to_string());
        if let Some(base) = base_commit {
            args.push(base.into());
        }

        let res = self
            .exec(repo, &args, Duration::from_secs(10), None)
            .await?;
        if res.exit_code == 0 {
            Ok(())
        } else {
            Err(res.stderr)
        }
    }

    pub async fn worktree_remove(
        &self,
        repo: &Path,
        path: &Path,
        force: bool,
    ) -> Result<(), String> {
        let mut args: Vec<String> = vec!["worktree".into(), "remove".into()];
        if force {
            args.push("--force".into());
        }
        args.push(path.to_string_lossy().to_string());

        let res = self
            .exec(repo, &args, Duration::from_secs(10), None)
            .await?;
        if res.exit_code == 0 {
            Ok(())
        } else {
            Err(res.stderr)
        }
    }

    pub async fn worktree_lock(
        &self,
        repo: &Path,
        path: &Path,
        reason: Option<&str>,
    ) -> Result<(), String> {
        let mut args: Vec<String> = vec!["worktree".into(), "lock".into()];
        if let Some(r) = reason {
            args.push("--reason".into());
            args.push(r.into());
        }
        args.push(path.to_string_lossy().to_string());

        let res = self.exec(repo, &args, Duration::from_secs(5), None).await?;
        if res.exit_code == 0 {
            Ok(())
        } else {
            Err(res.stderr)
        }
    }

    pub async fn worktree_unlock(&self, repo: &Path, path: &Path) -> Result<(), String> {
        let args: Vec<String> = vec![
            "worktree".into(),
            "unlock".into(),
            path.to_string_lossy().to_string(),
        ];
        let res = self.exec(repo, &args, Duration::from_secs(5), None).await?;
        if res.exit_code == 0 {
            Ok(())
        } else {
            Err(res.stderr)
        }
    }
}
