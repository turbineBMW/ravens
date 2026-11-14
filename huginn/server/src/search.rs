//! Full-text search over every note, including ones a device has never opened.
//!
//! Each note's text is mirrored into `note_lines`, one row per line with the
//! section (heading id) it sits under, whenever its document changes; notes
//! stored before this existed are indexed on startup. A search finds the notes
//! holding every word somewhere and shows, for each, its best line: one with
//! every word if there is one.

use std::collections::HashSet;
use std::sync::Mutex;

use raven_server::sync::{read, stored, DocKey};
use rusqlite::{params, Connection};
use serde::Serialize;
use yrs::types::text::TextRef;
use yrs::types::xml::{Xml, XmlElementRef, XmlFragment, XmlOut};
use yrs::{GetString, Map, ReadTxn, Transact};

/// Raise this when `lines` changes: startup then indexes every note again.
pub const VERSION: i64 = 1;
/// The checklist a format 1 note has, and a checklist block's default.
const FIRST_LIST: &str = "items";
/// At most this many notes in one search's results.
const MAX_RESULTS: usize = 100;
/// At most this many words in a search; the rest are ignored.
const MAX_TERMS: usize = 8;
/// What `snippet` marks a match with; the client shows these as highlights.
pub const MARK_START: char = '\u{1}';
pub const MARK_END: char = '\u{2}';

/// One line of a note, and the section it's under ('' before any heading).
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Line {
    pub section: String,
    pub text: String,
}

/// A note's searchable text, in order: its set title, then its body as the
/// client shows it (notes.ts `textLines`), with checklist items, checked or
/// not, in their order. Drawings have no text.
pub fn lines<T: ReadTxn>(txn: &T) -> Vec<Line> {
    let mut out = Vec::new();
    let meta = txn.get_map("meta");
    let title = meta
        .as_ref()
        .map(|m| read::string(m.get(txn, "title")))
        .unwrap_or_default();
    push(&mut out, "", &title);
    let has_format = meta.is_some_and(|m| m.contains_key(txn, "format"));
    if !has_format {
        // Format 1: no body, only its checklist.
        items(txn, FIRST_LIST, "", &mut out);
        return out;
    }
    let Some(body) = txn.get_xml_fragment("body") else {
        return out;
    };
    let mut section = String::new();
    for child in body.children(txn) {
        let XmlOut::Element(el) = child else {
            continue;
        };
        match el.tag().as_ref() {
            "heading" => {
                let id = read::string(el.get_attribute(txn, "section"));
                if !id.is_empty() {
                    section = id;
                }
                push(&mut out, &section, &inline(&el, txn));
            }
            "checklist" => {
                let list = read::string(el.get_attribute(txn, "list"));
                let list = if list.is_empty() { FIRST_LIST } else { &list };
                items(txn, list, &section, &mut out);
            }
            "ink" => {}
            _ => {
                for text in block_lines(&el, txn) {
                    push(&mut out, &section, &text);
                }
            }
        }
    }
    out
}

fn push(out: &mut Vec<Line>, section: &str, text: &str) {
    let text = text.trim();
    if !text.is_empty() {
        out.push(Line {
            section: section.to_string(),
            text: text.to_string(),
        });
    }
}

/// A checklist's items in their order (by `pos`, as the client sorts them).
fn items<T: ReadTxn>(txn: &T, list: &str, section: &str, out: &mut Vec<Line>) {
    let mut all: Vec<(String, String, String)> = read::maps(txn, list)
        .into_iter()
        .map(|(id, m)| {
            let pos = read::string(m.get(txn, "pos"));
            (pos, id, read::string(m.get(txn, "text")))
        })
        .collect();
    all.sort();
    for (_, _, text) in all {
        push(out, section, &text);
    }
}

/// A block's lines: a block holding text is one line; one holding blocks
/// (lists, quotes, tables) is theirs.
fn block_lines<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> Vec<String> {
    let holds_text = el.children(txn).any(|c| matches!(c, XmlOut::Text(_)));
    if holds_text {
        return vec![inline(el, txn)];
    }
    el.children(txn)
        .filter_map(|c| match c {
            XmlOut::Element(child) => Some(block_lines(&child, txn)),
            _ => None,
        })
        .flatten()
        .collect()
}

