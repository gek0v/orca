use orca_protocol::rpc_envelope::{RuntimeRpcEnvelope, RuntimeRpcRequest};
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::agent_status_store::{AgentStatusStore, AgentVerdict};
use crate::idle_exit::IdleExitManager;
use crate::ipc;
use crate::terminal_manager::TerminalManager;

pub struct RpcDispatcher {
    pub status_store: Arc<AgentStatusStore>,
    pub terminal_manager: Arc<TerminalManager>,
    pub runtime_id: String,
}

impl RpcDispatcher {
    pub fn new(
        status_store: Arc<AgentStatusStore>,
        terminal_manager: Arc<TerminalManager>,
        runtime_id: impl Into<String>,
    ) -> Self {
        Self {
            status_store,
            terminal_manager,
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
                    Ok(term_id) => RuntimeRpcEnvelope::success(
                        id,
                        json!({ "handle": term_id, "terminalId": term_id, "id": term_id, "ok": true }),
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

            "terminal.input" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("id"))
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

            "terminal.kill" => {
                let term_id = params
                    .get("terminalId")
                    .or_else(|| params.get("id"))
                    .and_then(|v| v.as_str());

                match term_id {
                    Some(tid) => match self.terminal_manager.kill_terminal(tid).await {
                        Ok(()) => {
                            RuntimeRpcEnvelope::success(id, json!({ "ok": true }), &self.runtime_id)
                        }
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
                        "Missing terminalId",
                        Some(self.runtime_id.clone()),
                    ),
                }
            }

            "terminal.list" => {
                let list = self.terminal_manager.list_terminals().await;
                RuntimeRpcEnvelope::success(id, json!(list), &self.runtime_id)
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
    idle_exit: Arc<IdleExitManager>,
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
        let dispatcher = Arc::new(RpcDispatcher::new(
            Arc::clone(&status_store),
            Arc::clone(&terminal_manager),
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

        // Give the listener a brief moment to bind
        tokio::time::sleep(Duration::from_millis(15)).await;

        Ok(Self {
            endpoint: config.endpoint,
            status_store,
            terminal_manager,
            idle_exit,
            runtime_id: config.runtime_id,
            shutdown_tx,
            _server_task: server_task,
        })
    }

    pub async fn shutdown(&self) -> Result<(), std::io::Error> {
        let _ = self.shutdown_tx.send(());
        self.terminal_manager.kill_all().await;
        let _ = self.status_store.flush_atomic().await;
        Ok(())
    }

    pub fn status_store(&self) -> &AgentStatusStore {
        &self.status_store
    }

    pub fn terminal_manager(&self) -> &TerminalManager {
        &self.terminal_manager
    }

    pub fn idle_exit(&self) -> &IdleExitManager {
        &self.idle_exit
    }

    pub fn runtime_id(&self) -> &str {
        &self.runtime_id
    }

    pub fn subscribe_shutdown(&self) -> broadcast::Receiver<()> {
        self.shutdown_tx.subscribe()
    }
}
