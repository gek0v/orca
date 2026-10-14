//! Filesystem watch registry for Orca Relay.
//!
//! Manages active directory watch subscriptions per client, event broadcast,
//! deduplication, and cleanup on client disconnection.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    pub watch_id: u64,
    pub path: String,
    pub kind: FileChangeKind,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone)]
pub struct WatchSubscription {
    pub watch_id: u64,
    pub client_id: String,
    pub path: PathBuf,
    pub recursive: bool,
}

pub struct WatchRegistry {
    counter: AtomicU64,
    watches: Arc<RwLock<HashMap<u64, WatchSubscription>>>,
    client_watches: Arc<RwLock<HashMap<String, Vec<u64>>>>,
    event_tx: broadcast::Sender<FileChangeEvent>,
}

impl Default for WatchRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchRegistry {
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(1024);
        Self {
            counter: AtomicU64::new(1),
            watches: Arc::new(RwLock::new(HashMap::new())),
            client_watches: Arc::new(RwLock::new(HashMap::new())),
            event_tx,
        }
    }

    /// Registers a new watch on `path` for `client_id`.
    pub async fn watch(&self, client_id: &str, path: impl AsRef<Path>, recursive: bool) -> u64 {
        let watch_id = self.counter.fetch_add(1, Ordering::SeqCst);
        let sub = WatchSubscription {
            watch_id,
            client_id: client_id.to_string(),
            path: path.as_ref().to_path_buf(),
            recursive,
        };

        {
            let mut w = self.watches.write().await;
            w.insert(watch_id, sub);
        }

        {
            let mut cw = self.client_watches.write().await;
            cw.entry(client_id.to_string()).or_default().push(watch_id);
        }

        watch_id
    }

    /// Unregisters an active watch.
    pub async fn unwatch(&self, client_id: &str, watch_id: u64) -> bool {
        let removed = {
            let mut w = self.watches.write().await;
            if let Some(sub) = w.get(&watch_id) {
                if sub.client_id == client_id {
                    w.remove(&watch_id);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };

        if removed {
            let mut cw = self.client_watches.write().await;
            if let Some(list) = cw.get_mut(client_id) {
                list.retain(|id| *id != watch_id);
            }
        }

        removed
    }

    /// Cleans up all watches belonging to a disconnected client.
    pub async fn remove_client_watches(&self, client_id: &str) -> usize {
        let ids = {
            let mut cw = self.client_watches.write().await;
            cw.remove(client_id).unwrap_or_default()
        };

        let count = ids.len();
        if !ids.is_empty() {
            let mut w = self.watches.write().await;
            for id in ids {
                w.remove(&id);
            }
        }
        count
    }

    /// Publishes a file change event to subscribers.
    pub fn emit_event(&self, event: FileChangeEvent) {
        let _ = self.event_tx.send(event);
    }

    /// Subscribes to the broadcast stream of file change events.
    pub fn subscribe(&self) -> broadcast::Receiver<FileChangeEvent> {
        self.event_tx.subscribe()
    }

    /// Returns count of total active watches across all clients.
    pub async fn active_watch_count(&self) -> usize {
        self.watches.read().await.len()
    }

    /// Returns active watch IDs for a specific client.
    pub async fn list_watches(&self, client_id: &str) -> Vec<u64> {
        let cw = self.client_watches.read().await;
        cw.get(client_id).cloned().unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_watch_registry_lifecycle_and_cleanup() {
        let registry = WatchRegistry::new();
        let mut rx = registry.subscribe();

        let id1 = registry.watch("client-1", "/tmp/repo", true).await;
        let id2 = registry.watch("client-1", "/tmp/repo/src", false).await;
        let _id3 = registry.watch("client-2", "/tmp/other", true).await;

        assert_eq!(registry.active_watch_count().await, 3);

        // Emit event
        registry.emit_event(FileChangeEvent {
            watch_id: id1,
            path: "/tmp/repo/file.txt".to_string(),
            kind: FileChangeKind::Created,
            timestamp_ms: 1000,
        });

        let ev = rx.recv().await.unwrap();
        assert_eq!(ev.watch_id, id1);
        assert_eq!(ev.kind, FileChangeKind::Created);

        // Unwatch single
        assert!(registry.unwatch("client-1", id2).await);
        assert_eq!(registry.active_watch_count().await, 2);

        // Client disconnect teardown
        let cleaned = registry.remove_client_watches("client-1").await;
        assert_eq!(cleaned, 1);
        assert_eq!(registry.active_watch_count().await, 1);
    }
}
