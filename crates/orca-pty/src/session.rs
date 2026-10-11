use std::collections::HashMap;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum PtyError {
    #[error("Failed to spawn process: {0}")]
    SpawnFailed(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Failed to resize terminal: {0}")]
    ResizeFailed(String),
    #[error("Operation failed: {0}")]
    OperationFailed(String),
}

#[derive(Debug, Clone)]
pub struct PtySessionConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub cols: u16,
    pub rows: u16,
}

impl PtySessionConfig {
    pub fn new(command: impl Into<String>, args: Vec<String>, cols: u16, rows: u16) -> Self {
        Self {
            command: command.into(),
            args,
            env: HashMap::new(),
            cwd: None,
            cols,
            rows,
        }
    }
}
