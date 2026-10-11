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
use crate::diagnostics::{get_process_memory, DaemonMetrics};
use crate::idle_exit::IdleExitManager;
use crate::ipc;
use crate::terminal_manager::TerminalManager;
use crate::worktree_manager::WorktreeManager;

pub struct RpcDispatcher {
    pub status_store: Arc<AgentStatusStore>,
    pub terminal_manager: Arc<TerminalManager>,
    pub worktree_manager: Arc<WorktreeManager>,
    pub idle_exit: Arc<IdleExitManager>,
    pub metrics: Arc<DaemonMetrics>,
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

            "status" | "daemon.status" => {
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

            "terminal.create" => {
                let command = params
                    .get("command")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let args = params.get("args").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|item| item.as_str().map(|s| s.to_string()))
                        .collect()
                });
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
                    .create_terminal(command, args, cols, rows, cwd, env)
                    .await
                {
                    Ok((term_id, pid)) => RuntimeRpcEnvelope::success(
                        id,
                        json!({ "handle": term_id, "terminalId": term_id, "id": term_id, "pid": pid, "ok": true }),
                        &self.runtime_id,
                    ),
                    Err(e) => RuntimeRpcEnvelope::failure(
                        id,
                        "terminal_create_error",
                        e.to_string(),
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.send" => {
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

            "terminal.close" | "terminal.shutdown" | "terminal.kill" => {
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

            "terminal.input" | "terminal.write" => {
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

            "terminal.resize" => {
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

            "terminal.list" => {
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

            "worktree.list" => {
                let repo = params.get("repo").and_then(|v| v.as_str());
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
                let selector = params
                    .get("worktree")
                    .or_else(|| params.get("path"))
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("active");

                if let Some(wt) = self.worktree_manager.show_worktree(selector).await {
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

            "status.flush" => match self.status_store.flush_atomic().await {
                Ok(()) => RuntimeRpcEnvelope::success(id, json!({ "ok": true }), &self.runtime_id),
                Err(e) => RuntimeRpcEnvelope::failure(
                    id,
                    "flush_error",
                    e.to_string(),
                    Some(self.runtime_id.clone()),
                ),
            },

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

        let dispatcher = Arc::new(RpcDispatcher::new(
            Arc::clone(&status_store),
            Arc::clone(&terminal_manager),
            Arc::clone(&worktree_manager),
            Arc::clone(&idle_exit),
            Arc::clone(&metrics),
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

    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub fn subscribe_shutdown(&self) -> broadcast::Receiver<()> {
        self.shutdown_tx.subscribe()
    }
}