/// The plain text inside an element, without formatting; a line break is a space.
fn inline<T: ReadTxn>(el: &XmlElementRef, txn: &T) -> String {
    el.children(txn)
        .map(|c| match c {
            XmlOut::Text(t) => AsRef::<TextRef>::as_ref(&t).get_string(txn),
            XmlOut::Element(e) if e.tag().as_ref() == "hardBreak" => " ".to_string(),
            XmlOut::Element(e) => inline(&e, txn),
            XmlOut::Fragment(_) => String::new(),
        })
        .collect()
}

/// Mirror a changed note; for raven_server's `OnChange`.
pub fn on_change(key: &DocKey, txn: &yrs::TransactionMut, conn: &Connection) {
    let Some(note) = key.name.strip_prefix("note:") else {
        return;
    };
    if let Err(err) = index_note(&key.owner, note, txn, conn) {
        tracing::error!(?err, owner = key.owner, note, "indexing note for search");
    }
}

/// Replace a note's lines, unless they're unchanged (a drawing, say, or a
/// checkbox), and record it as indexed.
pub fn index_note<T: ReadTxn>(
    owner: &str,
    note: &str,
    txn: &T,
    conn: &Connection,
) -> rusqlite::Result<()> {
    let now = lines(txn);
    let was: Vec<Line> = conn
        .prepare_cached(
            "SELECT section, text FROM note_lines WHERE owner = ?1 AND note_id = ?2 ORDER BY id",
        )?
        .query_map(params![owner, note], |r| {
            Ok(Line {
                section: r.get(0)?,
                text: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let tx = conn.unchecked_transaction()?;
    if was != now {
        tx.execute(
            "DELETE FROM note_lines WHERE owner = ?1 AND note_id = ?2",
            params![owner, note],
        )?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO note_lines (owner, note_id, section, text) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for line in &now {
            insert.execute(params![owner, note, line.section, line.text])?;
        }
    }
    tx.execute(
        "INSERT INTO note_search_state (owner, note_id, version) VALUES (?1, ?2, ?3)
         ON CONFLICT (owner, note_id) DO UPDATE SET version = excluded.version",
        params![owner, note, VERSION],
    )?;
    tx.commit()
}

/// Index every stored note that isn't indexed by this VERSION; how many.
/// Takes the lock for one note at a time, so syncing carries on meanwhile,
/// and a note that changes while waiting is indexed by `on_change` as usual.
pub fn index_pending(db: &Mutex<Connection>) -> anyhow::Result<usize> {
    let pending: Vec<(String, String)> = {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        let mut st = conn.prepare(
            "SELECT owner, name FROM (SELECT owner, name FROM ydocs UNION SELECT owner, name FROM yupdates) d
             WHERE name LIKE 'note:%' AND NOT EXISTS (
                 SELECT 1 FROM note_search_state s
                 WHERE s.owner = d.owner AND s.note_id = substr(d.name, 6) AND s.version = ?1)",
        )?;
        let rows = st
            .query_map([VERSION], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        rows
    };
    for (owner, name) in &pending {
        let conn = db.lock().unwrap_or_else(|e| e.into_inner());
        let key = DocKey {
            owner: owner.clone(),
            name: name.clone(),
        };
        let (doc, _) = stored(&conn, &key)?;
        let txn = doc.transact();
        index_note(owner, &name["note:".len()..], &txn, &conn)?;
    }
    Ok(pending.len())
}

/// One note found: its best line, cut to the words around the match.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Hit {
    pub note: String,
    /// The heading the line is under, to open the note there.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub section: String,
    /// Matches are between MARK_START and MARK_END.
    pub snippet: String,
}

/// The words of a search: any run of characters with a letter or digit in it.
pub fn terms(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .take(MAX_TERMS)
        .map(|w| w.chars().take(64).collect())
        .collect()
}

/// A word as an FTS5 phrase, so punctuation can't be read as query syntax;
/// the last word also matches as a prefix, so results come while typing.
fn phrase(word: &str, prefix: bool) -> String {
    format!(
        "\"{}\"{}",
        word.replace('"', "\"\""),
        if prefix { "*" } else { "" }
    )
}

/// The owner's notes holding every word of `query`, most relevant first.
pub fn search(conn: &Connection, owner: &str, query: &str) -> rusqlite::Result<Vec<Hit>> {
    let words = terms(query);
    let phrases: Vec<String> = words
        .iter()
        .enumerate()
        .map(|(i, w)| phrase(w, i + 1 == words.len()))
        .collect();
    // With several words, the notes with every word somewhere in them, though
    // not on one line. One word needs no such list: any line with it will do.
    let mut notes: Option<HashSet<String>> = None;
    for p in phrases.iter().filter(|_| phrases.len() > 1) {
        let found: HashSet<String> = conn
            .prepare_cached(
                "SELECT DISTINCT l.note_id FROM note_lines_fts JOIN note_lines l ON l.id = note_lines_fts.rowid
                 WHERE note_lines_fts MATCH ?1 AND l.owner = ?2",
            )?
            .query_map(params![p, owner], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        notes = Some(match notes {
            None => found,
            Some(n) => n.intersection(&found).cloned().collect(),
        });
    }
    if phrases.is_empty() || notes.as_ref().is_some_and(HashSet::is_empty) {
        return Ok(Vec::new());
    }
    let qualifies = |note: &String| notes.as_ref().is_none_or(|n| n.contains(note));
    // Each note's best line: one holding every word, else one holding any.
    // Ranked first, and cut around the match only for the lines shown.
    let wanted = notes
        .as_ref()
        .map_or(MAX_RESULTS, |n| n.len().min(MAX_RESULTS));
    let mut best: Vec<(String, i64, String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for expr in [phrases.join(" AND "), phrases.join(" OR ")] {
        let mut st = conn.prepare_cached(
            "SELECT l.id, l.note_id, l.section FROM note_lines_fts JOIN note_lines l ON l.id = note_lines_fts.rowid
             WHERE note_lines_fts MATCH ?1 AND l.owner = ?2 ORDER BY note_lines_fts.rank",
        )?;
        let mut rows = st.query(params![expr, owner])?;
        while seen.len() < wanted {
            let Some(row) = rows.next()? else {
                break;
            };
            let note: String = row.get(1)?;
            if qualifies(&note) && seen.insert(note.clone()) {
                best.push((expr.clone(), row.get(0)?, note, row.get(2)?));
            }
        }
    }
    let mut snippet = conn.prepare_cached(&format!(
        "SELECT snippet(note_lines_fts, 0, char({}), char({}), '…', 16) FROM note_lines_fts
         WHERE note_lines_fts MATCH ?1 AND rowid = ?2",
        MARK_START as u32, MARK_END as u32
    ))?;
    best.into_iter()
        .map(|(expr, id, note, section)| {
            Ok(Hit {
                snippet: snippet.query_row(params![expr, id], |r| r.get(0))?,
                note,
                section,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use raven_server::db;
    use std::collections::HashMap;
    use std::sync::Arc;
    use yrs::types::xml::{XmlElementPrelim, XmlTextPrelim};
    use yrs::{Any, Doc, MapPrelim, Text, TransactionMut};

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(raven_server::sync::SCHEMA).unwrap();
        db::migrate(&conn, crate::MIGRATIONS).unwrap();
        conn
    }

    fn block(
        txn: &mut TransactionMut,
        body: &impl XmlFragment,
        tag: &str,
        text: &str,
    ) -> XmlElementRef {
        let at = body.len(txn);
        let el = body.insert(txn, at, XmlElementPrelim::empty(tag));
        if !text.is_empty() {
            el.insert(txn, 0, XmlTextPrelim::new(text));
        }
        el
    }

    /// A format 3 note: title, text before and under headings, a list, a
    /// table, a checklist, a drawing and bold text.
    fn note() -> Doc {
        let doc = Doc::new();
        let meta = doc.get_or_insert_map("meta");
        let body = doc.get_or_insert_xml_fragment("body");
        let list = doc.get_or_insert_map("items:L2");
        let mut txn = doc.transact_mut();
        meta.insert(&mut txn, "format", 3);
        meta.insert(&mut txn, "title", "Trip");
        block(&mut txn, &body, "paragraph", "Before any heading");
        let h = block(&mut txn, &body, "heading", "Packing");
        h.insert_attribute(&mut txn, "section", "s-pack");
        let p = block(&mut txn, &body, "paragraph", "");
        let t = p.insert(&mut txn, 0, XmlTextPrelim::new(""));
        t.insert(&mut txn, 0, "Bring ");
        let bold = HashMap::from([(Arc::<str>::from("bold"), Any::Bool(true))]);
        t.insert_with_attributes(&mut txn, 6, "boots", bold);
        p.insert(&mut txn, 1, XmlElementPrelim::empty("hardBreak"));
        p.insert(&mut txn, 2, XmlTextPrelim::new("and a café map"));
        let ul = block(&mut txn, &body, "bulletList", "");
        for (i, text) in ["Socks", "Hat"].into_iter().enumerate() {
            let li = ul.insert(&mut txn, i as u32, XmlElementPrelim::empty("listItem"));
            let para = li.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
            para.insert(&mut txn, 0, XmlTextPrelim::new(text));
        }
        let c = block(&mut txn, &body, "checklist", "");
        c.insert_attribute(&mut txn, "list", "items:L2");
        for (id, pos, text) in [("b", "a1", "Eggs"), ("a", "a0", "Milk")] {
            let item = list.insert(&mut txn, id, MapPrelim::default());
            item.insert(&mut txn, "pos", pos);
            item.insert(&mut txn, "text", text);
            item.insert(&mut txn, "checked", id == "b");
        }
        block(&mut txn, &body, "ink", "").insert_attribute(&mut txn, "strokes", "strokes:x");
        let h2 = block(&mut txn, &body, "heading", "Later");
        h2.insert_attribute(&mut txn, "section", "s-later");
        let table = block(&mut txn, &body, "table", "");
        let row = table.insert(&mut txn, 0, XmlElementPrelim::empty("tableRow"));
        for (i, text) in ["Train", "9:15"].into_iter().enumerate() {
            let cell = row.insert(&mut txn, i as u32, XmlElementPrelim::empty("tableCell"));
            let para = cell.insert(&mut txn, 0, XmlElementPrelim::empty("paragraph"));
            para.insert(&mut txn, 0, XmlTextPrelim::new(text));
        }
        drop(txn);
        doc
    }

    fn line(section: &str, text: &str) -> Line {
        Line {
            section: section.into(),
            text: text.into(),
        }
    }

    #[test]
    fn a_note_reads_as_its_lines_under_their_sections() {
        let doc = note();
        assert_eq!(
            lines(&doc.transact()),
            vec![
                line("", "Trip"),
                line("", "Before any heading"),
                line("s-pack", "Packing"),
                line("s-pack", "Bring boots and a café map"),
                line("s-pack", "Socks"),
                line("s-pack", "Hat"),
                line("s-pack", "Milk"),
                line("s-pack", "Eggs"),
                line("s-later", "Later"),
                line("s-later", "Train"),
                line("s-later", "9:15"),
            ]
        );
    }

    #[test]
    fn a_format_1_note_is_its_checklist() {
        let doc = Doc::new();
        let items = doc.get_or_insert_map("items");
        {
            let mut txn = doc.transact_mut();
            let item = items.insert(&mut txn, "i1", MapPrelim::default());
            item.insert(&mut txn, "text", "Coffee");
            item.insert(&mut txn, "pos", "a0");
        }
        assert_eq!(lines(&doc.transact()), vec![line("", "Coffee")]);
    }

    fn index(conn: &Connection, owner: &str, id: &str, doc: &Doc) {
        index_note(owner, id, &doc.transact(), conn).unwrap();
    }

    fn found(conn: &Connection, owner: &str, q: &str) -> Vec<(String, String, String)> {
        search(conn, owner, q)
            .unwrap()
            .into_iter()
            .map(|h| {
                let snippet = h.snippet.replace(MARK_START, "[").replace(MARK_END, "]");
                (h.note, h.section, snippet)
            })
            .collect()
    }

    #[test]
    fn search_finds_words_anywhere_in_a_note_and_shows_the_best_line() {
        let conn = conn();
        index(&conn, "me", "trip", &note());
        let other = Doc::new();
        let meta = other.get_or_insert_map("meta");
        {
            let mut txn = other.transact_mut();
            meta.insert(&mut txn, "format", 2);
            meta.insert(&mut txn, "title", "Milk and eggs on one line");
        }
        index(&conn, "me", "shop", &other);
        index(&conn, "someone else", "theirs", &note());

        let s = |section: &str, snippet: &str| (section.to_string(), snippet.to_string());
        let only = |hits: Vec<(String, String, String)>| -> Vec<(String, (String, String))> {
            hits.into_iter()
                .map(|(n, sec, snip)| (n, (sec, snip)))
                .collect()
        };
        assert_eq!(
            only(found(&conn, "me", "boots")),
            vec![("trip".into(), s("s-pack", "Bring [boots] and a café map"))]
        );
        // Diacritics don't matter, and the last word matches as a prefix while typing.
        assert_eq!(
            only(found(&conn, "me", "cafe ma")),
            vec![("trip".into(), s("s-pack", "Bring boots and a [café] [map]"))]
        );
        // Words on different lines still find the note; a line with both comes first.
        let both = found(&conn, "me", "milk eggs");
        assert_eq!(both[0].0, "shop");
        assert_eq!(both[0].2, "[Milk] and [eggs] on one line");
        assert_eq!(both[1].0, "trip");
        assert_eq!(both.len(), 2, "someone else's notes are never searched");
        assert!(
            found(&conn, "me", "boots zebra").is_empty(),
            "every word must be there"
        );
        assert_eq!(found(&conn, "me", "9:15")[0].1, "s-later");
        assert!(
            found(&conn, "me", "  -- \" ").is_empty(),
            "nothing to search for"
        );
        assert_eq!(
            found(&conn, "me", "\"boots\" AND").len(),
            1,
            "query syntax is just words"
        );
    }

    #[test]
    fn unchanged_text_is_not_rewritten_and_changes_replace_it() {
        let conn = conn();
        let doc = note();
        index(&conn, "me", "trip", &doc);
        let ids = |conn: &Connection| -> Vec<i64> {
            conn.prepare("SELECT id FROM note_lines ORDER BY id")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let before = ids(&conn);
        index(&conn, "me", "trip", &doc);
        assert_eq!(ids(&conn), before);
        {
            let meta = doc.get_or_insert_map("meta");
            let mut txn = doc.transact_mut();
            meta.insert(&mut txn, "title", "Holiday");
        }
        index(&conn, "me", "trip", &doc);
        assert!(
            found(&conn, "me", "trip").is_empty(),
            "the old title is gone"
        );
        assert_eq!(found(&conn, "me", "holiday").len(), 1);
    }

    #[test]
    fn startup_indexes_stored_notes_once() {
        let conn = conn();
        let doc = note();
        let state = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        conn.execute(
            "INSERT INTO ydocs (owner, name, state, updated_at) VALUES ('me', 'note:trip', ?1, '0'), ('me', 'index', x'', '0')",
            [state],
        )
        .unwrap();
        let db = Mutex::new(conn);
        assert_eq!(index_pending(&db).unwrap(), 1, "notes only");
        assert_eq!(index_pending(&db).unwrap(), 0, "and only once");
        let conn = db.into_inner().unwrap();
        assert_eq!(found(&conn, "me", "socks").len(), 1);
        conn.execute("UPDATE note_search_state SET version = 0", [])
            .unwrap();
        let db = Mutex::new(conn);
        assert_eq!(
            index_pending(&db).unwrap(),
            1,
            "a new extraction indexes again"
        );
    }

    /// The phase 3 exit asks for a measured 1,000-note library before setting
    /// budgets: `cargo test -p huginn-server --release -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn a_thousand_notes() {
        let conn = conn();
        let words = [
            "milk",
            "garden",
            "invoice",
            "turbine",
            "blade",
            "torque",
            "holiday",
            "recipe",
            "meeting",
            "budget",
            "train",
            "paint",
            "battery",
            "window",
            "letter",
            "doctor",
            "insurance",
            "camera",
        ];
        let started = std::time::Instant::now();
        for n in 0..1000 {
            let doc = Doc::new();
            let meta = doc.get_or_insert_map("meta");
            let body = doc.get_or_insert_xml_fragment("body");
            {
                let mut txn = doc.transact_mut();
                meta.insert(&mut txn, "format", 3);
                for i in 0..40 {
                    let text: Vec<&str> = (0..12)
                        .map(|k| words[(n * 7 + i * 3 + k * 5) % words.len()])
                        .collect();
                    block(
                        &mut txn,
                        &body,
                        "paragraph",
                        &format!("{} {n}-{i}", text.join(" ")),
                    );
                }
            }
            index(&conn, "me", &format!("n{n}"), &doc);
        }
        println!("indexing 1,000 notes of 40 lines: {:?}", started.elapsed());
        for q in ["turbine", "torque blade", "ins", "doctor 512-7", "zebra"] {
            let started = std::time::Instant::now();
            let n = search(&conn, "me", q).unwrap().len();
            println!("search {q:?}: {n} notes in {:?}", started.elapsed());
        }
        let doc = note();
        let started = std::time::Instant::now();
        index(&conn, "me", "n5", &doc);
        println!("re-indexing one changed note: {:?}", started.elapsed());
    }

    #[test]
    fn terms_are_words() {
        assert_eq!(terms(" milk  -  2% "), vec!["milk", "2%"]);
        assert_eq!(terms("a b c d e f g h i j").len(), MAX_TERMS);
        assert_eq!(phrase("say \"hi\"", true), "\"say \"\"hi\"\"\"*");
    }
}
