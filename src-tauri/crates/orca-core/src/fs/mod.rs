//! Filesystem watcher and event coalescing engine.

pub mod coalesce;
pub mod watcher;

pub use coalesce::{
    coalesce_events, is_ignored_path, FileChangeEvent, FileChangeKind,
    MAX_BATCHED_WATCHER_EVENTS, WATCHER_IGNORE_DIRS,
};
pub use watcher::{FileWatcherManager, WatcherError};
