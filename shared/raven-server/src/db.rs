use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::Connection;

/// Open (creating if needed) the app's SQLite database and bring its schema
/// up to date. Migration `i` runs when `PRAGMA user_version` is `< i + 1`,
/// each inside its own transaction, so a failed migration leaves the version
/// where it was.
pub fn open(path: &Path, migrations: &[&str]) -> Result<Connection> {
    let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    migrate(&conn, migrations)?;
    Ok(conn)
}

pub fn migrate(conn: &Connection, migrations: &[&str]) -> Result<()> {
    let current = schema_version(conn)?;
    for (i, sql) in migrations.iter().enumerate() {
        let target = i as u32 + 1;
        if current >= target {
            continue;
        }
        tracing::info!(
            from = current.max(target - 1),
            to = target,
            "migrating schema"
        );
        conn.execute_batch(&format!(
            "BEGIN; {sql}; PRAGMA user_version = {target}; COMMIT;"
        ))
        .with_context(|| format!("migration {target} failed"))?;
    }
    Ok(())
}

pub fn schema_version(conn: &Connection) -> Result<u32> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_run_once_and_in_order() {
        let conn = Connection::open_in_memory().unwrap();
        let m = ["CREATE TABLE a (id INTEGER)", "CREATE TABLE b (id INTEGER)"];
        migrate(&conn, &m).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 2);
        // A second run with one more migration applies only the new one.
        let m = [
            "CREATE TABLE a (id INTEGER)",
            "CREATE TABLE b (id INTEGER)",
            "ALTER TABLE b ADD COLUMN x TEXT",
        ];
        migrate(&conn, &m).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 3);
    }

    #[test]
    fn a_failed_migration_keeps_the_old_version() {
        let conn = Connection::open_in_memory().unwrap();
        let m = ["CREATE TABLE a (id INTEGER)", "THIS IS NOT SQL"];
        assert!(migrate(&conn, &m).is_err());
        assert_eq!(schema_version(&conn).unwrap(), 1);
    }
}
