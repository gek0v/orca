//! AI Vault session and transcript search engine for Orca Relay.
//!
//! Searches across agent chat histories, markdown transcript files, and AI vault sessions.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub session_id: String,
    pub file_path: String,
    pub title: Option<String>,
    pub matched_line: String,
    pub line_number: usize,
}

pub struct SessionSearchEngine;

impl SessionSearchEngine {
    /// Searches for `query` across all `.md` and `.jsonl` files in the given scope directories.
    pub async fn search(
        query: &str,
        scope_dirs: &[PathBuf],
        limit: usize,
    ) -> Vec<SessionSearchResult> {
        if query.trim().is_empty() {
            return Vec::new();
        }

        let query_lower = query.to_lowercase();
        let mut results = Vec::new();

        for dir in scope_dirs {
            if !dir.exists() {
                continue;
            }

            let mut stack = vec![dir.clone()];
            while let Some(current) = stack.pop() {
                let mut rd = match tokio::fs::read_dir(&current).await {
                    Ok(rd) => rd,
                    Err(_) => continue,
                };

                while let Ok(Some(entry)) = rd.next_entry().await {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if path.is_file() {
                        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
                        if ext == "md" || ext == "jsonl" || ext == "json" {
                            if let Ok(content) = tokio::fs::read_to_string(&path).await {
                                let session_id = path
                                    .file_stem()
                                    .map(|s| s.to_string_lossy().to_string())
                                    .unwrap_or_default();

                                let title = content
                                    .lines()
                                    .find(|l| l.starts_with("# "))
                                    .map(|l| l.trim_start_matches("# ").trim().to_string());

                                for (idx, line) in content.lines().enumerate() {
                                    if line.to_lowercase().contains(&query_lower) {
                                        results.push(SessionSearchResult {
                                            session_id: session_id.clone(),
                                            file_path: path.to_string_lossy().to_string(),
                                            title: title.clone(),
                                            matched_line: line.trim().to_string(),
                                            line_number: idx + 1,
                                        });

                                        if results.len() >= limit {
                                            return results;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_session_search() {
        let temp = tempfile::tempdir().unwrap();
        let session_file = temp.path().join("session-42.md");
        std::fs::write(
            &session_file,
            "# Rust Migration Session\nWe are migrating the daemon to Rust.\nEverything compiles cleanly.\n",
        )
        .unwrap();

        let hits = SessionSearchEngine::search("migrating", &[temp.path().to_path_buf()], 10).await;
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, "session-42");
        assert_eq!(hits[0].line_number, 2);
        assert!(hits[0].matched_line.contains("We are migrating"));
    }
}
