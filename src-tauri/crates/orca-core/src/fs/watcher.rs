//! Filesystem watcher engine using notify with debouncing and coalescing.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;

use super::coalesce::{coalesce_events, FileChangeEvent, FileChangeKind};

#[derive(Debug, Error)]
pub enum WatcherError {
    #[error("Notify filesystem watcher error: {0}")]
    NotifyError(#[from] notify::Error),
    #[error("Watcher with ID '{0}' not found")]
    NotFound(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

pub struct ActiveWatch {
    pub root: PathBuf,
    _watcher: RecommendedWatcher,
}

#[derive(Clone, Default)]
pub struct FileWatcherManager {
    watches: Arc<Mutex<HashMap<String, ActiveWatch>>>,
}

impl FileWatcherManager {
    pub fn new() -> Self {
        Self {
            watches: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Starts watching `root_path` recursively, debouncing and coalescing events to `on_batch`.
    pub fn watch<F>(
        &self,
        watch_id: &str,
        root_path: &Path,
        on_batch: F,
    ) -> Result<(), WatcherError>
    where
        F: Fn(Vec<FileChangeEvent>) + Send + Sync + 'static,
    {
        let root = root_path.canonicalize().unwrap_or_else(|_| root_path.to_path_buf());
        let root_for_events = root.clone();
        let (tx, rx) = std::sync::mpsc::channel::<FileChangeEvent>();

        // Background debouncer thread (25ms trailing debounce window)
        let root_for_debouncer = root.clone();
        std::thread::Builder::new()
            .name(format!("orca-fs-debounce-{}", watch_id))
            .spawn(move || {
                let debounce_duration = Duration::from_millis(25);
                let max_wait = Duration::from_millis(100);

                while let Ok(first_event) = rx.recv() {
                    let mut batch = vec![first_event];
                    let start_time = std::time::Instant::now();

                    loop {
                        let remaining_max = max_wait.saturating_sub(start_time.elapsed());
                        if remaining_max.is_zero() {
                            break;
                        }
                        let timeout = debounce_duration.min(remaining_max);

                        match rx.recv_timeout(timeout) {
                            Ok(next_event) => {
                                batch.push(next_event);
                            }
                            Err(_) => break, // Timeout elapsed; trailing debounce window complete
                        }
                    }

                    let coalesced = coalesce_events(batch, &root_for_debouncer);
                    if !coalesced.is_empty() {
                        on_batch(coalesced);
                    }
                }
            })?;

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let change_kind = match event.kind {
                        EventKind::Create(_) => Some(FileChangeKind::Create),
                        EventKind::Modify(_) => Some(FileChangeKind::Update),
                        EventKind::Remove(_) => Some(FileChangeKind::Delete),
                        _ => None,
                    };

                    if let Some(kind) = change_kind {
                        for path in event.paths {
                            let _ = tx.send(FileChangeEvent { kind, path });
                        }
                    }
                }
            },
            Config::default(),
        )?;

        watcher.watch(&root_for_events, RecursiveMode::Recursive)?;

        let mut watches = self.watches.lock().unwrap();
        watches.insert(
            watch_id.to_string(),
            ActiveWatch {
                root: root_for_events,
                _watcher: watcher,
            },
        );

        Ok(())
    }

    /// Stops watching and drops the filesystem watcher.
    pub fn unwatch(&self, watch_id: &str) -> Result<(), WatcherError> {
        let mut watches = self.watches.lock().unwrap();
        if watches.remove(watch_id).is_some() {
            Ok(())
        } else {
            Err(WatcherError::NotFound(watch_id.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;

    #[test]
    fn test_file_watcher_manager_create_and_unwatch() {
        let temp_dir = std::env::temp_dir().join(format!("orca_test_watch_{}", std::process::id()));
        fs::create_dir_all(&temp_dir).unwrap();

        let manager = FileWatcherManager::new();
        let (tx, _rx) = mpsc::channel();

        let watch_res = manager.watch("test-watch-1", &temp_dir, move |batch| {
            let _ = tx.send(batch);
        });
        assert!(watch_res.is_ok(), "Watch failed: {:?}", watch_res.err());

        let unwatch_res = manager.unwatch("test-watch-1");
        assert!(unwatch_res.is_ok(), "Unwatch failed: {:?}", unwatch_res.err());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
