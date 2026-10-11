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
pub struct PsArgs {
    /// Output results in JSON format (overrides or supplements global --json)
    #[arg(long, help = "Output results in JSON format")]
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

    /// Subcommand action for terminal control
    #[command(subcommand)]
    pub action: Option<TerminalSubcommand>,
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum TerminalSubcommand {
    /// Create a new terminal session
    Create {
        #[arg(long)]
        shell: Option<String>,
        #[arg(long)]
        command: Option<String>,
        #[arg(long)]
        cwd: Option<String>,
    },
    /// List all active terminal sessions
    List,
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

#[derive(Args, Debug, Clone, PartialEq, Eq)]
pub struct WorktreeArgs {
    #[command(subcommand)]
    pub action: WorktreeSubcommand,
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum WorktreeSubcommand {
    /// Create a new git worktree
    Create {
        /// Path for the new worktree
        path: Option<String>,
        /// Branch name
        #[arg(long)]
        branch: Option<String>,
    },
    /// List active git worktrees
    List,
    /// Remove an existing git worktree
    Remove {
        /// Path or selector of the worktree to remove
        path: String,
    },
}

#[derive(Args, Debug, Clone, PartialEq, Eq, Default)]
pub struct PingArgs {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_help_and_version() {
        let help = Cli::try_parse_from(["orca", "--help"]);
        assert!(help.is_err()); // clap exits with display help error

        let version = Cli::try_parse_from(["orca", "--version"]);
        assert!(version.is_err()); // clap exits with display version error
    }

    #[test]
    fn test_parse_ps_defaults() {
        let cli = Cli::try_parse_from(["orca", "ps"]).unwrap();
        assert!(!cli.json);
        assert!(!cli.is_json());
        match cli.command {
            Some(Commands::Ps(args)) => {
                assert!(!args.json);
                assert_eq!(args.worktree, None);
                assert!(!args.all);
            }
            other => panic!("Unexpected command: {other:?}"),
        }
    }

    #[test]
    fn test_parse_ps_options_and_json() {
        let cli = Cli::try_parse_from(["orca", "ps", "--worktree", "my-repo", "--all", "--json"])
            .unwrap();
        assert!(cli.is_json());
        match cli.command {
            Some(Commands::Ps(args)) => {
                assert!(args.json);
                assert_eq!(args.worktree.as_deref(), Some("my-repo"));
                assert!(args.all);
            }
            other => panic!("Unexpected command: {other:?}"),
        }

        // Global flag before subcommand
        let cli_global = Cli::try_parse_from(["orca", "--json", "ps"]).unwrap();
        assert!(cli_global.json);
        assert!(cli_global.is_json());
    }

    #[test]
    fn test_parse_ping() {
        let cli = Cli::try_parse_from(["orca", "ping"]).unwrap();
        assert_eq!(cli.command, Some(Commands::Ping(PingArgs {})));

        let cli_json = Cli::try_parse_from(["orca", "--json", "ping"]).unwrap();
        assert!(cli_json.is_json());
    }

    #[test]
    fn test_parse_terminal_options() {
        let cli = Cli::try_parse_from([
            "orca",
            "terminal",
            "--shell",
            "powershell.exe",
            "--command",
            "cargo test",
            "--cwd",
            "C:\\Users",
        ])
        .unwrap();

        match cli.command {
            Some(Commands::Terminal(args)) => {
                assert_eq!(args.shell.as_deref(), Some("powershell.exe"));
                assert_eq!(args.command.as_deref(), Some("cargo test"));
                assert_eq!(args.cwd.as_deref(), Some("C:\\Users"));
                assert!(args.action.is_none());
            }
            other => panic!("Unexpected command: {other:?}"),
        }
    }

    #[test]
    fn test_parse_terminal_subcommands() {
        let cli_list = Cli::try_parse_from(["orca", "terminal", "list"]).unwrap();
        match cli_list.command {
            Some(Commands::Terminal(args)) => {
                assert_eq!(args.action, Some(TerminalSubcommand::List));
            }
            other => panic!("Unexpected: {other:?}"),
        }

        let cli_attach = Cli::try_parse_from(["orca", "terminal", "attach", "term_123"]).unwrap();
        match cli_attach.command {
            Some(Commands::Terminal(args)) => {
                assert_eq!(
                    args.action,
                    Some(TerminalSubcommand::Attach {
                        handle: "term_123".to_string()
                    })
                );
            }
            other => panic!("Unexpected: {other:?}"),
        }

        let cli_kill = Cli::try_parse_from(["orca", "terminal", "kill", "term_123"]).unwrap();
        match cli_kill.command {
            Some(Commands::Terminal(args)) => {
                assert_eq!(
                    args.action,
                    Some(TerminalSubcommand::Kill {
                        handle: "term_123".to_string()
                    })
                );
            }
            other => panic!("Unexpected: {other:?}"),
        }
    }

    #[test]
    fn test_parse_worktree_subcommands() {
        let cli_create = Cli::try_parse_from([
            "orca",
            "worktree",
            "create",
            "/path/to/wt",
            "--branch",
            "feature-x",
        ])
        .unwrap();
        match cli_create.command {
            Some(Commands::Worktree(args)) => {
                assert_eq!(
                    args.action,
                    WorktreeSubcommand::Create {
                        path: Some("/path/to/wt".to_string()),
                        branch: Some("feature-x".to_string()),
                    }
                );
            }
            other => panic!("Unexpected: {other:?}"),
        }

        let cli_rm = Cli::try_parse_from(["orca", "worktree", "remove", "/path/to/wt"]).unwrap();
        match cli_rm.command {
            Some(Commands::Worktree(args)) => {
                assert_eq!(
                    args.action,
                    WorktreeSubcommand::Remove {
                        path: "/path/to/wt".to_string(),
                    }
                );
            }
            other => panic!("Unexpected: {other:?}"),
        }
    }

    #[test]
    fn test_parse_global_flags() {
        let cli = Cli::try_parse_from([
            "orca",
            "--pipe",
            "orca-custom-pipe",
            "--profile",
            "dev",
            "--host",
            "remote-srv",
            "-v",
            "ping",
        ])
        .unwrap();

        assert_eq!(cli.pipe.as_deref(), Some("orca-custom-pipe"));
        assert_eq!(cli.profile.as_deref(), Some("dev"));
        assert_eq!(cli.host.as_deref(), Some("remote-srv"));
        assert!(cli.verbose);
    }
}
