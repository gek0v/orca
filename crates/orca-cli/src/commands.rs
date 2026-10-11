use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "orca",
    version,
    about = "Next-gen IDE for parallel agentic development",
    long_about = "Next-gen IDE for parallel agentic development"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// Connect via Windows Named Pipe
    #[arg(global = true, long)]
    pub pipe: Option<String>,

    /// Connect via Unix Domain Socket
    #[arg(global = true, long)]
    pub socket: Option<PathBuf>,

    /// Output results in JSON format
    #[arg(global = true, long)]
    pub json: bool,

    /// Profile name to target
    #[arg(global = true, long)]
    pub profile: Option<String>,

    /// Execution host target (e.g. local, runtime:<id>)
    #[arg(global = true, long)]
    pub host: Option<String>,

    /// Enable verbose logging
    #[arg(global = true, short, long)]
    pub verbose: bool,
}

impl Cli {
    pub fn is_json(&self) -> bool {
        if self.json {
            return true;
        }
        if let Some(Commands::Ps(ref ps)) = self.command {
            return ps.json;
        }
        false
    }
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum Commands {
    /// Show app/runtime/daemon readiness and status
    Status(StatusArgs),

    /// Diagnostics and process resource snapshots
    Diagnostics(DiagnosticsArgs),

    /// List running agents, tasks, and worktrees
    Ps(PsArgs),

    /// Spawn or connect to terminal sessions
    Terminal(TerminalArgs),

    /// Control git worktrees
    Worktree(WorktreeArgs),

    /// Ping the orcad daemon
    Ping(PingArgs),
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct StatusArgs {}

#[derive(Args, Debug, Clone, PartialEq, Eq)]
pub struct DiagnosticsArgs {
    #[command(subcommand)]
    pub action: DiagnosticsSubcommand,
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum DiagnosticsSubcommand {
    /// Collect a memory snapshot for Orca and managed terminals
    Memory,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct PsArgs {
    /// Output results in JSON format
    #[arg(long)]
    pub json: bool,

    /// Filter by worktree path or selector
    #[arg(long)]
    pub worktree: Option<String>,

    /// Show all agents and worktrees including exited
    #[arg(long)]
    pub all: bool,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalArgs {
    /// Shell executable to launch
    #[arg(long)]
    pub shell: Option<String>,

    /// Initial command to run in the terminal
    #[arg(long)]
    pub command: Option<String>,

    /// Working directory for the terminal session
    #[arg(long)]
    pub cwd: Option<String>,

    /// Terminal tab title
    #[arg(long)]
    pub title: Option<String>,

    /// Target worktree selector
    #[arg(long)]
    pub worktree: Option<String>,

    /// Subcommand action for terminal control
    #[command(subcommand)]
    pub action: Option<TerminalSubcommand>,
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum TerminalSubcommand {
    /// Create a new terminal session
    Create(TerminalCreateArgs),

    /// List live Orca-managed terminals
    List(TerminalListArgs),

    /// Show terminal metadata and preview
    Show(TerminalShowArgs),

    /// Send input to a live terminal
    Send(TerminalSendArgs),

    /// Read bounded terminal output
    Read(TerminalReadArgs),

    /// Wait for a terminal condition
    Wait(TerminalWaitArgs),

    /// Close one terminal, its whole tab, or every terminal
    Close(TerminalCloseArgs),

    /// Split an existing terminal pane
    Split(TerminalSplitArgs),

    /// Attach to an existing terminal session
    Attach {
        /// Terminal handle or session ID
        handle: String,
    },

    /// Kill a terminal session
    Kill {
        /// Terminal handle or session ID
        handle: String,
    },
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalCreateArgs {
    #[arg(long)]
    pub worktree: Option<String>,
    #[arg(long)]
    pub title: Option<String>,
    #[arg(long)]
    pub command: Option<String>,
    #[arg(long)]
    pub shell: Option<String>,
    #[arg(long)]
    pub focus: bool,
    #[arg(long)]
    pub cwd: Option<String>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalListArgs {
    #[arg(long)]
    pub worktree: Option<String>,
    #[arg(long)]
    pub limit: Option<usize>,
    #[arg(long)]
    pub include_visual_layouts: bool,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalShowArgs {
    #[arg(long)]
    pub terminal: Option<String>,
    pub handle: Option<String>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalSendArgs {
    #[arg(long)]
    pub terminal: Option<String>,
    #[arg(long)]
    pub text: Option<String>,
    #[arg(long)]
    pub enter: bool,
    #[arg(long)]
    pub interrupt: bool,
    #[arg(long)]
    pub wait_submit: Option<u64>,
    #[arg(long)]
    pub retry_request: Option<String>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalReadArgs {
    #[arg(long)]
    pub terminal: Option<String>,
    #[arg(long)]
    pub cursor: Option<usize>,
    #[arg(long)]
    pub limit: Option<usize>,
    #[arg(long)]
    pub screen: bool,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalWaitArgs {
    #[arg(long)]
    pub terminal: Option<String>,
    #[arg(long = "for")]
    pub for_condition: String,
    #[arg(long)]
    pub timeout_ms: Option<u64>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalCloseArgs {
    #[arg(long)]
    pub terminal: Option<String>,
    #[arg(long)]
    pub tab: bool,
    #[arg(long)]
    pub worktree: Option<String>,
    #[arg(long)]
    pub all: bool,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct TerminalSplitArgs {
    #[arg(long)]
    pub terminal: Option<String>,
    #[arg(long)]
    pub direction: Option<String>,
    #[arg(long)]
    pub command: Option<String>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq)]
pub struct WorktreeArgs {
    #[command(subcommand)]
    pub action: WorktreeSubcommand,
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum WorktreeSubcommand {
    /// List Orca-managed worktrees
    List(WorktreeListArgs),

    /// Show compact orchestration summary across worktrees
    Ps(WorktreePsArgs),

    /// Show one worktree
    Show(WorktreeShowArgs),

    /// Show the Orca-managed worktree for current directory
    Current,

    /// Create a new Orca-managed worktree
    Create(WorktreeCreateArgs),

    /// Remove an existing worktree
    #[command(alias = "remove", alias = "delete")]
    Rm(WorktreeRmArgs),
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct WorktreeListArgs {
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long)]
    pub limit: Option<usize>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct WorktreePsArgs {
    #[arg(long)]
    pub limit: Option<usize>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct WorktreeShowArgs {
    #[arg(long)]
    pub worktree: Option<String>,
    pub path: Option<String>,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct WorktreeCreateArgs {
    #[arg(long)]
    pub name: Option<String>,
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long)]
    pub branch: Option<String>,
    #[arg(long)]
    pub base_branch: Option<String>,
    #[arg(long)]
    pub agent: Option<String>,
    #[arg(long)]
    pub prompt: Option<String>,
    pub path: Option<String>,
    #[arg(long)]
    pub run_hooks: bool,
    #[arg(long)]
    pub activate: bool,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct WorktreeRmArgs {
    #[arg(long)]
    pub worktree: Option<String>,
    pub path: Option<String>,
    #[arg(long)]
    pub force: bool,
    #[arg(long)]
    pub run_hooks: bool,
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct PingArgs {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_help_and_version() {
        let help = Cli::try_parse_from(["orca", "--help"]);
        assert!(help.is_err());

        let version = Cli::try_parse_from(["orca", "--version"]);
        assert!(version.is_err());
    }

    #[test]
    fn test_parse_status() {
        let cli = Cli::try_parse_from(["orca", "status"]).unwrap();
        assert_eq!(cli.command, Some(Commands::Status(StatusArgs {})));
    }

    #[test]
    fn test_parse_diagnostics_memory() {
        let cli = Cli::try_parse_from(["orca", "diagnostics", "memory"]).unwrap();
        match cli.command {
            Some(Commands::Diagnostics(args)) => {
                assert_eq!(args.action, DiagnosticsSubcommand::Memory);
            }
            other => panic!("Unexpected: {other:?}"),
        }
    }

    #[test]
    fn test_parse_terminal_send() {
        let cli = Cli::try_parse_from([
            "orca",
            "terminal",
            "send",
            "--terminal",
            "term_123",
            "--text",
            "cargo test",
            "--enter",
            "--wait-submit",
            "5",
        ])
        .unwrap();

        match cli.command {
            Some(Commands::Terminal(args)) => match args.action {
                Some(TerminalSubcommand::Send(send_args)) => {
                    assert_eq!(send_args.terminal.as_deref(), Some("term_123"));
                    assert_eq!(send_args.text.as_deref(), Some("cargo test"));
                    assert!(send_args.enter);
                    assert!(!send_args.interrupt);
                    assert_eq!(send_args.wait_submit, Some(5));
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }
    }

    #[test]
    fn test_parse_terminal_read() {
        let cli = Cli::try_parse_from([
            "orca",
            "terminal",
            "read",
            "--terminal",
            "term_abc",
            "--cursor",
            "100",
            "--limit",
            "500",
            "--screen",
        ])
        .unwrap();

        match cli.command {
            Some(Commands::Terminal(args)) => match args.action {
                Some(TerminalSubcommand::Read(read_args)) => {
                    assert_eq!(read_args.terminal.as_deref(), Some("term_abc"));
                    assert_eq!(read_args.cursor, Some(100));
                    assert_eq!(read_args.limit, Some(500));
                    assert!(read_args.screen);
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }
    }

    #[test]
    fn test_parse_terminal_wait() {
        let cli = Cli::try_parse_from([
            "orca",
            "terminal",
            "wait",
            "--terminal",
            "term_abc",
            "--for",
            "tui-idle",
            "--timeout-ms",
            "5000",
        ])
        .unwrap();

        match cli.command {
            Some(Commands::Terminal(args)) => match args.action {
                Some(TerminalSubcommand::Wait(wait_args)) => {
                    assert_eq!(wait_args.terminal.as_deref(), Some("term_abc"));
                    assert_eq!(wait_args.for_condition, "tui-idle");
                    assert_eq!(wait_args.timeout_ms, Some(5000));
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }
    }

    #[test]
    fn test_parse_terminal_close_and_split() {
        let cli_close =
            Cli::try_parse_from(["orca", "terminal", "close", "--worktree", "active", "--all"])
                .unwrap();
        match cli_close.command {
            Some(Commands::Terminal(args)) => match args.action {
                Some(TerminalSubcommand::Close(close_args)) => {
                    assert_eq!(close_args.worktree.as_deref(), Some("active"));
                    assert!(close_args.all);
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }

        let cli_split = Cli::try_parse_from([
            "orca",
            "terminal",
            "split",
            "--terminal",
            "term_1",
            "--direction",
            "horizontal",
            "--command",
            "top",
        ])
        .unwrap();
        match cli_split.command {
            Some(Commands::Terminal(args)) => match args.action {
                Some(TerminalSubcommand::Split(split_args)) => {
                    assert_eq!(split_args.terminal.as_deref(), Some("term_1"));
                    assert_eq!(split_args.direction.as_deref(), Some("horizontal"));
                    assert_eq!(split_args.command.as_deref(), Some("top"));
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }
    }

    #[test]
    fn test_parse_worktree_subcommands() {
        let cli_list = Cli::try_parse_from(["orca", "worktree", "list", "--limit", "10"]).unwrap();
        match cli_list.command {
            Some(Commands::Worktree(args)) => match args.action {
                WorktreeSubcommand::List(list_args) => {
                    assert_eq!(list_args.limit, Some(10));
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }

        let cli_create = Cli::try_parse_from([
            "orca",
            "worktree",
            "create",
            "--name",
            "feat-1",
            "--branch",
            "feat/1",
            "--base-branch",
            "main",
        ])
        .unwrap();
        match cli_create.command {
            Some(Commands::Worktree(args)) => match args.action {
                WorktreeSubcommand::Create(create_args) => {
                    assert_eq!(create_args.name.as_deref(), Some("feat-1"));
                    assert_eq!(create_args.branch.as_deref(), Some("feat/1"));
                    assert_eq!(create_args.base_branch.as_deref(), Some("main"));
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }

        let cli_rm =
            Cli::try_parse_from(["orca", "worktree", "rm", "--worktree", "wt-1", "--force"])
                .unwrap();
        match cli_rm.command {
            Some(Commands::Worktree(args)) => match args.action {
                WorktreeSubcommand::Rm(rm_args) => {
                    assert_eq!(rm_args.worktree.as_deref(), Some("wt-1"));
                    assert!(rm_args.force);
                }
                other => panic!("Unexpected action: {other:?}"),
            },
            other => panic!("Unexpected command: {other:?}"),
        }
    }
}
