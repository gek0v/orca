//! Remote filesystem operations handler for Orca Relay.
//!
//! Provides async non-blocking filesystem methods matching the `fsHandler` contract:
//! read, write, stat, lstat, mkdir, delete, rename, copy, readDir, and readRange.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_ms: u64,
    pub created_ms: u64,
    pub readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelayDirEntry {
    pub name: String,
    pub path: String,
    pub is_file: bool,
    pub is_directory: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum FsError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("Target already exists (no clobber): {0}")]
    AlreadyExists(String),
    #[error("Invalid range: start {start} exceeds end {end}")]
    InvalidRange { start: u64, end: u64 },
}

pub struct RelayFsHandler;

impl RelayFsHandler {
    /// Reads a file into raw bytes or slice.
    pub async fn read_file(path: impl AsRef<Path>) -> Result<Vec<u8>, FsError> {
        tokio::fs::read(path).await.map_err(FsError::Io)
    }

    /// Reads a specific byte range `[start, end)`.
    pub async fn read_range(
        path: impl AsRef<Path>,
        start: u64,
        end: u64,
    ) -> Result<Vec<u8>, FsError> {
        if start > end {
            return Err(FsError::InvalidRange { start, end });
        }
        use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
        let mut file = tokio::fs::File::open(path).await.map_err(FsError::Io)?;
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(FsError::Io)?;

        let length = (end - start) as usize;
        let mut buffer = vec![0u8; length];
        let bytes_read = file.read(&mut buffer).await.map_err(FsError::Io)?;
        buffer.truncate(bytes_read);
        Ok(buffer)
    }

    /// Writes data to a file, replacing existing content.
    pub async fn write_file(path: impl AsRef<Path>, data: &[u8]) -> Result<usize, FsError> {
        if let Some(parent) = path.as_ref().parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(FsError::Io)?;
        }
        tokio::fs::write(path, data).await.map_err(FsError::Io)?;
        Ok(data.len())
    }

    /// Retrieves file metadata (stat, follows symlinks).
    pub async fn stat(path: impl AsRef<Path>) -> Result<FileStat, FsError> {
        let meta = tokio::fs::metadata(path).await.map_err(FsError::Io)?;
        Self::convert_metadata(&meta, false)
    }

    /// Retrieves file metadata without following symlinks (lstat).
    pub async fn lstat(path: impl AsRef<Path>) -> Result<FileStat, FsError> {
        let meta = tokio::fs::symlink_metadata(path)
            .await
            .map_err(FsError::Io)?;
        let is_symlink = meta.file_type().is_symlink();
        Self::convert_metadata(&meta, is_symlink)
    }

    fn convert_metadata(meta: &std::fs::Metadata, is_symlink: bool) -> Result<FileStat, FsError> {
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let created_ms = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        Ok(FileStat {
            is_file: meta.is_file(),
            is_directory: meta.is_dir(),
            is_symlink,
            size: meta.len(),
            modified_ms,
            created_ms,
            readonly: meta.permissions().readonly(),
        })
    }

    /// Creates directory.
    pub async fn mkdir(path: impl AsRef<Path>, recursive: bool) -> Result<(), FsError> {
        if recursive {
            tokio::fs::create_dir_all(path).await.map_err(FsError::Io)
        } else {
            tokio::fs::create_dir(path).await.map_err(FsError::Io)
        }
    }

    /// Deletes a file or directory.
    pub async fn delete(path: impl AsRef<Path>, recursive: bool) -> Result<(), FsError> {
        let p = path.as_ref();
        if p.is_dir() {
            if recursive {
                tokio::fs::remove_dir_all(p).await.map_err(FsError::Io)
            } else {
                tokio::fs::remove_dir(p).await.map_err(FsError::Io)
            }
        } else {
            tokio::fs::remove_file(p).await.map_err(FsError::Io)
        }
    }

    /// Renames or moves a file / directory.
    pub async fn rename(
        from: impl AsRef<Path>,
        to: impl AsRef<Path>,
        no_clobber: bool,
    ) -> Result<(), FsError> {
        if no_clobber && to.as_ref().exists() {
            return Err(FsError::AlreadyExists(
                to.as_ref().to_string_lossy().to_string(),
            ));
        }
        tokio::fs::rename(from, to).await.map_err(FsError::Io)
    }

    /// Copies a file.
    pub async fn copy(from: impl AsRef<Path>, to: impl AsRef<Path>) -> Result<u64, FsError> {
        tokio::fs::copy(from, to).await.map_err(FsError::Io)
    }

    /// Lists directory contents with metadata.
    pub async fn read_dir(
        path: impl AsRef<Path>,
        limit: Option<usize>,
    ) -> Result<Vec<RelayDirEntry>, FsError> {
        let mut read_dir = tokio::fs::read_dir(path).await.map_err(FsError::Io)?;
        let mut entries = Vec::new();

        while let Some(entry) = read_dir.next_entry().await.map_err(FsError::Io)? {
            let meta = entry.metadata().await.ok();
            let is_file = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
            let is_directory = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            entries.push(RelayDirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: entry.path().to_string_lossy().to_string(),
                is_file,
                is_directory,
                size,
                modified_ms,
            });

            if let Some(lim) = limit {
                if entries.len() >= lim {
                    break;
                }
            }
        }

        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_relay_fs_crud_and_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("test.txt");

        // Write
        RelayFsHandler::write_file(&file_path, b"Hello Relay FS!")
            .await
            .unwrap();

        // Stat
        let stat = RelayFsHandler::stat(&file_path).await.unwrap();
        assert!(stat.is_file);
        assert!(!stat.is_directory);
        assert_eq!(stat.size, 15);

        // Read
        let content = RelayFsHandler::read_file(&file_path).await.unwrap();
        assert_eq!(content, b"Hello Relay FS!");

        // Read Range
        let range = RelayFsHandler::read_range(&file_path, 6, 11).await.unwrap();
        assert_eq!(range, b"Relay");

        // Copy
        let copy_path = temp.path().join("copy.txt");
        RelayFsHandler::copy(&file_path, &copy_path).await.unwrap();
        assert!(copy_path.exists());

        // Rename
        let moved_path = temp.path().join("moved.txt");
        RelayFsHandler::rename(&copy_path, &moved_path, false)
            .await
            .unwrap();
        assert!(!copy_path.exists());
        assert!(moved_path.exists());

        // Read Dir
        let entries = RelayFsHandler::read_dir(temp.path(), None).await.unwrap();
        assert_eq!(entries.len(), 2);

        // Delete
        RelayFsHandler::delete(&moved_path, false).await.unwrap();
        assert!(!moved_path.exists());
    }
}
