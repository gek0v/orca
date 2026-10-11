pub mod client;
pub mod commands;
pub mod format;

pub use client::{ClientConfig, ClientError, DaemonClient, IpcStream};
pub use commands::{
    Cli, Commands, DiagnosticsArgs, DiagnosticsSubcommand, PsArgs, StatusArgs, TerminalArgs,
    TerminalCloseArgs, TerminalCreateArgs, TerminalListArgs, TerminalReadArgs, TerminalSendArgs,
    TerminalShowArgs, TerminalSplitArgs, TerminalSubcommand, TerminalWaitArgs, WorktreeArgs,
    WorktreeCreateArgs, WorktreeListArgs, WorktreePsArgs, WorktreeRmArgs, WorktreeShowArgs,
    WorktreeSubcommand,
};
pub use format::{
    format_diagnostics_memory, format_json, format_ps_table, format_status, format_terminal_table,
    format_timestamp_ms, format_worktree_table, PsRow,
};

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
                    handle_connect_error(e, is_json);
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

        Commands::Status(_) => {
            let mut client = match DaemonClient::connect(&client_config).await {
                Ok(c) => c,
                Err(e) => {
                    handle_connect_error(e, is_json);
                    std::process::exit(1);
                }
            };

            let res: Value = client.call("status", None).await?;
            if is_json {
                println!("{}", format_json(&res)?);
            } else {
                print!("{}", format_status(&res));
            }
        }

        Commands::Diagnostics(diag_args) => {
            let mut client = match DaemonClient::connect(&client_config).await {
                Ok(c) => c,
                Err(e) => {
                    handle_connect_error(e, is_json);
                    std::process::exit(1);
                }
            };

            match diag_args.action {
                DiagnosticsSubcommand::Memory => {
                    let res: Value = client.call("diagnostics.memory", None).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        print!("{}", format_diagnostics_memory(&res));
                    }
                }
            }
        }

        Commands::Ps(ps_args) => {
            let mut client = match DaemonClient::connect(&client_config).await {
                Ok(c) => c,
                Err(e) => {
                    handle_connect_error(e, is_json);
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
                    handle_connect_error(e, is_json);
                    std::process::exit(1);
                }
            };

            match term_args.action {
                Some(TerminalSubcommand::Create(create_args)) => {
                    let params = serde_json::json!({
                        "shell": create_args.shell.or(term_args.shell),
                        "command": create_args.command.or(term_args.command),
                        "cwd": create_args.cwd.or(term_args.cwd),
                        "title": create_args.title.or(term_args.title),
                        "worktree": create_args.worktree.or(term_args.worktree),
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
                Some(TerminalSubcommand::List(list_args)) => {
                    let params = serde_json::json!({
                        "worktree": list_args.worktree,
                        "limit": list_args.limit,
                    });
                    let res: Value = client.call("terminal.list", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else if let Some(terminals) = res
                        .as_array()
                        .or_else(|| res.get("terminals").and_then(|t| t.as_array()))
                    {
                        print!("{}", format_terminal_table(terminals));
                    } else {
                        println!("{}", format_json(&res)?);
                    }
                }
                Some(TerminalSubcommand::Show(show_args)) => {
                    let handle = show_args.terminal.or(show_args.handle);
                    let params = serde_json::json!({ "terminal": handle });
                    let res: Value = client.call("terminal.show", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let t = res.get("terminal").unwrap_or(&res);
                        let handle_str = t
                            .get("handle")
                            .or_else(|| t.get("id"))
                            .and_then(|h| h.as_str())
                            .unwrap_or("-");
                        let pid = t
                            .get("pid")
                            .and_then(|p| p.as_u64())
                            .map(|p| p.to_string())
                            .unwrap_or_else(|| "-".to_string());
                        let cmd = t
                            .get("command")
                            .and_then(|c| c.as_str())
                            .unwrap_or("(default)");
                        let cwd = t.get("cwd").and_then(|c| c.as_str()).unwrap_or("-");
                        println!(
                            "Terminal {handle_str}:\n  PID:     {pid}\n  Command: {cmd}\n  CWD:     {cwd}"
                        );
                    }
                }
                Some(TerminalSubcommand::Send(send_args)) => {
                    let params = serde_json::json!({
                        "terminalId": send_args.terminal,
                        "text": send_args.text,
                        "enter": send_args.enter,
                        "interrupt": send_args.interrupt,
                        "waitSubmit": send_args.wait_submit,
                        "retryRequest": send_args.retry_request,
                    });
                    let res: Value = client.call("terminal.send", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let handle = send_args.terminal.as_deref().unwrap_or("active");
                        println!("Input sent to terminal {handle}.");
                    }
                }
                Some(TerminalSubcommand::Read(read_args)) => {
                    let params = serde_json::json!({
                        "terminalId": read_args.terminal,
                        "cursor": read_args.cursor,
                        "limit": read_args.limit,
                        "screen": read_args.screen,
                    });
                    let res: Value = client.call("terminal.read", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else if let Some(text) = res.get("text").and_then(|t| t.as_str()) {
                        print!("{text}");
                    } else {
                        println!("{}", format_json(&res)?);
                    }
                }
                Some(TerminalSubcommand::Wait(wait_args)) => {
                    let params = serde_json::json!({
                        "terminalId": wait_args.terminal,
                        "for": wait_args.for_condition,
                        "timeoutMs": wait_args.timeout_ms,
                    });
                    let res: Value = client.call("terminal.wait", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let status = res
                            .get("status")
                            .and_then(|s| s.as_str())
                            .unwrap_or("complete");
                        let condition_met = res
                            .get("conditionMet")
                            .and_then(|c| c.as_bool())
                            .unwrap_or(false);
                        if condition_met {
                            println!("Condition reached: {status}");
                        } else {
                            println!("Wait timed out or incomplete.");
                        }
                    }
                }
                Some(TerminalSubcommand::Close(close_args)) => {
                    let params = serde_json::json!({
                        "terminalId": close_args.terminal,
                        "tab": close_args.tab,
                        "worktree": close_args.worktree,
                        "all": close_args.all,
                    });
                    let res: Value = client.call("terminal.close", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        if close_args.all {
                            println!("Closed all terminals.");
                        } else {
                            let handle = close_args.terminal.as_deref().unwrap_or("active");
                            println!("Closed terminal {handle}.");
                        }
                    }
                }
                Some(TerminalSubcommand::Split(split_args)) => {
                    let params = serde_json::json!({
                        "terminalId": split_args.terminal,
                        "direction": split_args.direction,
                        "command": split_args.command,
                    });
                    let res: Value = client.call("terminal.split", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let handle = res
                            .get("handle")
                            .or_else(|| res.get("terminalId"))
                            .and_then(|h| h.as_str())
                            .unwrap_or("new");
                        println!("Split terminal created: {handle}");
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
                        "title": term_args.title,
                        "worktree": term_args.worktree,
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
                    handle_connect_error(e, is_json);
                    std::process::exit(1);
                }
            };

            match wt_args.action {
                WorktreeSubcommand::List(list_args) => {
                    let params = serde_json::json!({
                        "repo": list_args.repo,
                        "limit": list_args.limit,
                    });
                    let res: Value = client.call("worktree.list", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else if let Some(worktrees) = res
                        .as_array()
                        .or_else(|| res.get("worktrees").and_then(|w| w.as_array()))
                    {
                        print!("{}", format_worktree_table(worktrees));
                    } else {
                        println!("{}", format_json(&res)?);
                    }
                }
                WorktreeSubcommand::Ps(ps_args) => {
                    let params = serde_json::json!({ "limit": ps_args.limit });
                    let res: Value = client.call("worktree.ps", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else if let Some(worktrees) = res
                        .as_array()
                        .or_else(|| res.get("worktrees").and_then(|w| w.as_array()))
                    {
                        print!("{}", format_worktree_table(worktrees));
                    } else {
                        println!("{}", format_json(&res)?);
                    }
                }
                WorktreeSubcommand::Show(show_args) => {
                    let selector = show_args.worktree.or(show_args.path);
                    let params = serde_json::json!({ "worktree": selector });
                    let res: Value = client.call("worktree.show", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let wt = res.get("worktree").unwrap_or(&res);
                        let branch = wt
                            .get("branch")
                            .or_else(|| wt.get("id"))
                            .and_then(|b| b.as_str())
                            .unwrap_or("-");
                        let path = wt.get("path").and_then(|p| p.as_str()).unwrap_or("-");
                        let status = wt.get("status").and_then(|s| s.as_str()).unwrap_or("-");
                        println!("Worktree {branch}:\n  Status: {status}\n  Path:   {path}");
                    }
                }
                WorktreeSubcommand::Current => {
                    let params = serde_json::json!({ "worktree": "active" });
                    let res: Value = client.call("worktree.show", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let wt = res.get("worktree").unwrap_or(&res);
                        let branch = wt
                            .get("branch")
                            .or_else(|| wt.get("id"))
                            .and_then(|b| b.as_str())
                            .unwrap_or("-");
                        let path = wt.get("path").and_then(|p| p.as_str()).unwrap_or("-");
                        let status = wt.get("status").and_then(|s| s.as_str()).unwrap_or("-");
                        println!("Worktree {branch}:\n  Status: {status}\n  Path:   {path}");
                    }
                }
                WorktreeSubcommand::Create(create_args) => {
                    let params = serde_json::json!({
                        "name": create_args.name,
                        "repo": create_args.repo,
                        "branch": create_args.branch,
                        "baseBranch": create_args.base_branch,
                        "agent": create_args.agent,
                        "prompt": create_args.prompt,
                        "path": create_args.path,
                        "runHooks": create_args.run_hooks,
                        "activate": create_args.activate,
                    });
                    let res: Value = client.call("worktree.create", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let name = create_args.name.as_deref().unwrap_or("new");
                        println!("Created worktree {name}");
                    }
                }
                WorktreeSubcommand::Rm(rm_args) => {
                    let params = serde_json::json!({
                        "worktree": rm_args.worktree,
                        "path": rm_args.path,
                        "force": rm_args.force,
                        "runHooks": rm_args.run_hooks,
                    });
                    let res: Value = client.call("worktree.rm", Some(params)).await?;
                    if is_json {
                        println!("{}", format_json(&res)?);
                    } else {
                        let target = rm_args
                            .worktree
                            .or(rm_args.path)
                            .unwrap_or_else(|| "target".to_string());
                        println!("Removed worktree {target}.");
                    }
                }
            }
        }
    }

    Ok(())
}

fn handle_connect_error(err: ClientError, is_json: bool) {
    if is_json {
        println!(
            "{}",
            serde_json::json!({ "ok": false, "error": err.to_string() })
        );
    } else {
        eprintln!("Error: {err}");
    }
}
