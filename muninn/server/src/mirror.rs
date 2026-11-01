//! Mirror a list document's tasks into the `tasks` table whenever it
//! changes, so the server can answer "which reminders point at this note"
//! and, later, "what is due" without parsing documents on every request.

use raven_server::sync::{read, DocKey};
use rusqlite::{params, Connection};
use yrs::{Map, ReadTxn, TransactionMut};

pub fn on_change(key: &DocKey, txn: &TransactionMut, conn: &Connection) {
    if key.name == "index" {
        // The user's settings ride in the index document.
        if let Some(settings) = txn.get_map("settings") {
            let tz = read::string(settings.get(txn, "tz"));
            let at = read::string(settings.get(txn, "allDayAt"));
            if let Err(err) = crate::notify::mirror_settings(&key.owner, &tz, &at, conn) {
                tracing::error!(?err, owner = key.owner, "mirroring settings");
            }
        }
        return;
    }
    let Some(list_id) = key.name.strip_prefix("list:") else {
        return;
    };
    if let Err(err) = mirror_list(&key.owner, list_id, txn, conn) {
        tracing::error!(?err, owner = key.owner, list = list_id, "mirroring list");
    }
}

fn mirror_list(
    owner: &str,
    list_id: &str,
    txn: &TransactionMut,
    conn: &Connection,
) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM tasks WHERE owner = ?1 AND list_id = ?2",
        params![owner, list_id],
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO tasks (owner, list_id, id, title, done, due, all_day, flagged, source_app, source_id, source_fragment)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?;
    for (id, task) in read::maps(txn, "tasks") {
        let get = |k: &str| task.get(txn, k);
        let source = read::string(get("source"));
        let (app, sid, fragment) = parse_source(&source);
        insert.execute(params![
            owner,
            list_id,
            id,
            read::string(get("title")),
            read::boolean(get("done")) as i64,
            read::string(get("due")),
            read::boolean(get("allDay")) as i64,
            read::boolean(get("flagged")) as i64,
            app,
            sid,
            fragment,
        ])?;
    }
    Ok(())
}

/// The `source` field is a raven_core::LinkTarget as JSON, or empty.
fn parse_source(raw: &str) -> (Option<String>, Option<String>, Option<String>) {
    if raw.is_empty() {
        return (None, None, None);
    }
    match serde_json::from_str::<raven_core::LinkTarget>(raw) {
        Ok(l) => (Some(l.app.name().to_string()), Some(l.id), l.fragment),
        Err(_) => (None, None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use raven_server::db;
    use yrs::{Doc, Transact};

    #[test]
    fn a_list_document_is_mirrored_whole() {
        let conn = Connection::open_in_memory().unwrap();
        db::migrate(&conn, crate::MIGRATIONS).unwrap();
        let doc = Doc::new();
        let tasks = doc.get_or_insert_map("tasks");
        {
            let mut txn = doc.transact_mut();
            let t = tasks.insert(&mut txn, "t1", yrs::MapPrelim::default());
            t.insert(&mut txn, "title", "Replace the water filter");
            t.insert(&mut txn, "done", false);
            t.insert(&mut txn, "due", "2026-11-08");
            t.insert(&mut txn, "allDay", true);
            t.insert(&mut txn, "flagged", true);
            t.insert(
                &mut txn,
                "source",
                r#"{"app":"huginn","id":"n1","fragment":"item-3"}"#,
            );
            let t2 = tasks.insert(&mut txn, "t2", yrs::MapPrelim::default());
            t2.insert(&mut txn, "title", "No source");
            t2.insert(&mut txn, "done", true);
            t2.insert(&mut txn, "source", "");
            let key = DocKey {
                owner: "b@example.com".into(),
                name: "list:L1".into(),
            };
            on_change(&key, &txn, &conn);
        }
        let n: i64 = conn
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        let (title, app, sid, frag, flagged): (String, String, String, String, i64) = conn
            .query_row(
                "SELECT title, source_app, source_id, source_fragment, flagged FROM tasks WHERE id = 't1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            (
                title.as_str(),
                app.as_str(),
                sid.as_str(),
                frag.as_str(),
                flagged
            ),
            ("Replace the water filter", "huginn", "n1", "item-3", 1)
        );
        let app: Option<String> = conn
            .query_row("SELECT source_app FROM tasks WHERE id = 't2'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(app, None);

        // A later change replaces the mirror rather than adding to it.
        {
            let mut txn = doc.transact_mut();
            tasks.remove(&mut txn, "t2");
            let key = DocKey {
                owner: "b@example.com".into(),
                name: "list:L1".into(),
            };
            on_change(&key, &txn, &conn);
        }
        let n: i64 = conn
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
}
