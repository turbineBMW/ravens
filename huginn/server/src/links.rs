//! Links between notes: each note's `noteLink`s, mirrored into `note_links`
//! with its search lines, so a note can show the notes linking to it, the
//! ones this device has never opened included.

use rusqlite::{params, Connection};
use serde::Serialize;

/// One link: where it is (its note and the heading it's under) and what it points at.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
pub struct Link {
    pub note: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub section: String,
    pub target: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub target_section: String,
}

/// Replace a note's links with `now` (the note's own `note` field is ignored), when they differ.
pub fn store(conn: &Connection, owner: &str, note: &str, now: &[Link]) -> rusqlite::Result<()> {
    let was: Vec<(String, String, String)> = conn
        .prepare_cached(
            "SELECT section, target, target_section FROM note_links
             WHERE owner = ?1 AND note_id = ?2 ORDER BY rowid",
        )?
        .query_map(params![owner, note], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut wanted: Vec<(String, String, String)> = Vec::new();
    for l in now {
        let row = (
            l.section.clone(),
            l.target.clone(),
            l.target_section.clone(),
        );
        if !wanted.contains(&row) {
            wanted.push(row);
        }
    }
    if was == wanted {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM note_links WHERE owner = ?1 AND note_id = ?2",
        params![owner, note],
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO note_links (owner, note_id, section, target, target_section)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for (section, target, target_section) in &wanted {
        insert.execute(params![owner, note, section, target, target_section])?;
    }
    Ok(())
}

/// Every link in the owner's notes, by the note they're in.
pub fn list(conn: &Connection, owner: &str) -> rusqlite::Result<Vec<Link>> {
    conn.prepare_cached(
        "SELECT note_id, section, target, target_section FROM note_links
         WHERE owner = ?1 ORDER BY note_id, rowid",
    )?
    .query_map([owner], |r| {
        Ok(Link {
            note: r.get(0)?,
            section: r.get(1)?,
            target: r.get(2)?,
            target_section: r.get(3)?,
        })
    })?
    .collect()
}
