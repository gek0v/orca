use orca_protocol::models::{
    DaemonStatusResponse, MemoryDiagnosticsResponse, TerminalCloseParams, TerminalReadParams,
    TerminalSendParams, TerminalSplitParams, TerminalWaitParams, WorktreeCreateParams,
    WorktreeRmParams,
};
use orca_protocol::rpc_envelope::{RuntimeRpcEnvelope, RuntimeRpcRequest};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::agent_status_store::{AgentStatusStore, AgentVerdict};
use crate::daemon_host_relocation::{daemon_host_exe_name, resolve_local_appdata_daemon_dir};
use crate::diagnostics::{get_process_memory, DaemonMetrics};
use crate::external_automations::AutomationManager;
use crate::idle_exit::IdleExitManager;
use crate::ipc;
use crate::port_scanner::PortScanner;
use crate::relay_fs::RelayFsHandler;
use crate::session_search::SessionSearchEngine;
use crate::skill_installer::SkillInstaller;
use crate::systemd_scope::{
    daemon_scope_unit_name, is_systemd_user_scope_supported, parse_cgroup_scope,
};
use crate::terminal_manager::TerminalManager;
use crate::watch_registry::WatchRegistry;
use crate::worktree_manager::WorktreeManager;

pub struct RpcDispatcher {
    pub status_store: Arc<AgentStatusStore>,
    pub terminal_manager: Arc<TerminalManager>,
    pub worktree_manager: Arc<WorktreeManager>,
    pub idle_exit: Arc<IdleExitManager>,
    pub metrics: Arc<DaemonMetrics>,
    pub git_stream_registry: Arc<crate::git_response_stream::GitResponseStreamRegistry>,
    pub watch_registry: Arc<WatchRegistry>,
    pub automations: Arc<AutomationManager>,
    pub runtime_id: String,
}

impl RpcDispatcher {
    pub fn new(
        status_store: Arc<AgentStatusStore>,
        terminal_manager: Arc<TerminalManager>,
        worktree_manager: Arc<WorktreeManager>,
        idle_exit: Arc<IdleExitManager>,
        metrics: Arc<DaemonMetrics>,
        runtime_id: impl Into<String>,
    ) -> Self {
        Self {
            status_store,
            terminal_manager,
            worktree_manager,
            idle_exit,
            metrics,
            git_stream_registry: Arc::new(
                crate::git_response_stream::GitResponseStreamRegistry::new(),
            ),
            watch_registry: Arc::new(WatchRegistry::new()),
            automations: Arc::new(AutomationManager::new()),
            runtime_id: runtime_id.into(),
        }
    }

    pub fn with_git_registry(
        status_store: Arc<AgentStatusStore>,
        terminal_manager: Arc<TerminalManager>,
        worktree_manager: Arc<WorktreeManager>,
        idle_exit: Arc<IdleExitManager>,
        metrics: Arc<DaemonMetrics>,
        git_stream_registry: Arc<crate::git_response_stream::GitResponseStreamRegistry>,
        runtime_id: impl Into<String>,
    ) -> Self {
        Self {
            status_store,
            terminal_manager,
            worktree_manager,
            idle_exit,
            metrics,
            git_stream_registry,
            watch_registry: Arc::new(WatchRegistry::new()),
            automations: Arc::new(AutomationManager::new()),
            runtime_id: runtime_id.into(),
        }
    }

    pub fn with_services(
        status_store: Arc<AgentStatusStore>,
        terminal_manager: Arc<TerminalManager>,
        worktree_manager: Arc<WorktreeManager>,
        idle_exit: Arc<IdleExitManager>,
        metrics: Arc<DaemonMetrics>,
        git_stream_registry: Arc<crate::git_response_stream::GitResponseStreamRegistry>,
        watch_registry: Arc<WatchRegistry>,
        automations: Arc<AutomationManager>,
        runtime_id: impl Into<String>,
    ) -> Self {
        Self {
            status_store,
            terminal_manager,
            worktree_manager,
            idle_exit,
            metrics,
            git_stream_registry,
            watch_registry,
            automations,
            runtime_id: runtime_id.into(),
        }
    }

    pub async fn dispatch(&self, req: RuntimeRpcRequest) -> RuntimeRpcEnvelope<serde_json::Value> {
        let id = req.id.clone();
        let params = req.params.unwrap_or(serde_json::Value::Null);

        match req.method.as_str() {
            "ping" | "daemon.ping" => RuntimeRpcEnvelope::success(
                id,
                json!({ "ok": true, "_keepalive": true }),
                &self.runtime_id,
            ),

            "status" | "daemon.status" | "relay.status" => {
                let mem = get_process_memory();
                let store_rows = self.status_store.list_all().await;
                let active_terms = self.terminal_manager.active_count().await;
                let active_conns = self.idle_exit.active_connections();

                let resp = DaemonStatusResponse {
                    ok: true,
                    runtime_id: self.runtime_id.clone(),
                    daemon: orca_protocol::models::DaemonInfo {
                        pid: std::process::id(),
                        uptime_seconds: self.metrics.uptime_seconds(),
                        active_terminals: active_terms,
                        active_connections: active_conns,
                        memory_working_set_bytes: mem.working_set_bytes,
                    },
                    ready: true,
                };

                let mut val = serde_json::to_value(&resp).unwrap_or_default();
                if let Some(obj) = val.as_object_mut() {
                    obj.insert(
                        "connectedAgents".to_string(),
                        serde_json::to_value(&store_rows).unwrap_or_default(),
                    );
                    obj.insert(
                        "caller".to_string(),
                        json!({ "orcaSessionId": "session-native" }),
                    );
                }

                RuntimeRpcEnvelope::success(id, val, &self.runtime_id)
            }

            "diagnostics.memory" => {
                let mem = get_process_memory();
                let active_terms = self.terminal_manager.active_count().await;
                let active_conns = self.idle_exit.active_connections();

                let resp = MemoryDiagnosticsResponse {
                    ok: true,
                    working_set_bytes: mem.working_set_bytes,
                    private_bytes: mem.private_bytes,
                    terminals: active_terms,
                    connections: active_conns,
                };

                let mut val = serde_json::to_value(&resp).unwrap_or_default();
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("rss".to_string(), json!(mem.working_set_bytes));
                }

                RuntimeRpcEnvelope::success(id, val, &self.runtime_id)
            }

            "terminal.create" | "pty.spawn" => {
                let requested_id = params
                    .get("id")
                    .or_else(|| params.get("terminalId"))
                    .or_else(|| params.get("sessionId"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let attach_only = params
                    .get("attachOnly")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if attach_only {
                    if let Some(ref rid) = requested_id {
                        if let Ok(existing) = self.terminal_manager.get_terminal(rid).await {
                            return RuntimeRpcEnvelope::success(
                                id,
                                json!({
                                    "handle": existing.id,
                                    "terminalId": existing.id,
                                    "id": existing.id,
                                    "pid": existing.pid,
                                    "isReattach": true,
                                    "ok": true
                                }),
                                &self.runtime_id,
                            );
                        }
                    }
                    return RuntimeRpcEnvelope::failure(
                        id,
                        "SessionNotFoundError",
                        "Session not found",
                        Some(self.runtime_id.clone()),
                    );
                }

                let shell = params
                    .get("shell")
                    .or_else(|| params.get("shellOverride"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let command = params
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let args = params.get("args").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|item| item.as_str().map(|s| s.to_string()))
                        .collect()
                });
                let (exec, startup_cmd) = if let Some(sh) = shell {
                    (Some(sh), command)
                } else if args.is_some() {
                    (command, None)
                } else {
                    (None, command)
                };
                let cols = params
                    .get("cols")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u16);
                let rows = params
                    .get("rows")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u16);
                let cwd = params
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from);
                let env = params.get("env").and_then(|v| v.as_object()).map(|obj| {
                    let mut map = HashMap::new();
                    for (k, v) in obj {
                        if let Some(s) = v.as_str() {
                            map.insert(k.clone(), s.to_string());
                        }
                    }
                    map
                });

