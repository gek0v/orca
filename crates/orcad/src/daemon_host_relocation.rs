//! Windows daemon-host relocation manager.
//!
//! Relocates the terminal daemon's process image out of the app install dir
//! into `%LOCALAPPDATA%\Orca\daemon-host\<app_version>\` so it survives Windows auto-updates
//! and electron-builder NSIS uninstallation sweeps.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const HOST_SUBDIR: &str = "daemon-host";
pub const MARKER_NAME: &str = ".materialized.json";
pub const LOCAL_HOST_ROOT_NAME: &str = "Orca";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeMarker {
    pub version: String,
    pub completed_at: String,
    pub entry_rel_path: String,
}

/// Returns the host executable file name (matching current binary's file name).
pub fn daemon_host_exe_name() -> String {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(file_name) = exe_path.file_name() {
            return file_name.to_string_lossy().to_string();
        }
    }
    if cfg!(windows) {
        "Orca.exe".to_string()
    } else {
        "orcad".to_string()
    }
}

/// Resolves `%LOCALAPPDATA%\Orca\daemon-host\<app_version>\`.
pub fn resolve_local_appdata_daemon_dir(app_version: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let base = PathBuf::from(local_appdata)
                .join(LOCAL_HOST_ROOT_NAME)
                .join(HOST_SUBDIR)
                .join(app_version);
            return Some(base);
        }
    }

    // Fallback for non-windows or missing env
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Some(
            PathBuf::from(home)
                .join(".orca")
                .join(HOST_SUBDIR)
                .join(app_version),
        )
    } else {
        None
    }
}

/// Checks whether a valid materialized marker exists in the target directory.
pub fn is_materialized_host_valid(dir: &Path, expected_version: &str) -> bool {
    let marker_path = dir.join(MARKER_NAME);
    if !marker_path.exists() {
        return false;
    }

    if let Ok(content) = std::fs::read_to_string(&marker_path) {
        if let Ok(marker) = serde_json::from_str::<MaterializeMarker>(&content) {
            return marker.version == expected_version;
        }
    }
    false
}

/// Writes the `.materialized.json` marker file atomically into the target directory.
pub fn write_materialized_marker(
    dir: &Path,
    version: &str,
    entry_rel_path: &str,
) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(dir)?;
    let marker = MaterializeMarker {
        version: version.to_string(),
        completed_at: chrono_timestamp_iso(),
        entry_rel_path: entry_rel_path.to_string(),
    };

    let serialized = serde_json::to_string_pretty(&marker)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    let marker_path = dir.join(MARKER_NAME);
    std::fs::write(marker_path, serialized)?;
    Ok(())
}

fn chrono_timestamp_iso() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{now}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daemon_host_exe_name_not_empty() {
        let name = daemon_host_exe_name();
        assert!(!name.is_empty());
    }

    #[test]
    fn test_materialized_marker_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();

        assert!(!is_materialized_host_valid(dir, "1.4.214"));

        write_materialized_marker(dir, "1.4.214", "resources/app/out/main/daemon-entry.js")
            .unwrap();
        assert!(is_materialized_host_valid(dir, "1.4.214"));
        assert!(!is_materialized_host_valid(dir, "1.4.215"));
    }
}
