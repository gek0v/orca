pub mod client;
pub mod commands;
pub mod format;

pub use client::{ClientConfig, ClientError, DaemonClient, IpcStream};
pub use commands::{
    Cli, Commands, PsArgs, TerminalArgs, TerminalSubcommand, WorktreeArgs, WorktreeSubcommand,
};
pub use format::{format_json, format_ps_table, format_timestamp_ms, PsRow};

use serde_json::Value;

pub async fn run(cli: commands::Cli) -> Result<(), Box<dyn std::error::Error>> {
    let is_json = cli.is_json();

    let command = match cli.command {
        Some(cmd) => cmd,
        None => return Ok(()),
    };

    let client_config = ClientConfig {
        pipe: cli.pipe.clone(),
        socket: cli.socket.clone(),
        profile: cli.profile.clone(),
    };

    match command {
        Commands::Ping(_) => {
            let mut client = match DaemonClient::connect(&client_config).await {
                Ok(c) => c,
                Err(e) => {
                    if is_json {
                        println!(
                            "{}",
                            serde_json::json!({ "ok": false, "error": e.to_string() })
                        );
                    } else {
                        eprintln!("Error: {e}");
                    }
                    std::process::exit(1);
                }
            };

            let res: Value = client.call("daemon.ping", None).await?;
            if is_json {
                println!("{}", format_json(&res)?);
            } else {
                println!("pong! orcad daemon is active");
            }
        }

        Commands::Ps(ps_args) => {
            let mut client = match DaemonClient::connect(&client_config).await {
                Ok(c) => c,
                Err(e) => {
                    if is_json {
                        println!(
                            "{}",
                            serde_json::json!({ "ok": false, "error": e.to_string() })
                        );
                    } else {
                        eprintln!("Error: {e}");
                    }
                    std::process::exit(1);
                }
            };

            let params = serde_json::json!({
                "worktree": ps_args.worktree,
                "all": ps_args.all,
            });

            let res: Value = client.call("worktree.ps", Some(params)).await?;
            if is_json {
                println!("{}", format_json(&res)?);
            } else {
                // Parse rows from res
                let rows: Vec<PsRow> = if let Some(items) = res.as_array() {
                    items
                        .iter()
                        .filter_map(|item| serde_json::from_value(item.clone()).ok())
                        .collect()
                } else if let Some(worktrees) = res.get("worktrees").and_then(|w| w.as_array()) {
                    worktrees
                        .iter()
                        .map(|w| PsRow {
                            pid: w.get("pid").and_then(|p| p.as_u64()).map(|p| p as u32),
                            agent_id: w
                                .get("branch")
                                .or_else(|| w.get("id"))
                                .and_then(|b| b.as_str())
                                .unwrap_or("-")
                                .to_string(),
                            status: w
                                .get("status")
                                .and_then(|s| s.as_str())
                                .unwrap_or("live")
                                .to_string(),
                            cwd: w
                                .get("path")
                                .and_then(|p| p.as_str())
                                .unwrap_or("-")
                                .to_string(),
                            started_at: w
                                .get("updatedAtMs")
                                .and_then(|t| t.as_u64())
                                .map(format_timestamp_ms),
                        })
                        .collect()
                } else {
                    vec![]
                };

                print!("{}", format_ps_table(&rows));
            }
        }

        Commands::Terminal(term_args) => {
            let mut client = match DaemonClient::connect(&client_config).await {
                Ok(c) => c,
                Err(e) => {
                    if is_json {
                        println!(
                            "{}",
                            serde_json::json!({ "ok": false, "error": e.to_string() })
                        );
                    } else {
                        eprintln!("Error: {e}");
                    }
                    std::process::exit(1);
                }
            };

            match term_args.action {
                Some(TerminalSubcommand::Create {
                    shell,
                    command,
                    cwd,
                }) => {
                    let params = serde_json::json!({
                        "shell": shell.or(term_args.shell),
                        "command": command.or(term_args.command),
                        "cwd": cwd.or(term_args.cwd),
                    });
                    let res: Value = client.call("terminal.create", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let handle = res
                            .get("handle")
                            .or_else(|| res.get("terminalId"))
                            .or_else(|| res.get("id"))
                            .and_then(|h| h.as_str())
                            .unwrap_or("unknown");
                        println!("Created terminal {handle}");
                    }
                }
                Some(TerminalSubcommand::List) => {
                    let res: Value = client.call("terminal.list", None).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else if let Some(terminals) = res
                        .as_array()
                        .or_else(|| res.get("terminals").and_then(|t| t.as_array()))
                    {
                        if terminals.is_empty() {
                            println!("No active terminals.");
                        } else {
                            for t in terminals {
                                let handle =
                                    t.get("handle").and_then(|h| h.as_str()).unwrap_or("-");
                                let title = t
                                    .get("title")
                                    .and_then(|h| h.as_str())
                                    .unwrap_or("(untitled)");
                                println!("{handle}\t{title}");
                            }
                        }
                    } else {
                        println!("{}", format_json(&res)?);
                    }
                }
                Some(TerminalSubcommand::Attach { handle }) => {
                    let params = serde_json::json!({ "handle": handle });
                    let res: Value = client.call("terminal.attach", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        println!("Attached to terminal {handle}");
                    }
                }
                Some(TerminalSubcommand::Kill { handle }) => {
                    let params = serde_json::json!({ "handle": handle });
                    let res: Value = client.call("terminal.close", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        println!("Closed terminal {handle}.");
                    }
                }
                None => {
                    let params = serde_json::json!({
                        "shell": term_args.shell,
                        "command": term_args.command,
                        "cwd": term_args.cwd,
                    });
                    let res: Value = client.call("terminal.create", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let handle = res
                            .get("handle")
                            .and_then(|h| h.as_str())
                            .unwrap_or("unknown");
                        println!("Created terminal {handle}");
                    }
                }
            }
        }

        Commands::Worktree(wt_args) => {
            let mut client = match DaemonClient::connect(&client_config).await {
                Ok(c) => c,
                Err(e) => {
                    if is_json {
                        println!(
                            "{}",
                            serde_json::json!({ "ok": false, "error": e.to_string() })
                        );
                    } else {
                        eprintln!("Error: {e}");
                    }
                    std::process::exit(1);
                }
            };

            match wt_args.action {
                WorktreeSubcommand::Create { path, branch } => {
                    let params = serde_json::json!({ "path": path, "branch": branch });
                    let res: Value = client.call("worktree.create", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        println!("Created worktree: {}", format_json(&res)?);
                    }
                }
                WorktreeSubcommand::List => {
                    let res: Value = client.call("worktree.list", None).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else if let Some(worktrees) = res
                        .as_array()
                        .or_else(|| res.get("worktrees").and_then(|w| w.as_array()))
                    {
                        if worktrees.is_empty() {
                            println!("No worktrees found.");
                        } else {
                            for w in worktrees {
                                let branch =
                                    w.get("branch").and_then(|b| b.as_str()).unwrap_or("-");
                                let path = w.get("path").and_then(|p| p.as_str()).unwrap_or("-");
                                println!("{branch}\t{path}");
                            }
                        }
                    } else {
                        println!("{}", format_json(&res)?);
                    }
                }
                WorktreeSubcommand::Remove { path } => {
                    let params = serde_json::json!({ "path": path });
                    let res: Value = client.call("worktree.rm", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        println!("Removed worktree {path}.");
                    }
                }
            }
        }
    }

    Ok(())
}
