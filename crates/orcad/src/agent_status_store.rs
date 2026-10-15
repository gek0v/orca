use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{broadcast, RwLock};

#[derive(Error, Debug)]
pub enum StoreError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentVerdict {
    Live,
    Unverifiable,
    Exited,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusRow {
    pub session_id: String,
    pub verdict: AgentVerdict,
    pub description: String,
    pub updated_at_ms: u64,
}

#[derive(Clone)]
pub struct AgentStatusStore {
    path: PathBuf,
    rows: Arc<RwLock<HashMap<String, AgentStatusRow>>>,
    tx: broadcast::Sender<AgentStatusRow>,
}

impl AgentStatusStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let (tx, _) = broadcast::channel(128);
        Self {
            path: path.into(),
            rows: Arc::new(RwLock::new(HashMap::new())),
            tx,
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub async fn update_status(
        &self,
        session_id: impl Into<String>,
        verdict: AgentVerdict,
        description: impl Into<String>,
    ) {
        let session_id = session_id.into();
        let row = AgentStatusRow {
            session_id: session_id.clone(),
            verdict,
            description: description.into(),
            updated_at_ms: Self::now_ms(),
        };

        {
            let mut lock = self.rows.write().await;
            lock.insert(session_id, row.clone());
        }

        let _ = self.tx.send(row);
    }

    pub async fn mark_unverifiable(&self, session_id: &str) {
        let mut lock = self.rows.write().await;
        if let Some(row) = lock.get_mut(session_id) {
            row.verdict = AgentVerdict::Unverifiable;
            row.updated_at_ms = Self::now_ms();
            let _ = self.tx.send(row.clone());
        }
    }

    pub async fn mark_exited(&self, session_id: &str) {
        let mut lock = self.rows.write().await;
        if let Some(row) = lock.get_mut(session_id) {
            row.verdict = AgentVerdict::Exited;
            row.updated_at_ms = Self::now_ms();
            let _ = self.tx.send(row.clone());
        }
    }

    pub async fn get_status(&self, session_id: &str) -> Option<AgentStatusRow> {
        let lock = self.rows.read().await;
        lock.get(session_id).cloned()
    }

    pub async fn list_all(&self) -> Vec<AgentStatusRow> {
        let lock = self.rows.read().await;
        lock.values().cloned().collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentStatusRow> {
        self.tx.subscribe()
    }

    pub async fn flush_atomic(&self) -> Result<(), StoreError> {
        let all_rows = self.list_all().await;
        let content = serde_json::to_vec_pretty(&all_rows)?;

        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        tokio::fs::create_dir_all(parent).await?;

        let temp_path = parent.join(format!(".tmp-status-{}.json", std::process::id()));
        tokio::fs::write(&temp_path, content).await?;
        tokio::fs::rename(&temp_path, &self.path).await?;
        Ok(())
    }
}
