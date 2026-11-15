//! Tags: words written `#like-this` in a note's text. The rule here must match
//! the client's (huginn/web/src/lib/tags.ts), which highlights and renames them.
//!
//! A tag starts with `#` at the start of a line or after a space or an opening
//! bracket, and runs over letters, digits, `_` and `-`, at most 64 of them,
//! ending before a trailing `-` or `_`. It needs at least one letter, so `#1`
//! and `#2026` are not tags. Case doesn't matter: `#Work` and `#work` are one tag.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::search::Line;

pub const MAX_LEN: usize = 64;

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

fn opens_tag(before: Option<char>) -> bool {
    match before {
        None => true,
        Some(c) => c.is_whitespace() || matches!(c, '(' | '[' | '{'),
    }
}

/// The tags in a piece of text, in order, as written (without `#`).
pub fn tags_in(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut found = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && opens_tag(i.checked_sub(1).map(|b| chars[b])) {
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && word_char(chars[end]) {
                end += 1;
            }
            let mut word: String = chars[start..end].iter().collect();
            while word.ends_with(['-', '_']) {
                word.pop();
            }
            if !word.is_empty()
                && word.chars().count() <= MAX_LEN
                && word.chars().any(char::is_alphabetic)
            {
                found.push(word);
            }
            i = end.max(start);
        } else {
            i += 1;
        }
    }
    found
}

/// A tag as it's matched: lowercase.
pub fn key(name: &str) -> String {
    name.to_lowercase()
}

/// A note's tags, once each, keyed by `key`, with the form first written.
pub fn note_tags(lines: &[Line]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in lines {
        for name in tags_in(&line.text) {
            let k = key(&name);
            if !out.iter().any(|(t, _)| *t == k) {
                out.push((k, name));
            }
        }
    }
    out
}

/// Replace a note's tags with `now`, when they differ.
pub fn store(
    conn: &Connection,
    owner: &str,
    note: &str,
    now: &[(String, String)],
) -> rusqlite::Result<()> {
    let was: Vec<(String, String)> = conn
        .prepare_cached(
            "SELECT tag, name FROM note_tags WHERE owner = ?1 AND note_id = ?2 ORDER BY rowid",
        )?
        .query_map(params![owner, note], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if was == now {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM note_tags WHERE owner = ?1 AND note_id = ?2",
        params![owner, note],
    )?;
    let mut insert = conn.prepare_cached(
        "INSERT INTO note_tags (owner, note_id, tag, name) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (tag, name) in now {
        insert.execute(params![owner, note, tag, name])?;
    }
    Ok(())
}

/// One tag and the notes written with it.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Tag {
    /// Lowercase, as matched.
    pub tag: String,
    /// As written in the most notes; the first alphabetically on a tie.
    pub name: String,
    pub notes: Vec<String>,
}

/// The owner's tags, by name.
pub fn list(conn: &Connection, owner: &str) -> rusqlite::Result<Vec<Tag>> {
    let mut by: BTreeMap<String, (BTreeMap<String, usize>, Vec<String>)> = BTreeMap::new();
    let mut st = conn.prepare_cached(
        "SELECT tag, name, note_id FROM note_tags WHERE owner = ?1 ORDER BY note_id",
    )?;
    let rows = st.query_map([owner], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (tag, name, note) = row?;
        let entry = by.entry(tag).or_default();
        *entry.0.entry(name).or_default() += 1;
        entry.1.push(note);
    }
    let mut tags: Vec<Tag> = by
        .into_iter()
        .map(|(tag, (names, notes))| {
            let most = names.values().copied().max().unwrap_or(0);
            let name = names
                .into_iter()
                .find(|(_, n)| *n == most)
                .map(|(n, _)| n)
                .unwrap_or_default();
            Tag { tag, name, notes }
        })
        .collect();
    tags.sort_by(|a, b| a.tag.cmp(&b.tag));
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_counts_as_a_tag() {
        let cases: &[(&str, &[&str])] = &[
            ("#work", &["work"]),
            (
                "Plan for #Turbines and #blade-inspection.",
                &["Turbines", "blade-inspection"],
            ),
            ("(#q3) [#café] {#x_y}", &["q3", "café", "x_y"]),
            ("#trailing- #under_", &["trailing", "under"]),
            ("issue #1, year #2026, rev #2b", &["2b"]),
            ("mail me@host#tag, url example.com/#anchor, C#", &[]),
            ("##double #", &[]),
            ("#a#b", &["a"]),
        ];
        for (text, want) in cases {
            assert_eq!(tags_in(text), *want, "{text}");
        }
        let long = format!("#{}", "a".repeat(MAX_LEN + 1));
        assert!(tags_in(&long).is_empty(), "too long");
        assert_eq!(tags_in(&format!("#{}", "a".repeat(MAX_LEN))).len(), 1);
    }

    #[test]
    fn a_note_lists_each_tag_once_and_the_library_counts_them() {
        let line = |text: &str| Line {
            section: String::new(),
            text: text.into(),
        };
        let tags = note_tags(&[line("#Work notes"), line("more #work and #home")]);
        assert_eq!(
            tags,
            vec![
                ("work".into(), "Work".into()),
                ("home".into(), "home".into())
            ]
        );

        let conn = Connection::open_in_memory().unwrap();
        raven_server::db::migrate(&conn, crate::MIGRATIONS).unwrap();
        store(&conn, "me", "n1", &tags).unwrap();
        store(&conn, "me", "n2", &note_tags(&[line("#work")])).unwrap();
        store(&conn, "me", "n3", &note_tags(&[line("#work")])).unwrap();
        store(&conn, "someone else", "x", &note_tags(&[line("#secret")])).unwrap();
        assert_eq!(
            list(&conn, "me").unwrap(),
            vec![
                Tag {
                    tag: "home".into(),
                    name: "home".into(),
                    notes: vec!["n1".into()]
                },
                Tag {
                    tag: "work".into(),
                    name: "work".into(),
                    notes: vec!["n1".into(), "n2".into(), "n3".into()]
                },
            ],
            "named as most notes write it; nobody else's"
        );
        store(&conn, "me", "n1", &[]).unwrap();
        assert_eq!(
            list(&conn, "me").unwrap().len(),
            1,
            "a tag no note has is gone"
        );
    }
}
