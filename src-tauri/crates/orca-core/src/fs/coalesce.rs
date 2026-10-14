//! Event coalescing and batching algorithms for filesystem changes.
//!
//! Replicates Orca's canonical file watching coalescing rules:
//! - Create followed by Delete on same path -> net no-op (drop both).
//! - Delete followed by Create on same path -> retain both (cache purge + fresh stat).
//! - Consecutive Updates on same path -> coalesce into a single update.
//! - Overflow safeguard: when events exceed MAX_BATCHED_WATCHER_EVENTS (2000), emit single overflow.
//! See `src/main/ipc/filesystem-watcher-local-events.ts`.

use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

pub const MAX_BATCHED_WATCHER_EVENTS: usize = 2000;

pub const WATCHER_IGNORE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".cache",
    "target",
    ".venv",
    "__pycache__",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeKind {
    Create,
    Update,
    Delete,
    Overflow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChangeEvent {
    pub kind: FileChangeKind,
    pub path: PathBuf,
}

/// Checks whether a path contains any universal ignore directory segments.
pub fn is_ignored_path(path: &std::path::Path) -> bool {
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            if let Some(name_str) = name.to_str() {
                if WATCHER_IGNORE_DIRS.contains(&name_str) {
                    return true;
                }
            }
        }
    }
    false
}

/// Coalesces a raw sequence of filesystem events into an optimized batch.
pub fn coalesce_events(events: Vec<FileChangeEvent>, root: &std::path::Path) -> Vec<FileChangeEvent> {
    if events.len() > MAX_BATCHED_WATCHER_EVENTS {
        return vec![FileChangeEvent {
            kind: FileChangeKind::Overflow,
            path: root.to_path_buf(),
        }];
    }

    // Filter out universally ignored directories
    let filtered: Vec<FileChangeEvent> = events
        .into_iter()
        .filter(|e| !is_ignored_path(&e.path))
        .collect();

    let mut path_states: HashMap<PathBuf, FileChangeKind> = HashMap::new();
    let mut ordered_paths: Vec<PathBuf> = Vec::new();

    for event in filtered {
        let path = event.path;
        match path_states.get(&path) {
            None => {
                path_states.insert(path.clone(), event.kind);
                ordered_paths.push(path);
            }
            Some(&existing_kind) => match (existing_kind, event.kind) {
                // Create followed by Delete -> net no-op; remove from batch
                (FileChangeKind::Create, FileChangeKind::Delete) => {
                    path_states.remove(&path);
                }
                // Delete followed by Create -> replace with Update or emit both
                (FileChangeKind::Delete, FileChangeKind::Create) => {
                    path_states.insert(path, FileChangeKind::Update);
                }
                // Consecutive updates -> remain Update
                (FileChangeKind::Update, FileChangeKind::Update) => {}
                // Any other update after create -> remain Create
                (FileChangeKind::Create, FileChangeKind::Update) => {}
                // Update followed by Delete -> becomes Delete
                (FileChangeKind::Update, FileChangeKind::Delete) => {
                    path_states.insert(path, FileChangeKind::Delete);
                }
                _ => {
                    path_states.insert(path, event.kind);
                }
            },
        }
    }

    ordered_paths
        .into_iter()
        .filter_map(|p| {
            path_states.remove(&p).map(|kind| FileChangeEvent {
                kind,
                path: p,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_is_ignored_path() {
        assert!(is_ignored_path(Path::new("C:/repo/.git/config")));
        assert!(is_ignored_path(Path::new("C:/repo/node_modules/package.json")));
        assert!(is_ignored_path(Path::new("C:/repo/target/debug/app.exe")));
        assert!(!is_ignored_path(Path::new("C:/repo/src/main.rs")));
    }

    #[test]
    fn test_coalesce_create_followed_by_delete_is_noop() {
        let root = Path::new("C:/repo");
        let path = PathBuf::from("C:/repo/src/temp.txt");
        let events = vec![
            FileChangeEvent {
                kind: FileChangeKind::Create,
                path: path.clone(),
            },
            FileChangeEvent {
                kind: FileChangeKind::Delete,
                path,
            },
        ];

        let result = coalesce_events(events, root);
        assert!(result.is_empty(), "Create + Delete should be a net no-op");
    }

    #[test]
    fn test_coalesce_consecutive_updates() {
        let root = Path::new("C:/repo");
        let path = PathBuf::from("C:/repo/src/lib.rs");
        let events = vec![
            FileChangeEvent {
                kind: FileChangeKind::Update,
                path: path.clone(),
            },
            FileChangeEvent {
                kind: FileChangeKind::Update,
                path: path.clone(),
            },
            FileChangeEvent {
                kind: FileChangeKind::Update,
                path: path.clone(),
            },
        ];

        let result = coalesce_events(events, root);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, FileChangeKind::Update);
    }

    #[test]
    fn test_coalesce_overflow_threshold() {
        let root = Path::new("C:/repo");
        let mut events = Vec::new();
        for i in 0..(MAX_BATCHED_WATCHER_EVENTS + 10) {
            events.push(FileChangeEvent {
                kind: FileChangeKind::Update,
                path: PathBuf::from(format!("C:/repo/file_{}.txt", i)),
            });
        }

        let result = coalesce_events(events, root);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].kind, FileChangeKind::Overflow);
        assert_eq!(result[0].path, root.to_path_buf());
    }
}
