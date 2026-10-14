//! Database schema initialization and migrations for Orca profile persistence.

use rusqlite::{Connection, Result};

pub const SCHEMA_MIGRATIONS: &[&str] = &[
    // Migration 1: Key-Value settings store
    r#"
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    "#,
    // Migration 2: Workspace and AI session metadata
    r#"
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    "#,
    // Migration 3: Key-value profile state
    r#"
    CREATE TABLE IF NOT EXISTS profile_state (
        section TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (section, key)
    );
    "#,
];

/// Configures database pragmas for optimal WAL concurrency.
pub fn configure_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
        "#,
    )?;
    Ok(())
}

/// Applies schema migrations sequentially.
pub fn apply_migrations(conn: &mut Connection) -> Result<()> {
    configure_pragmas(conn)?;

    conn.execute(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY NOT NULL
        );
        "#,
        [],
    )?;

    let current_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let tx = conn.transaction()?;
    for (idx, sql) in SCHEMA_MIGRATIONS.iter().enumerate() {
        let migration_version = (idx + 1) as i64;
        if migration_version > current_version {
            tx.execute_batch(sql)?;
            tx.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                [migration_version],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schema_migrations_in_memory() {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        apply_migrations(&mut conn).expect("apply migrations");

        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |row| row.get(0))
            .expect("read version");
        assert_eq!(version, SCHEMA_MIGRATIONS.len() as i64);

        // Verify tables exist
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('theme', 'dark', 12345)",
            [],
        )
        .expect("insert setting");

        let val: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'theme'", [], |row| row.get(0))
            .expect("query setting");
        assert_eq!(val, "dark");
    }
}
