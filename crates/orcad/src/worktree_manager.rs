use orca_protocol::models::{GitWorktreeInfo, WorktreeCreateParams, WorktreeRmParams};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::agent_status_store::{AgentStatusStore, AgentVerdict};
use crate::git_engine::GitEngine;

pub struct WorktreeManager {
    status_store: Arc<AgentStatusStore>,
    git_engine: GitEngine,
}

impl WorktreeManager {
    pub fn new(status_store: Arc<AgentStatusStore>) -> Self {
        Self {
            status_store,
            git_engine: GitEngine::new(),
        }
    }

    pub fn git_engine(&self) -> &GitEngine {
        &self.git_engine
    }

    pub async fn list_worktrees(
        &self,
        repo: Option<&str>,
        limit: Option<usize>,
    ) -> Vec<GitWorktreeInfo> {
        let repo_path = repo
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let mut items = Vec::new();

        // 1. Read real Git worktrees via GitEngine porcelain parser
        if let Ok(git_items) = self.git_engine.worktree_list(&repo_path).await {
            items.extend(git_items);
        }

        // 2. Supplement with folder workspaces / sessions recorded in AgentStatusStore
        let store_rows = self.status_store.list_all().await;
        for row in store_rows {
            let already_exists = items.iter().any(|item| {
                item.path == row.description || item.branch.as_deref() == Some(&row.session_id)
            });
            if !already_exists {
                items.push(GitWorktreeInfo {
                    path: row.description,
                    head: None,
                    branch: Some(row.session_id),
                    is_bare: false,
                    is_sparse: false,
                    locked: false,
                    lock_reason: None,
                    prunable: false,
                    prunable_reason: None,
                    is_main: false,
                });
            }
        }

        if let Some(l) = limit {
            items.truncate(l);
        }

        items
    }

    pub async fn show_worktree(
        &self,
        selector: &str,
        repo: Option<&str>,
    ) -> Option<GitWorktreeInfo> {
        let all = self.list_worktrees(repo, None).await;
        all.into_iter().find(|w| {
            w.path == selector
                || w.branch.as_deref() == Some(selector)
                || (selector == "active" && w.is_main)
                || Path::new(&w.path).file_name().map(|n| n.to_string_lossy())
                    == Some(selector.into())
        })
    }

    pub async fn create_worktree(
        &self,
        params: WorktreeCreateParams,
    ) -> Result<GitWorktreeInfo, String> {
        let repo_path = params
            .repo
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

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

        let add_res = self
            .git_engine
            .worktree_add(
                &repo_path,
                &target_path,
                Some(&branch),
                params.base_branch.as_deref(),
            )
            .await;

        if let Err(e) = add_res {
            // If git failed (e.g. not a git repo / folder workspace), fall back to creating directory
            let _ = std::fs::create_dir_all(&target_path);
            tracing::warn!("Git worktree add fallback: {}", e);
        }

        // Register in AgentStatusStore
        self.status_store
            .update_status(&name, AgentVerdict::Live, &path_str)
            .await;

        Ok(GitWorktreeInfo {
            path: path_str,
            head: None,
            branch: Some(branch),
            is_bare: false,
            is_sparse: false,
            locked: false,
            lock_reason: None,
            prunable: false,
            prunable_reason: None,
            is_main: false,
        })
    }

    pub async fn remove_worktree(&self, params: WorktreeRmParams) -> Result<String, String> {
        let repo_path = params
            .worktree
            .as_deref()
            .and_then(|w| self.find_repo_for_worktree(w))
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));

        let selector = params
            .worktree
            .or(params.path)
            .ok_or_else(|| "Missing worktree selector or path".to_string())?;

        let item = self.show_worktree(&selector, repo_path.to_str()).await;
        let target_path_buf = item
            .as_ref()
            .map(|i| PathBuf::from(&i.path))
            .unwrap_or_else(|| PathBuf::from(&selector));

        // Dirty worktree safety preflight check
        if !params.force && target_path_buf.exists() {
            if let Ok(status) = self.git_engine.status_porcelain(&target_path_buf).await {
                if !status.trim().is_empty() {
                    return Err(format!(
                        "Worktree has uncommitted modifications; pass --force to remove: {}",
                        target_path_buf.display()
                    ));
                }
            }
        }

        let _ = self
            .git_engine
            .worktree_remove(&repo_path, &target_path_buf, params.force)
            .await;

        // Clean up directory if still present
        if params.force && target_path_buf.exists() {
            let _ = std::fs::remove_dir_all(&target_path_buf);
        }

        // Mark as Exited in AgentStatusStore
        self.status_store
            .update_status(
                &selector,
                AgentVerdict::Exited,
                target_path_buf.to_string_lossy().to_string(),
            )
            .await;

        Ok(selector)
    }

    pub async fn lock_worktree(
        &self,
        repo: Option<&str>,
        worktree: &str,
        reason: Option<&str>,
    ) -> Result<(), String> {
        let repo_path = repo
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        self.git_engine
            .worktree_lock(&repo_path, Path::new(worktree), reason)
            .await
    }

    pub async fn unlock_worktree(&self, repo: Option<&str>, worktree: &str) -> Result<(), String> {
        let repo_path = repo
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        self.git_engine
            .worktree_unlock(&repo_path, Path::new(worktree))
            .await
    }

    fn find_repo_for_worktree(&self, worktree_path: &str) -> Option<PathBuf> {
        let p = Path::new(worktree_path);
        if p.join(".git").exists() {
            Some(p.to_path_buf())
        } else {
            p.parent().map(|parent| parent.to_path_buf())
        }
    }
}
