//! Async SQLite persistence actor for thread-safe WAL operations.

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use rusqlite::Connection;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use super::schema::apply_migrations;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("SQLite database error: {0}")]
    SqliteError(#[from] rusqlite::Error),
    #[error("Database actor channel disconnected")]
    ChannelClosed,
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

enum DbCommand {
    GetSetting {
        key: String,
        reply: oneshot::Sender<Result<Option<String>, PersistenceError>>,
    },
    SetSetting {
        key: String,
        value: String,
        reply: oneshot::Sender<Result<(), PersistenceError>>,
    },
    DeleteSetting {
        key: String,
        reply: oneshot::Sender<Result<bool, PersistenceError>>,
    },
    ListSettings {
        reply: oneshot::Sender<Result<Vec<(String, String)>, PersistenceError>>,
    },
    StoreSession {
        id: String,
        title: String,
        data: String,
        reply: oneshot::Sender<Result<(), PersistenceError>>,
    },
    GetSession {
        id: String,
        reply: oneshot::Sender<Result<Option<String>, PersistenceError>>,
    },
    DeleteSession {
        id: String,
        reply: oneshot::Sender<Result<bool, PersistenceError>>,
    },
}

#[derive(Clone)]
pub struct PersistenceActor {
    tx: mpsc::Sender<DbCommand>,
}

impl PersistenceActor {
    /// Spawns a database actor backed by an in-memory SQLite connection (ideal for testing).
    pub fn open_in_memory() -> Result<Self, PersistenceError> {
        let mut conn = Connection::open_in_memory()?;
        apply_migrations(&mut conn)?;

        let (tx, rx) = mpsc::channel(256);
        thread::Builder::new()
            .name("orca-sqlite-actor".to_string())
            .spawn(move || run_actor_loop(conn, rx))?;

        Ok(Self { tx })
    }

    /// Spawns a database actor backed by a SQLite database file at `path`.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, PersistenceError> {
        let path_buf: PathBuf = path.as_ref().to_path_buf();
        if let Some(parent) = path_buf.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut conn = Connection::open(&path_buf)?;
        apply_migrations(&mut conn)?;

        let (tx, rx) = mpsc::channel(256);
        thread::Builder::new()
            .name("orca-sqlite-actor".to_string())
            .spawn(move || run_actor_loop(conn, rx))?;

        Ok(Self { tx })
    }

    pub async fn get_setting(&self, key: &str) -> Result<Option<String>, PersistenceError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(DbCommand::GetSetting {
                key: key.to_string(),
                reply,
            })
            .await
            .map_err(|_| PersistenceError::ChannelClosed)?;
        rx.await.map_err(|_| PersistenceError::ChannelClosed)?
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> Result<(), PersistenceError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(DbCommand::SetSetting {
                key: key.to_string(),
                value: value.to_string(),
                reply,
            })
            .await
            .map_err(|_| PersistenceError::ChannelClosed)?;
        rx.await.map_err(|_| PersistenceError::ChannelClosed)?
    }

    pub async fn delete_setting(&self, key: &str) -> Result<bool, PersistenceError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(DbCommand::DeleteSetting {
                key: key.to_string(),
                reply,
            })
            .await
            .map_err(|_| PersistenceError::ChannelClosed)?;
        rx.await.map_err(|_| PersistenceError::ChannelClosed)?
    }

    pub async fn list_settings(&self) -> Result<Vec<(String, String)>, PersistenceError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(DbCommand::ListSettings { reply })
            .await
            .map_err(|_| PersistenceError::ChannelClosed)?;
        rx.await.map_err(|_| PersistenceError::ChannelClosed)?
    }

    pub async fn store_session(
        &self,
        id: &str,
        title: &str,
        data: &str,
    ) -> Result<(), PersistenceError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(DbCommand::StoreSession {
                id: id.to_string(),
                title: title.to_string(),
                data: data.to_string(),
                reply,
            })
            .await
            .map_err(|_| PersistenceError::ChannelClosed)?;
        rx.await.map_err(|_| PersistenceError::ChannelClosed)?
    }

    pub async fn get_session(&self, id: &str) -> Result<Option<String>, PersistenceError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(DbCommand::GetSession {
                id: id.to_string(),
                reply,
            })
            .await
            .map_err(|_| PersistenceError::ChannelClosed)?;
        rx.await.map_err(|_| PersistenceError::ChannelClosed)?
    }

    pub async fn delete_session(&self, id: &str) -> Result<bool, PersistenceError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(DbCommand::DeleteSession {
                id: id.to_string(),
                reply,
            })
            .await
            .map_err(|_| PersistenceError::ChannelClosed)?;
        rx.await.map_err(|_| PersistenceError::ChannelClosed)?
    }
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn run_actor_loop(conn: Connection, mut rx: mpsc::Receiver<DbCommand>) {
    while let Some(command) = rx.blocking_recv() {
        match command {
            DbCommand::GetSetting { key, reply } => {
                let res = conn
                    .query_row(
                        "SELECT value FROM settings WHERE key = ?1",
                        [&key],
                        |row| row.get(0),
                    )
                    .map(Some)
                    .or_else(|e| match e {
                        rusqlite::Error::QueryReturnedNoRows => Ok(None),
                        other => Err(PersistenceError::SqliteError(other)),
                    });
                let _ = reply.send(res);
            }
            DbCommand::SetSetting { key, value, reply } => {
                let now = now_epoch_ms();
                let res = conn
                    .execute(
                        r#"
                        INSERT INTO settings (key, value, updated_at)
                        VALUES (?1, ?2, ?3)
                        ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3;
                        "#,
                        rusqlite::params![key, value, now],
                    )
                    .map(|_| ())
                    .map_err(PersistenceError::SqliteError);
                let _ = reply.send(res);
            }
            DbCommand::DeleteSetting { key, reply } => {
                let res = conn
                    .execute("DELETE FROM settings WHERE key = ?1", [&key])
                    .map(|count| count > 0)
                    .map_err(PersistenceError::SqliteError);
                let _ = reply.send(res);
            }
            DbCommand::ListSettings { reply } => {
                let res = (|| -> Result<Vec<(String, String)>, PersistenceError> {
                    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
                    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
                    let mut results = Vec::new();
                    for r in rows {
                        results.push(r?);
                    }
                    Ok(results)
                })();
                let _ = reply.send(res);
            }
            DbCommand::StoreSession {
                id,
                title,
                data,
                reply,
            } => {
                let now = now_epoch_ms();
                let res = conn
                    .execute(
                        r#"
                        INSERT INTO sessions (id, title, data, created_at, updated_at)
                        VALUES (?1, ?2, ?3, ?4, ?4)
                        ON CONFLICT(id) DO UPDATE SET title = ?2, data = ?3, updated_at = ?4;
                        "#,
                        rusqlite::params![id, title, data, now],
                    )
                    .map(|_| ())
                    .map_err(PersistenceError::SqliteError);
                let _ = reply.send(res);
            }
            DbCommand::GetSession { id, reply } => {
                let res = conn
                    .query_row(
                        "SELECT data FROM sessions WHERE id = ?1",
                        [&id],
                        |row| row.get(0),
                    )
                    .map(Some)
                    .or_else(|e| match e {
                        rusqlite::Error::QueryReturnedNoRows => Ok(None),
                        other => Err(PersistenceError::SqliteError(other)),
                    });
                let _ = reply.send(res);
            }
            DbCommand::DeleteSession { id, reply } => {
                let res = conn
                    .execute("DELETE FROM sessions WHERE id = ?1", [&id])
                    .map(|count| count > 0)
                    .map_err(PersistenceError::SqliteError);
                let _ = reply.send(res);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_persistence_actor_settings_roundtrip() {
        let actor = PersistenceActor::open_in_memory().expect("open actor");

        // Key doesn't exist initially
        assert_eq!(actor.get_setting("theme").await.unwrap(), None);

        // Set and get
        actor.set_setting("theme", "dark").await.unwrap();
        assert_eq!(
            actor.get_setting("theme").await.unwrap(),
            Some("dark".to_string())
        );

        // Update
        actor.set_setting("theme", "light").await.unwrap();
        assert_eq!(
            actor.get_setting("theme").await.unwrap(),
            Some("light".to_string())
        );

        // List
        actor.set_setting("font_size", "14").await.unwrap();
        let list = actor.list_settings().await.unwrap();
        assert_eq!(list.len(), 2);

        // Delete
        assert!(actor.delete_setting("theme").await.unwrap());
        assert_eq!(actor.get_setting("theme").await.unwrap(), None);
    }

    #[tokio::test]
    async fn test_persistence_actor_sessions_roundtrip() {
        let actor = PersistenceActor::open_in_memory().expect("open actor");

        let session_data = r#"{"worktree":"/path/to/repo","activeTab":1}"#;
        actor
            .store_session("sess-1", "Main Workspace", session_data)
            .await
            .unwrap();

        let retrieved = actor.get_session("sess-1").await.unwrap();
        assert_eq!(retrieved, Some(session_data.to_string()));

        assert!(actor.delete_session("sess-1").await.unwrap());
        assert_eq!(actor.get_session("sess-1").await.unwrap(), None);
    }
}
