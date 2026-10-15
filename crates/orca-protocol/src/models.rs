use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSendParams {
    pub terminal_id: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub enter: bool,
    #[serde(default)]
    pub interrupt: bool,
    pub wait_submit: Option<u64>,
    pub retry_request: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadParams {
    pub terminal_id: Option<String>,
    pub cursor: Option<usize>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub screen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReadResult {
    pub ok: bool,
    pub terminal_id: String,
    pub text: String,
    pub cursor: usize,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWaitParams {
    pub terminal_id: Option<String>,
    #[serde(rename = "for")]
    pub for_condition: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCloseParams {
    pub terminal_id: Option<String>,
    #[serde(default)]
    pub tab: bool,
    pub worktree: Option<String>,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSplitParams {
    pub terminal_id: Option<String>,
    pub direction: Option<String>,
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeListParams {
    #[serde(alias = "repoId")]
    pub repo: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeShowParams {
    #[serde(alias = "worktreeId")]
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateParams {
    pub name: Option<String>,
    #[serde(alias = "repoId")]
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub agent: Option<String>,
    pub prompt: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRmParams {
    #[serde(alias = "worktreeId")]
    pub worktree: Option<String>,
    pub path: Option<String>,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub run_hooks: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeItem {
    pub id: String,
    pub branch: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub status: String,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonInfo {
    pub pid: u32,
    pub uptime_seconds: u64,
    pub active_terminals: usize,
    pub active_connections: usize,
    pub memory_working_set_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusResponse {
    pub ok: bool,
    pub runtime_id: String,
    pub daemon: DaemonInfo,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDiagnosticsResponse {
    pub ok: bool,
    pub working_set_bytes: usize,
    pub private_bytes: usize,
    pub terminals: usize,
    pub connections: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeInfo {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default)]
    pub is_bare: bool,
    #[serde(default)]
    pub is_sparse: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_reason: Option<String>,
    #[serde(default)]
    pub prunable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prunable_reason: Option<String>,
    #[serde(default)]
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitExecRequest {
    pub cwd: String,
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitExecResponse {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeLockParams {
    pub worktree: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeUnlockParams {
    pub worktree: String,
}