                match self
                    .terminal_manager
                    .create_terminal_with_id(exec, args, cols, rows, cwd, env, requested_id)
                    .await
                {
                    Ok((term_id, pid)) => {
                        if let Some(cmd_text) = startup_cmd {
                            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                            let _ = self
                                .terminal_manager
                                .write_input(&term_id, format!("{}\r\n", cmd_text).as_bytes())
                                .await;
                        }
                        RuntimeRpcEnvelope::success(
                            id,
                            json!({ "handle": term_id, "terminalId": term_id, "id": term_id, "pid": pid, "ok": true }),
                            &self.runtime_id,
                        )
                    }
                    Err(e) => RuntimeRpcEnvelope::failure(
                        id,
                        "terminal_create_error",
                        e.to_string(),
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.send" | "pty.send" => {
                let send_params: TerminalSendParams =
                    serde_json::from_value(params.clone()).unwrap_or_default();
                let term_id = send_params
                    .terminal_id
                    .or_else(|| {
                        params
                            .get("terminal")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .or_else(|| {
                        params
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });

                match term_id {
                    Some(tid) => {
                        let mut write_err = None;

                        if send_params.interrupt {
                            if let Err(e) = self.terminal_manager.write_input(&tid, b"\x03").await {
                                write_err = Some(e);
                            }
                        }

                        if let Some(text) = &send_params.text {
                            if let Err(e) = self
                                .terminal_manager
                                .write_input(&tid, text.as_bytes())
                                .await
                            {
                                write_err = Some(e);
                            }
                        }

                        if send_params.enter {
                            let newline: &[u8] = if cfg!(windows) { b"\r\n" } else { b"\n" };
                            if let Err(e) = self.terminal_manager.write_input(&tid, newline).await {
                                write_err = Some(e);
                            }
                        }

                        match write_err {
                            None => RuntimeRpcEnvelope::success(
                                id,
                                json!({
                                    "ok": true,
                                    "submitted": true,
                                    "terminalId": tid,
                                    "handle": tid,
                                }),
                                &self.runtime_id,
                            ),
                            Some(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_send_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or terminal handle",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.read" => {
                let read_params: TerminalReadParams =
                    serde_json::from_value(params.clone()).unwrap_or_default();
                let term_id = read_params
                    .terminal_id
                    .or_else(|| {
                        params
                            .get("terminal")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .or_else(|| {
                        params
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });

                match term_id {
                    Some(tid) => {
                        match self
                            .terminal_manager
                            .read_output(
                                &tid,
                                read_params.cursor,
                                read_params.limit,
                                read_params.screen,
                            )
                            .await
                        {
                            Ok(result) => {
                                let val = serde_json::to_value(&result).unwrap_or_default();
                                RuntimeRpcEnvelope::success(id, val, &self.runtime_id)
                            }
                            Err(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_read_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or terminal handle",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.wait" => {
                let wait_params: TerminalWaitParams =
                    serde_json::from_value(params.clone()).unwrap_or_default();
                let term_id = wait_params
                    .terminal_id
                    .or_else(|| {
                        params
                            .get("terminal")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .or_else(|| {
                        params
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });

                let condition = if wait_params.for_condition.is_empty() {
                    params.get("for").and_then(|v| v.as_str()).unwrap_or("exit")
                } else {
                    &wait_params.for_condition
                };

                let timeout_ms = wait_params
                    .timeout_ms
                    .or_else(|| params.get("timeoutMs").and_then(|v| v.as_u64()));

                match term_id {
                    Some(tid) => {
                        match self
                            .terminal_manager
                            .wait_for(&tid, condition, timeout_ms)
                            .await
                        {
                            Ok(val) => RuntimeRpcEnvelope::success(id, val, &self.runtime_id),
                            Err(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_wait_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or terminal handle",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.close" | "terminal.shutdown" | "terminal.kill" | "pty.shutdown" => {
                let close_params: TerminalCloseParams =
                    serde_json::from_value(params.clone()).unwrap_or_default();
                let is_all = close_params.all
                    || params.get("all").and_then(|v| v.as_bool()).unwrap_or(false);

                if is_all {
                    let closed_count = self.terminal_manager.kill_all().await;
                    RuntimeRpcEnvelope::success(
                        id,
                        json!({ "ok": true, "closed": closed_count }),
                        &self.runtime_id,
                    )
                } else {
                    let term_id = close_params
                        .terminal_id
                        .or_else(|| {
                            params
                                .get("terminal")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        })
                        .or_else(|| {
                            params
                                .get("handle")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        })
                        .or_else(|| {
                            params
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        });

                    match term_id {
                        Some(tid) => match self.terminal_manager.kill_terminal(&tid).await {
                            Ok(()) => RuntimeRpcEnvelope::success(
                                id,
                                json!({ "ok": true, "closed": 1, "terminalId": tid }),
                                &self.runtime_id,
                            ),
                            Err(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_kill_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        },
                        None => RuntimeRpcEnvelope::failure(
                            id,
                            "invalid_params",
                            "Missing terminal handle or --all",
                            Some(self.runtime_id.clone()),
                        ),
                    }
                }
            }

            "terminal.split" => {
                let split_params: TerminalSplitParams =
                    serde_json::from_value(params.clone()).unwrap_or_default();
                let term_id = split_params
                    .terminal_id
                    .or_else(|| {
                        params
                            .get("terminal")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .or_else(|| {
                        params
                            .get("id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });

                match term_id {
                    Some(tid) => {
                        match self
                            .terminal_manager
                            .split_terminal(&tid, split_params.direction, split_params.command)
                            .await
                        {
                            Ok((new_tid, pid)) => RuntimeRpcEnvelope::success(
                                id,
                                json!({
                                    "ok": true,
                                    "handle": new_tid,
                                    "terminalId": new_tid,
                                    "parentHandle": tid,
                                    "pid": pid,
                                }),
                                &self.runtime_id,
                            ),
                            Err(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_split_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing parent terminalId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.input" | "terminal.write" | "pty.write" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("id"))
                    .or_else(|| params.get("terminal"))
                    .and_then(|v| v.as_str());

                let data_bytes = params
                    .get("data")
                    .and_then(|v| v.as_str().map(|s| s.as_bytes().to_vec()))
                    .or_else(|| {
                        params.get("data").and_then(|v| {
                            v.as_array().map(|arr| {
                                arr.iter()
                                    .filter_map(|b| b.as_u64().map(|n| n as u8))
                                    .collect()
                            })
                        })
                    });

                match (term_id, data_bytes) {
                    (Some(tid), Some(bytes)) => {
                        match self.terminal_manager.write_input(tid, &bytes).await {
                            Ok(()) => RuntimeRpcEnvelope::success(
                                id,
                                json!({ "ok": true }),
                                &self.runtime_id,
                            ),
                            Err(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_input_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        }
                    }
                    _ => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or data",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.resize" | "pty.resize" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("id"))
                    .or_else(|| params.get("terminal"))
                    .and_then(|v| v.as_str());
                let cols = params
                    .get("cols")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u16)
                    .unwrap_or(80);
                let rows = params
                    .get("rows")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u16)
                    .unwrap_or(24);

                match term_id {
                    Some(tid) => match self.terminal_manager.resize(tid, cols, rows).await {
                        Ok(()) => {
                            RuntimeRpcEnvelope::success(id, json!({ "ok": true }), &self.runtime_id)
                        }
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "terminal_resize_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.list" | "terminal.ps" | "pty.listProcesses" => {
                let list = self.terminal_manager.list_terminals_detailed().await;
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "terminals": list }),
                    &self.runtime_id,
                )
            }

            "terminal.show" => {
                let term_id = params
                    .get("terminal")
                    .or_else(|| params.get("terminalId"))
                    .or_else(|| params.get("id"))
                    .or_else(|| params.get("handle"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => {
                        let list = self.terminal_manager.list_terminals_detailed().await;
                        if let Some(t) = list
                            .into_iter()
                            .find(|item| item.get("handle").and_then(|h| h.as_str()) == Some(tid))
                        {
                            RuntimeRpcEnvelope::success(
                                id,
                                json!({ "ok": true, "terminal": t }),
                                &self.runtime_id,
                            )
                        } else {
                            RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_not_found",
                                format!("Terminal not found: {tid}"),
                                Some(self.runtime_id.clone()),
                            )
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminal handle",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.pausePty" | "pausePty" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => match self.terminal_manager.pause_pty(tid).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "terminalId": tid, "paused": true }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "terminal_pause_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.resumePty" | "resumePty" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => match self.terminal_manager.resume_pty(tid).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "terminalId": tid, "paused": false }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "terminal_resume_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.setSessionBackground" | "setSessionBackground" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());
                let background = params
                    .get("background")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                match term_id {
                    Some(tid) => {
                        match self
                            .terminal_manager
                            .set_session_background(tid, background)
                            .await
                        {
                            Ok(()) => RuntimeRpcEnvelope::success(
                                id,
                                json!({ "ok": true, "terminalId": tid, "background": background }),
                                &self.runtime_id,
                            ),
                            Err(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_background_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.signal" | "signal" | "pty.sendSignal" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());
                let signal = params
                    .get("signal")
                    .or_else(|| params.get("sig"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("SIGINT");

                match term_id {
                    Some(tid) => match self.terminal_manager.signal(tid, signal).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "terminalId": tid, "signal": signal }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "terminal_signal_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.getSnapshot" | "getSnapshot" | "terminal.snapshot" | "pty.serialize" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => match self.terminal_manager.get_snapshot(tid).await {
                        Ok(snap) => {
                            let val = serde_json::to_value(&snap).unwrap_or_default();
                            RuntimeRpcEnvelope::success(id, val, &self.runtime_id)
                        }
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "terminal_snapshot_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.takePendingOutput" | "takePendingOutput" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());
                let include_snapshot = params
                    .get("includeSnapshot")
                    .or_else(|| params.get("include_snapshot"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                match term_id {
                    Some(tid) => {
                        match self
                            .terminal_manager
                            .take_pending_output(tid, include_snapshot)
                            .await
                        {
                            Ok(res) => {
                                let val = serde_json::to_value(&res).unwrap_or_default();
                                RuntimeRpcEnvelope::success(id, val, &self.runtime_id)
                            }
                            Err(e) => RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_pending_output_error",
                                e.to_string(),
                                Some(self.runtime_id.clone()),
                            ),
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.getCwd" | "getCwd" | "pty.getCwd" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => match self.terminal_manager.get_cwd(tid).await {
                        Ok(cwd) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "terminalId": tid, "cwd": cwd }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "terminal_cwd_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.getTitle" | "getTitle" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("sessionId"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => match self.terminal_manager.get_title(tid).await {
                        Ok(title) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "terminalId": tid, "title": title }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "terminal_title_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId or sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "git.exec" => {
                let cwd = params.get("cwd").and_then(|v| v.as_str()).unwrap_or(".");
                let args_vec: Vec<String> = params
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let timeout_ms = params
                    .get("timeoutMs")
                    .or_else(|| params.get("timeout_ms"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(30_000);

                let env_map: Option<HashMap<String, String>> = params
                    .get("env")
                    .and_then(|v| serde_json::from_value(v.clone()).ok());

                match self
                    .worktree_manager
                    .git_engine()
                    .exec(
                        std::path::Path::new(cwd),
                        &args_vec,
                        Duration::from_millis(timeout_ms),
                        env_map.as_ref(),
                    )
                    .await
                {
                    Ok(resp) => RuntimeRpcEnvelope::success(id, json!(resp), &self.runtime_id),
                    Err(e) => RuntimeRpcEnvelope::failure(
                        id,
                        "git_exec_error",
                        e,
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "git.responseAck" | "git.ack" => {
                let stream_id = params
                    .get("streamId")
                    .or_else(|| params.get("stream_id"))
                    .and_then(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                    });
                let seq = params
                    .get("seq")
                    .or_else(|| params.get("sequence"))
                    .or_else(|| params.get("ackedSeq"))
                    .and_then(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                    });

                match (stream_id, seq) {
                    (Some(sid), Some(s)) => {
                        let recorded = self.git_stream_registry.record_ack(sid, s).await;
                        RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "streamId": sid, "seq": s, "recorded": recorded }),
                            &self.runtime_id,
                        )
                    }
                    _ => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing streamId or seq",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "git.abort" | "git.responseAbort" => {
                let stream_id = params
                    .get("streamId")
                    .or_else(|| params.get("stream_id"))
                    .and_then(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                    });

                match stream_id {
                    Some(sid) => {
                        let aborted = self.git_stream_registry.abort(sid).await;
                        RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "streamId": sid, "aborted": aborted }),
                            &self.runtime_id,
                        )
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing streamId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "worktree.list" => {
                let repo = params
                    .get("repo")
                    .or_else(|| params.get("repoId"))
                    .and_then(|v| v.as_str());
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize);

                let list = self.worktree_manager.list_worktrees(repo, limit).await;
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "worktrees": list }),
                    &self.runtime_id,
                )
            }

            "worktree.show" => {
                let repo = params
                    .get("repo")
                    .or_else(|| params.get("repoId"))
                    .and_then(|v| v.as_str());
                let selector = params
                    .get("worktree")
                    .or_else(|| params.get("worktreeId"))
                    .or_else(|| params.get("path"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("active");

                if let Some(wt) = self.worktree_manager.show_worktree(selector, repo).await {
                    RuntimeRpcEnvelope::success(
                        id,
                        json!({ "ok": true, "worktree": wt }),
                        &self.runtime_id,
                    )
                } else {
                    RuntimeRpcEnvelope::failure(
                        id,
                        "worktree_not_found",
                        format!("Worktree not found: {selector}"),
                        Some(self.runtime_id.clone()),
                    )
                }
            }

            "worktree.create" => {
                let create_params: WorktreeCreateParams =
                    serde_json::from_value(params.clone()).unwrap_or_default();

                match self.worktree_manager.create_worktree(create_params).await {
                    Ok(wt) => RuntimeRpcEnvelope::success(
                        id,
                        json!({ "ok": true, "worktree": wt }),
                        &self.runtime_id,
                    ),
                    Err(e) => RuntimeRpcEnvelope::failure(
                        id,
                        "worktree_create_error",
                        e,
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "worktree.rm" | "worktree.remove" | "worktree.delete" => {
                let rm_params: WorktreeRmParams =
                    serde_json::from_value(params.clone()).unwrap_or_default();

                match self.worktree_manager.remove_worktree(rm_params).await {
                    Ok(removed) => RuntimeRpcEnvelope::success(
                        id,
                        json!({ "ok": true, "removed": removed }),
                        &self.runtime_id,
                    ),
                    Err(e) => RuntimeRpcEnvelope::failure(
                        id,
                        "worktree_remove_error",
                        e,
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "worktree.lock" => {
                let repo = params.get("repo").and_then(|v| v.as_str());
                let worktree = params
                    .get("worktree")
                    .or_else(|| params.get("path"))
                    .and_then(|v| v.as_str());
                let reason = params.get("reason").and_then(|v| v.as_str());

                match worktree {
                    Some(wt) => match self.worktree_manager.lock_worktree(repo, wt, reason).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "worktree": wt, "locked": true }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "worktree_lock_error",
                            e,
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing worktree path or selector",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "worktree.unlock" => {
                let repo = params.get("repo").and_then(|v| v.as_str());
                let worktree = params
                    .get("worktree")
                    .or_else(|| params.get("path"))
                    .and_then(|v| v.as_str());

                match worktree {
                    Some(wt) => match self.worktree_manager.unlock_worktree(repo, wt).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "worktree": wt, "locked": false }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "worktree_unlock_error",
                            e,
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing worktree path or selector",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "worktree.ps" => {
                let rows = self.status_store.list_all().await;
                let worktrees: Vec<serde_json::Value> = rows
                    .into_iter()
                    .map(|r| {
                        json!({
                            "id": r.session_id,
                            "branch": r.session_id,
                            "status": match r.verdict {
                                AgentVerdict::Live => "live",
                                AgentVerdict::Unverifiable => "unverifiable",
                                AgentVerdict::Exited => "exited",
                            },
                            "path": r.description,
                            "updatedAtMs": r.updated_at_ms,
                        })
                    })
                    .collect();
                RuntimeRpcEnvelope::success(id, json!({ "worktrees": worktrees }), &self.runtime_id)
            }

            "status.get" => {
                let session_id = params
                    .get("sessionId")
                    .or_else(|| params.get("session_id"))
                    .and_then(|v| v.as_str());

                match session_id {
                    Some(sid) => {
                        let row = self.status_store.get_status(sid).await;
                        RuntimeRpcEnvelope::success(id, json!(row), &self.runtime_id)
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing sessionId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "status.list" => {
                let rows = self.status_store.list_all().await;
                RuntimeRpcEnvelope::success(id, json!(rows), &self.runtime_id)
            }

            "status.update" => {
                let session_id = params
                    .get("sessionId")
                    .or_else(|| params.get("session_id"))
                    .and_then(|v| v.as_str());
                let verdict_str = params.get("verdict").and_then(|v| v.as_str());
                let description = params
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let verdict = match verdict_str {
                    Some(v) if v.eq_ignore_ascii_case("live") => Some(AgentVerdict::Live),
                    Some(v) if v.eq_ignore_ascii_case("unverifiable") => {
                        Some(AgentVerdict::Unverifiable)
                    }
                    Some(v) if v.eq_ignore_ascii_case("exited") => Some(AgentVerdict::Exited),
                    _ => None,
                };

                match (session_id, verdict) {
                    (Some(sid), Some(v)) => {
                        self.status_store.update_status(sid, v, description).await;
                        RuntimeRpcEnvelope::success(id, json!({ "ok": true }), &self.runtime_id)
                    }
                    _ => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing or invalid sessionId/verdict",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "hook.ingest" => {
                let session_id = params
                    .get("sessionId")
                    .or_else(|| params.get("session_id"))
                    .or_else(|| params.get("paneKey"))
                    .or_else(|| params.get("pane_key"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");

                let status_str = params
                    .get("status")
                    .or_else(|| params.get("state"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("working");

                let description = params
                    .get("text")
                    .or_else(|| params.get("description"))
                    .or_else(|| params.get("message"))
                    .or_else(|| params.get("prompt"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let verdict = match status_str.to_lowercase().as_str() {
                    "done" | "exited" | "exit" | "completed" => AgentVerdict::Exited,
                    "unverifiable" => AgentVerdict::Unverifiable,
                    _ => AgentVerdict::Live,
                };

                self.status_store
                    .update_status(session_id, verdict, description)
                    .await;
                RuntimeRpcEnvelope::success(id, json!({ "ok": true }), &self.runtime_id)
            }

            "status.flush" => match self.status_store.flush_atomic().await {
                Ok(()) => RuntimeRpcEnvelope::success(id, json!({ "ok": true }), &self.runtime_id),
                Err(e) => RuntimeRpcEnvelope::failure(
                    id,
                    "flush_error",
                    e.to_string(),
                    Some(self.runtime_id.clone()),
                ),
            },

            // --- Domain 6: Remote Relay & System Supervision RPCs ---
            "fs.read" | "fs.readFile" | "wslfs.readFile" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("filePath"))
                    .and_then(|v| v.as_str());

                match path {
                    Some(p) => match RelayFsHandler::read_file(p).await {
                        Ok(bytes) => {
                            let text = String::from_utf8(bytes.clone()).ok();
                            RuntimeRpcEnvelope::success(
                                id,
                                json!({
                                    "ok": true,
                                    "path": p,
                                    "bytes": bytes,
                                    "content": text,
                                    "size": bytes.len(),
                                }),
                                &self.runtime_id,
                            )
                        }
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_read_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or filePath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.readRange" | "fs.readFileRange" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("filePath"))
                    .and_then(|v| v.as_str());
                let start = params
                    .get("start")
                    .or_else(|| params.get("position"))
                    .or_else(|| params.get("offset"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let length = params
                    .get("length")
                    .or_else(|| params.get("limit"))
                    .and_then(|v| v.as_u64());
                let end = params
                    .get("end")
                    .and_then(|v| v.as_u64())
                    .or_else(|| length.map(|l| start + l))
                    .unwrap_or(start + 1024);

                match path {
                    Some(p) => match RelayFsHandler::read_range(p, start, end).await {
                        Ok(bytes) => {
                            let text = String::from_utf8(bytes.clone()).ok();
                            RuntimeRpcEnvelope::success(
                                id,
                                json!({
                                    "ok": true,
                                    "path": p,
                                    "start": start,
                                    "end": end,
                                    "bytes": bytes,
                                    "content": text,
                                    "length": bytes.len(),
                                }),
                                &self.runtime_id,
                            )
                        }
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_read_range_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or filePath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.write" | "fs.writeFile" | "wslfs.writeFile" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("filePath"))
                    .and_then(|v| v.as_str());
                let data_opt: Option<Vec<u8>> = params
                    .get("content")
                    .or_else(|| params.get("data"))
                    .and_then(|v| {
                        if let Some(s) = v.as_str() {
                            Some(s.as_bytes().to_vec())
                        } else if let Some(arr) = v.as_array() {
                            Some(
                                arr.iter()
                                    .filter_map(|x| x.as_u64().map(|b| b as u8))
                                    .collect(),
                            )
                        } else {
                            None
                        }
                    });

                match (path, data_opt) {
                    (Some(p), Some(data)) => match RelayFsHandler::write_file(p, &data).await {
                        Ok(written) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "path": p, "bytesWritten": written }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_write_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    _ => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or data/content",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.stat" | "wslfs.stat" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("filePath"))
                    .and_then(|v| v.as_str());

                match path {
                    Some(p) => match RelayFsHandler::stat(p).await {
                        Ok(stat) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "path": p, "stat": stat }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_stat_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or filePath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.lstat" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("filePath"))
                    .and_then(|v| v.as_str());

                match path {
                    Some(p) => match RelayFsHandler::lstat(p).await {
                        Ok(stat) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "path": p, "stat": stat }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_lstat_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or filePath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.mkdir" | "wslfs.mkdir" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("dirPath"))
                    .and_then(|v| v.as_str());
                let recursive = params
                    .get("recursive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);

                match path {
                    Some(p) => match RelayFsHandler::mkdir(p, recursive).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "path": p, "created": true }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_mkdir_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or dirPath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.delete" | "fs.remove" | "fs.rm" | "fs.unlink" | "wslfs.unlink" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("filePath"))
                    .and_then(|v| v.as_str());
                let recursive = params
                    .get("recursive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                match path {
                    Some(p) => match RelayFsHandler::delete(p, recursive).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "path": p, "deleted": true }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_delete_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or filePath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.rename" | "wslfs.rename" => {
                let from = params
                    .get("from")
                    .or_else(|| params.get("oldPath"))
                    .or_else(|| params.get("src"))
                    .and_then(|v| v.as_str());
                let to = params
                    .get("to")
                    .or_else(|| params.get("newPath"))
                    .or_else(|| params.get("dst"))
                    .and_then(|v| v.as_str());
                let no_clobber = params
                    .get("noClobber")
                    .or_else(|| params.get("no_clobber"))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                match (from, to) {
                    (Some(f), Some(t)) => match RelayFsHandler::rename(f, t, no_clobber).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "from": f, "to": t, "renamed": true }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_rename_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    _ => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing from/oldPath or to/newPath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.copy" => {
                let from = params
                    .get("from")
                    .or_else(|| params.get("src"))
                    .and_then(|v| v.as_str());
                let to = params
                    .get("to")
                    .or_else(|| params.get("dst"))
                    .and_then(|v| v.as_str());

                match (from, to) {
                    (Some(f), Some(t)) => match RelayFsHandler::copy(f, t).await {
                        Ok(copied) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "from": f, "to": t, "bytesCopied": copied }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_copy_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    _ => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing from/src or to/dst",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.readDir" | "fs.readdir" | "wslfs.readdir" => {
                let path = params
                    .get("path")
                    .or_else(|| params.get("dirPath"))
                    .and_then(|v| v.as_str());
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize);

                match path {
                    Some(p) => match RelayFsHandler::read_dir(p, limit).await {
                        Ok(entries) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "path": p, "entries": entries }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "fs_readdir_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path or dirPath",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.watch" => {
                let client_id = params
                    .get("clientId")
                    .or_else(|| params.get("client_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("default-client");
                let path = params.get("path").and_then(|v| v.as_str());
                let recursive = params
                    .get("recursive")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                match path {
                    Some(p) => {
                        let watch_id = self.watch_registry.watch(client_id, p, recursive).await;
                        RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "watchId": watch_id, "path": p, "recursive": recursive }),
                            &self.runtime_id,
                        )
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing path",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.unwatch" => {
                let client_id = params
                    .get("clientId")
                    .or_else(|| params.get("client_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("default-client");
                let watch_id = params
                    .get("watchId")
                    .or_else(|| params.get("watch_id"))
                    .and_then(|v| v.as_u64());

                match watch_id {
                    Some(wid) => {
                        let removed = self.watch_registry.unwatch(client_id, wid).await;
                        RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "watchId": wid, "unwatched": removed }),
                            &self.runtime_id,
                        )
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing watchId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "fs.watches" | "fs.listWatches" => {
                let client_id = params
                    .get("clientId")
                    .or_else(|| params.get("client_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("default-client");

                let watches = self.watch_registry.list_watches(client_id).await;
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "clientId": client_id, "watches": watches }),
                    &self.runtime_id,
                )
            }

            "ports.scan" | "ports.detect" | "net.scanPorts" => {
                let ports = PortScanner::scan_listening_ports().await;
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "ports": ports }),
                    &self.runtime_id,
                )
            }

            "skills.list" => {
                let skills_dir = params
                    .get("skillsDir")
                    .or_else(|| params.get("skills_dir"))
                    .or_else(|| params.get("path"))
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        std::env::current_dir()
                            .unwrap_or_else(|_| PathBuf::from("."))
                            .join(".orca")
                            .join("skills")
                    });

                match SkillInstaller::list_skills(&skills_dir).await {
                    Ok(skills) => RuntimeRpcEnvelope::success(
                        id,
                        json!({ "ok": true, "skillsDir": skills_dir.to_string_lossy(), "skills": skills }),
                        &self.runtime_id,
                    ),
                    Err(e) => RuntimeRpcEnvelope::failure(
                        id,
                        "skills_list_error",
                        e.to_string(),
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "skills.preview" => {
                let source_dir = params
                    .get("sourceDir")
                    .or_else(|| params.get("source_dir"))
                    .or_else(|| params.get("path"))
                    .and_then(|v| v.as_str());

                match source_dir {
                    Some(src) => match SkillInstaller::preview_skill(src).await {
                        Ok(preview) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "preview": preview }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "skills_preview_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing sourceDir or path",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "skills.install" => {
                let source_dir = params
                    .get("sourceDir")
                    .or_else(|| params.get("source_dir"))
                    .or_else(|| params.get("src"))
                    .and_then(|v| v.as_str());
                let target_dir = params
                    .get("targetDir")
                    .or_else(|| params.get("target_dir"))
                    .or_else(|| params.get("skillsDir"))
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        std::env::current_dir()
                            .unwrap_or_else(|_| PathBuf::from("."))
                            .join(".orca")
                            .join("skills")
                    });

                match source_dir {
                    Some(src) => match SkillInstaller::install_skill(src, &target_dir).await {
                        Ok(info) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "installed": info }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "skills_install_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing sourceDir",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "skills.remove" => {
                let skills_dir = params
                    .get("skillsDir")
                    .or_else(|| params.get("skills_dir"))
                    .and_then(|v| v.as_str())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        std::env::current_dir()
                            .unwrap_or_else(|_| PathBuf::from("."))
                            .join(".orca")
                            .join("skills")
                    });
                let name = params
                    .get("name")
                    .or_else(|| params.get("skillName"))
                    .and_then(|v| v.as_str());

                match name {
                    Some(n) => match SkillInstaller::remove_skill(n, &skills_dir).await {
                        Ok(()) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "name": n, "removed": true }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "skills_remove_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing name or skillName",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "aiVault.search" | "aiVault.searchSessions" | "sessions.search" => {
                let query = params
                    .get("query")
                    .or_else(|| params.get("q"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let limit = params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize)
                    .unwrap_or(50);
                let dirs: Vec<PathBuf> = params
                    .get("scopeDirs")
                    .or_else(|| params.get("scope_dirs"))
                    .or_else(|| params.get("dirs"))
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(PathBuf::from))
                            .collect()
                    })
                    .unwrap_or_else(|| {
                        vec![std::env::current_dir()
                            .unwrap_or_else(|_| PathBuf::from("."))
                            .join(".orca")]
                    });

                let results = SessionSearchEngine::search(query, &dirs, limit).await;
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "query": query, "results": results }),
                    &self.runtime_id,
                )
            }

            "externalAutomations.create" | "automations.create" => {
                let name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unnamed-task");
                let command = params
                    .get("command")
                    .or_else(|| params.get("cmd"))
                    .and_then(|v| v.as_str());
                let args: Vec<String> = params
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let cwd = params
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                match command {
                    Some(cmd) => {
                        let job_id = self.automations.create_job(name, cmd, args, cwd).await;
                        RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "jobId": job_id, "name": name }),
                            &self.runtime_id,
                        )
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing command",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "externalAutomations.run"
            | "externalAutomations.act"
            | "automations.run"
            | "automations.act" => {
                let job_id = params
                    .get("jobId")
                    .or_else(|| params.get("job_id"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());

                match job_id {
                    Some(jid) => match self.automations.run_job(jid).await {
                        Ok(run_rec) => RuntimeRpcEnvelope::success(
                            id,
                            json!({ "ok": true, "run": run_rec }),
                            &self.runtime_id,
                        ),
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "automation_run_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    },
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing jobId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "externalAutomations.list" | "automations.list" => {
                let jobs = self.automations.list_jobs().await;
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "jobs": jobs }),
                    &self.runtime_id,
                )
            }

            "externalAutomations.runs" | "automations.runs" => {
                let job_id = params
                    .get("jobId")
                    .or_else(|| params.get("job_id"))
                    .and_then(|v| v.as_str());

                let runs = self.automations.list_runs(job_id).await;
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "runs": runs }),
                    &self.runtime_id,
                )
            }

            "system.cgroupScope" | "systemd.scope" => {
                let content = params
                    .get("content")
                    .or_else(|| params.get("cgroupContent"))
                    .and_then(|v| v.as_str());

                let scope = match content {
                    Some(c) => parse_cgroup_scope(c),
                    None => {
                        #[cfg(target_os = "linux")]
                        {
                            tokio::fs::read_to_string("/proc/self/cgroup")
                                .await
                                .ok()
                                .and_then(|c| parse_cgroup_scope(&c))
                        }
                        #[cfg(not(target_os = "linux"))]
                        {
                            None
                        }
                    }
                };

                let supported = is_systemd_user_scope_supported();
                let nonce = params
                    .get("nonce")
                    .and_then(|v| v.as_str())
                    .unwrap_or("test");
                let unit_name = daemon_scope_unit_name(nonce);

                RuntimeRpcEnvelope::success(
                    id,
                    json!({
                        "ok": true,
                        "supported": supported,
                        "unitName": unit_name,
                        "currentScope": scope,
                    }),
                    &self.runtime_id,
                )
            }

            "system.relocatedHost" | "daemon.relocation" => {
                let version = params
                    .get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or(env!("CARGO_PKG_VERSION"));
                let exe_name = daemon_host_exe_name();
                let dir = resolve_local_appdata_daemon_dir(version);

                RuntimeRpcEnvelope::success(
                    id,
                    json!({
                        "ok": true,
                        "version": version,
                        "exeName": exe_name,
                        "relocatedDir": dir.map(|d| d.to_string_lossy().to_string()),
                    }),
                    &self.runtime_id,
                )
            }

            "terminal.getSize" | "pty.getSize" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("id"))
                    .or_else(|| params.get("terminal"))
                    .or_else(|| params.get("handle"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => {
                        let list = self.terminal_manager.list_terminals_detailed().await;
                        if let Some(t) = list
                            .into_iter()
                            .find(|item| item.get("handle").and_then(|h| h.as_str()) == Some(tid))
                        {
                            let cols = t.get("cols").and_then(|v| v.as_u64()).unwrap_or(80);
                            let rows = t.get("rows").and_then(|v| v.as_u64()).unwrap_or(24);
                            RuntimeRpcEnvelope::success(
                                id,
                                json!({ "ok": true, "cols": cols, "rows": rows }),
                                &self.runtime_id,
                            )
                        } else {
                            RuntimeRpcEnvelope::failure(
                                id,
                                "terminal_not_found",
                                format!("Terminal not found: {tid}"),
                                Some(self.runtime_id.clone()),
                            )
                        }
                    }
                    None => RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing terminalId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "pty.getDefaultShell" => {
                let shell = if cfg!(windows) {
                    std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
                } else {
                    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
                };
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "shell": shell }),
                    &self.runtime_id,
                )
            }

            "pty.getProfiles" => {
                let profiles = if cfg!(windows) {
                    vec!["powershell.exe", "cmd.exe"]
                } else {
                    vec!["bash", "zsh", "sh"]
                };
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "profiles": profiles }),
                    &self.runtime_id,
                )
            }

            "session.resolveHome" | "wslfs.home" => {
                let home = std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_else(|_| ".".into());
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "home": home }),
                    &self.runtime_id,
                )
            }

            "agent.execNonInteractive" => {
                let binary = params.get("binary").and_then(|v| v.as_str()).unwrap_or("");
                let args: Vec<String> = params
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                let cwd = params.get("cwd").and_then(|v| v.as_str());
                let stdin_data = params.get("stdin").and_then(|v| v.as_str());
                let timeout_ms = params
                    .get("timeoutMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(60_000);

                if binary.is_empty() {
                    RuntimeRpcEnvelope::failure(
                        id,
                        "invalid_params",
                        "Missing binary",
                        Some(self.runtime_id.clone()),
                    )
                } else {
                    let mut cmd = tokio::process::Command::new(binary);
                    cmd.args(&args);
                    if let Some(c) = cwd {
                        cmd.current_dir(c);
                    }
                    if stdin_data.is_some() {
                        cmd.stdin(std::process::Stdio::piped());
                    }
                    cmd.stdout(std::process::Stdio::piped());
                    cmd.stderr(std::process::Stdio::piped());

                    match cmd.spawn() {
                        Ok(mut child) => {
                            if let Some(data) = stdin_data {
                                if let Some(mut stdin) = child.stdin.take() {
                                    use tokio::io::AsyncWriteExt;
                                    let _ = stdin.write_all(data.as_bytes()).await;
                                }
                            }
                            match tokio::time::timeout(
                                Duration::from_millis(timeout_ms),
                                child.wait(),
                            )
                            .await
                            {
                                Ok(Ok(status)) => {
                                    use tokio::io::AsyncReadExt;
                                    let mut stdout_buf = Vec::new();
                                    let mut stderr_buf = Vec::new();
                                    if let Some(mut s) = child.stdout.take() {
                                        let _ = s.read_to_end(&mut stdout_buf).await;
                                    }
                                    if let Some(mut s) = child.stderr.take() {
                                        let _ = s.read_to_end(&mut stderr_buf).await;
                                    }
                                    RuntimeRpcEnvelope::success(
                                        id,
                                        json!({
                                            "ok": true,
                                            "stdout": String::from_utf8_lossy(&stdout_buf),
                                            "stderr": String::from_utf8_lossy(&stderr_buf),
                                            "exitCode": status.code().unwrap_or(0),
                                            "timedOut": false,
                                            "canceled": false,
                                        }),
                                        &self.runtime_id,
                                    )
                                }
                                Ok(Err(e)) => RuntimeRpcEnvelope::failure(
                                    id,
                                    "exec_error",
                                    e.to_string(),
                                    Some(self.runtime_id.clone()),
                                ),
                                Err(_) => {
                                    let _ = child.kill().await;
                                    RuntimeRpcEnvelope::success(
                                        id,
                                        json!({
                                            "ok": true,
                                            "stdout": "",
                                            "stderr": "",
                                            "exitCode": null,
                                            "timedOut": true,
                                            "canceled": false,
                                        }),
                                        &self.runtime_id,
                                    )
                                }
                            }
                        }
                        Err(e) => RuntimeRpcEnvelope::failure(
                            id,
                            "spawn_error",
                            e.to_string(),
                            Some(self.runtime_id.clone()),
                        ),
                    }
                }
            }

            "agent.cancelExec" => RuntimeRpcEnvelope::success(
                id,
                json!({ "ok": true, "canceled": true }),
                &self.runtime_id,
            ),

            "workspace.get" => {
                let namespace = params
                    .get("namespace")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                RuntimeRpcEnvelope::success(
                    id,
                    json!({
                        "ok": true,
                        "namespace": namespace,
                        "revision": 1,
                        "updatedAt": std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                        "schemaVersion": 1,
                        "session": {
                            "activeRepoId": null,
                            "activeWorktreeId": null,
                            "activeTabId": null,
                            "tabsByWorktree": {},
                            "terminalLayoutsByTabId": {}
                        }
                    }),
                    &self.runtime_id,
                )
            }

            "workspace.patch" => {
                let snapshot = params.get("snapshot").cloned().unwrap_or(json!({}));
                RuntimeRpcEnvelope::success(
                    id,
                    json!({ "ok": true, "snapshot": snapshot }),
                    &self.runtime_id,
                )
            }

            "workspace.presence" => {
                RuntimeRpcEnvelope::success(id, json!({ "ok": true }), &self.runtime_id)
            }

            "preflight.detectAgents" => RuntimeRpcEnvelope::success(
                id,
                json!({ "ok": true, "agents": ["claude", "codex", "gemini", "orca"] }),
                &self.runtime_id,
            ),

            "preflight.detectWindowsTerminalCapabilities" => RuntimeRpcEnvelope::success(
                id,
                json!({
                    "ok": true,
                    "conpty": cfg!(windows),
                    "wt": false,
                    "wsl": true,
                }),
                &self.runtime_id,
            ),

            other => RuntimeRpcEnvelope::failure(
                id,
                "method_not_found",
                format!("Method not found: {}", other),
                Some(self.runtime_id.clone()),
            ),
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub endpoint: String,
    pub idle_timeout: Duration,
    pub status_path: PathBuf,
    pub runtime_id: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        let endpoint = if cfg!(windows) {
            format!(r"\\.\pipe\orcad-default-{}", std::process::id())
        } else {
            format!("/tmp/orcad-default-{}.sock", std::process::id())
        };
        let status_path =
            std::env::temp_dir().join(format!("orcad-status-{}.json", std::process::id()));

        Self {
            endpoint,
            idle_timeout: Duration::from_secs(30),
            status_path,
            runtime_id: "orcad-native".into(),
        }
    }
}

pub struct Server {
    pub endpoint: String,
    status_store: Arc<AgentStatusStore>,
    terminal_manager: Arc<TerminalManager>,
    worktree_manager: Arc<WorktreeManager>,
    idle_exit: Arc<IdleExitManager>,
    metrics: Arc<DaemonMetrics>,
    git_stream_registry: Arc<crate::git_response_stream::GitResponseStreamRegistry>,
    runtime_id: String,
    shutdown_tx: broadcast::Sender<()>,
    _server_task: JoinHandle<()>,
}

impl Server {
    pub async fn start(endpoint: &str) -> Result<Self, std::io::Error> {
        let config = ServerConfig {
            endpoint: endpoint.to_string(),
            ..ServerConfig::default()
        };
        Self::start_with_config(config).await
    }

    pub async fn start_with_config(config: ServerConfig) -> Result<Self, std::io::Error> {
        let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
        let idle_exit = IdleExitManager::new(config.idle_timeout, shutdown_tx.clone());
        let terminal_manager = TerminalManager::new(Arc::clone(&idle_exit));
        let status_store = Arc::new(AgentStatusStore::new(&config.status_path));
        let worktree_manager = Arc::new(WorktreeManager::new(Arc::clone(&status_store)));
        let metrics = Arc::new(DaemonMetrics::new());
        let git_stream_registry =
            Arc::new(crate::git_response_stream::GitResponseStreamRegistry::new());

        let dispatcher = Arc::new(RpcDispatcher::with_git_registry(
            Arc::clone(&status_store),
            Arc::clone(&terminal_manager),
            Arc::clone(&worktree_manager),
            Arc::clone(&idle_exit),
            Arc::clone(&metrics),
            Arc::clone(&git_stream_registry),
            config.runtime_id.clone(),
        ));

        let endpoint_clone = config.endpoint.clone();
        let dispatcher_clone = Arc::clone(&dispatcher);
        let idle_exit_clone = Arc::clone(&idle_exit);

        #[cfg(windows)]
        let server_task = tokio::spawn(async move {
            if let Err(e) = ipc::listen_named_pipe(
                endpoint_clone,
                shutdown_rx,
                dispatcher_clone,
                idle_exit_clone,
            )
            .await
            {
                tracing::error!("Named pipe server error: {:?}", e);
            }
        });

        #[cfg(unix)]
        let server_task = tokio::spawn(async move {
            if let Err(e) = ipc::listen_unix_socket(
                endpoint_clone,
                shutdown_rx,
                dispatcher_clone,
                idle_exit_clone,
            )
            .await
            {
                tracing::error!("Unix socket server error: {:?}", e);
            }
        });

        // Give listener a brief moment to bind
        tokio::time::sleep(Duration::from_millis(15)).await;

        Ok(Self {
            endpoint: config.endpoint,
            status_store,
            terminal_manager,
            worktree_manager,
            idle_exit,
            metrics,
            git_stream_registry,
            runtime_id: config.runtime_id,
            shutdown_tx,
            _server_task: server_task,
        })
    }

    pub async fn shutdown(&self) -> Result<(), std::io::Error> {
        let _ = self.shutdown_tx.send(());
        let _ = self.terminal_manager.kill_all().await;
        let _ = self.status_store.flush_atomic().await;
        Ok(())
    }

    pub fn status_store(&self) -> &AgentStatusStore {
        &self.status_store
    }

    pub fn status_store_arc(&self) -> Arc<AgentStatusStore> {
        Arc::clone(&self.status_store)
    }

    pub fn terminal_manager(&self) -> &TerminalManager {
        &self.terminal_manager
    }

    pub fn worktree_manager(&self) -> &WorktreeManager {
        &self.worktree_manager
    }

    pub fn idle_exit(&self) -> &IdleExitManager {
        &self.idle_exit
    }

    pub fn metrics(&self) -> &DaemonMetrics {
        &self.metrics
    }

    pub fn git_stream_registry(&self) -> &crate::git_response_stream::GitResponseStreamRegistry {
        &self.git_stream_registry
    }

    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub fn subscribe_shutdown(&self) -> broadcast::Receiver<()> {
        self.shutdown_tx.subscribe()
    }
}
