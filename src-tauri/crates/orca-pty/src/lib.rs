use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtySessionDescriptor {
    pub session_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PtyDimensions {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("Failed to spawn PTY process: {0}")]
    SpawnError(String),
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("I/O error: {0}")]
    IoError(String),
}

pub trait TerminalManager: Send + Sync {
    fn spawn(&self, descriptor: PtySessionDescriptor) -> Result<String, PtyError>;
    fn resize(&self, session_id: &str, dimensions: PtyDimensions) -> Result<(), PtyError>;
    fn terminate(&self, session_id: &str) -> Result<(), PtyError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pty_descriptor_creation() {
        let descriptor = PtySessionDescriptor {
            session_id: "term-1".to_string(),
            command: "powershell.exe".to_string(),
            args: vec![],
            cwd: None,
            cols: 80,
            rows: 24,
        };
        assert_eq!(descriptor.session_id, "term-1");
        assert_eq!(descriptor.cols, 80);
        assert_eq!(descriptor.rows, 24);
    }
}
