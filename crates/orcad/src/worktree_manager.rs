use orca_protocol::models::{WorktreeCreateParams, WorktreeItem, WorktreeRmParams};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use crate::agent_status_store::{AgentStatusStore, AgentVerdict};

pub struct WorktreeManager {
    status_store: Arc<AgentStatusStore>,
}

impl WorktreeManager {
    pub fn new(status_store: Arc<AgentStatusStore>) -> Self {
        Self { status_store }
    }

    pub async fn list_worktrees(
        &self,
        repo: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<WorktreeItem> {
        let mut items = Vec::new();

        // 1. Attempt git worktree list --porcelain
        if let Some(git_items) = self.read_git_worktrees(repo).await {
            items.extend(git_items);
        }

        // 2. Supplement with entries from AgentStatusStore (supporting folder workspaces)
        let store_rows = self.status_store.list_all().await;
        for row in store_rows {
            let already_exists = items.iter().any(|item| item.id == row.session_id);
            if !already_exists {
                items.push(WorktreeItem {
                    id: row.session_id.clone(),
                    branch: row.session_id,
                    path: row.description,
                    head: None,
                    status: match row.verdict {
                        AgentVerdict::Live => "live".to_string(),
                        AgentVerdict::Unverifiable => "unverifiable".to_string(),
                        AgentVerdict::Exited => "exited".to_string(),
                    },
                    is_main: false,
                });
            }
        }

        if let Some(l) = limit {
            items.truncate(l);
        }

        items
    }

    pub async fn show_worktree(&self, selector: &str) -> Option<WorktreeItem> {
        let all = self.list_worktrees(None, None).await;
        all.into_iter().find(|w| {
            w.id == selector
                || w.branch == selector
                || w.path == selector
                || (selector == "active" && w.is_main)
        })
    }

    pub async fn create_worktree(
        &self,
        params: WorktreeCreateParams,
    ) -> Result<WorktreeItem, String> {
        let name = params
            .name
            .or_else(|| params.branch.clone())
            .unwrap_or_else(|| format!("wt-{}", std::process::id()));

        let branch = params.branch.unwrap_or_else(|| name.clone());
        let target_path = params
            .path
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join(&name));

        let path_str = target_path.to_string_lossy().to_string();

        // Run git worktree add with non-blocking timeout and closed stdin
        let mut git_success = false;
        let mut cmd = tokio::process::Command::new("git");
        cmd.kill_on_drop(true);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.arg("-c")
            .arg("core.askPass=")
            .arg("-c")
            .arg("credential.helper=");

        cmd.arg("worktree")
            .arg("add")
            .arg("-b")
            .arg(&branch)
            .arg(&target_path);

        if let Some(base) = params.base_branch.as_deref() {
            cmd.arg(base);
        }

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(2), cmd.output()).await {
            if output.status.success() {
                git_success = true;
            }
        }

        // If not git or git timed out/failed (e.g. folder workspace), ensure directory exists
        if !git_success {
            let _ = std::fs::create_dir_all(&target_path);
        }

        // Register in AgentStatusStore
        self.status_store
            .update_status(&name, AgentVerdict::Live, &path_str)
            .await;

        Ok(WorktreeItem {
            id: name,
            branch,
            path: path_str,
            head: None,
            status: "live".to_string(),
            is_main: false,
        })
    }

    pub async fn remove_worktree(&self, params: WorktreeRmParams) -> Result<String, String> {
        let selector = params
            .worktree
            .or(params.path)
            .ok_or_else(|| "Missing worktree selector or path".to_string())?;

        let item = self.show_worktree(&selector).await;
        let target_path = item
            .as_ref()
            .map(|i| i.path.as_str())
            .unwrap_or(selector.as_str());

        // Try git worktree remove with non-blocking timeout and closed stdin
        let mut cmd = tokio::process::Command::new("git");
        cmd.kill_on_drop(true);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.arg("-c")
            .arg("core.askPass=")
            .arg("-c")
            .arg("credential.helper=");

        cmd.arg("worktree").arg("remove");
        if params.force {
            cmd.arg("--force");
        }
        cmd.arg(target_path);

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let _ = tokio::time::timeout(Duration::from_secs(2), cmd.output()).await;

        // Mark as Exited in AgentStatusStore
        self.status_store
            .update_status(&selector, AgentVerdict::Exited, target_path)
            .await;

        Ok(selector)
    }

    async fn read_git_worktrees(&self, repo: Option<&str>) -> Option<Vec<WorktreeItem>> {
        let mut cmd = tokio::process::Command::new("git");
        cmd.kill_on_drop(true);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.arg("-c")
            .arg("core.askPass=")
            .arg("-c")
            .arg("credential.helper=");

        if let Some(r) = repo {
            cmd.current_dir(Path::new(r));
        }
        cmd.arg("worktree").arg("list").arg("--porcelain");

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let output_res = tokio::time::timeout(Duration::from_secs(2), cmd.output()).await;
        let output = match output_res {
            Ok(Ok(out)) if out.status.success() => out,
            _ => return None,
        };

        let text = String::from_utf8_lossy(&output.stdout);
        let mut items = Vec::new();
        let mut current_path: Option<String> = None;
        let mut current_head: Option<String> = None;
        let mut current_branch: Option<String> = None;
        let mut is_first = true;

        for line in text.lines() {
            if line.is_empty() {
                if let Some(path) = current_path.take() {
                    let branch = current_branch
                        .take()
                        .unwrap_or_else(|| "detached".to_string());
                    let id = Path::new(&path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| branch.clone());

                    items.push(WorktreeItem {
                        id,
                        branch,
                        path,
                        head: current_head.take(),
                        status: "clean".to_string(),
                        is_main: is_first,
                    });
                    is_first = false;
                }
            } else if let Some(path) = line.strip_prefix("worktree ") {
                current_path = Some(path.trim().to_string());
            } else if let Some(head) = line.strip_prefix("HEAD ") {
                current_head = Some(head.trim().to_string());
            } else if let Some(branch_ref) = line.strip_prefix("branch refs/heads/") {
                current_branch = Some(branch_ref.trim().to_string());
            }
        }

        if let Some(path) = current_path.take() {
            let branch = current_branch
                .take()
                .unwrap_or_else(|| "detached".to_string());
            let id = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| branch.clone());

            items.push(WorktreeItem {
                id,
                branch,
                path,
                head: current_head.take(),
                status: "clean".to_string(),
                is_main: is_first,
            });
        }

        Some(items)
    }
}
