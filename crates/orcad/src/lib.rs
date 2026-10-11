pub mod agent_status_store;
pub mod diagnostics;
pub mod idle_exit;
pub mod ipc;
pub mod server;
pub mod terminal_manager;
pub mod test_client;
pub mod worktree_manager;

pub use agent_status_store::{AgentStatusRow, AgentStatusStore, AgentVerdict};
pub use diagnostics::{get_process_memory, DaemonMetrics, ProcessMemoryInfo};
pub use idle_exit::IdleExitManager;
pub use server::{Server, ServerConfig};
pub use terminal_manager::TerminalManager;
pub use worktree_manager::WorktreeManager;
