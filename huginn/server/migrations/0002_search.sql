-- Huginn, schema 2: full-text search. Each note's text, one row per line, with
-- the section (heading id) it sits under, mirrored from the note document as
-- it changes (search.rs). The FTS table indexes `note_lines` without a copy.
CREATE TABLE note_lines (
    id       INTEGER PRIMARY KEY,
    owner    TEXT NOT NULL,                 -- Identity.login
    note_id  TEXT NOT NULL,
    section  TEXT NOT NULL DEFAULT '',      -- '' before the first heading
    text     TEXT NOT NULL
);
CREATE INDEX note_lines_note ON note_lines (owner, note_id);

CREATE VIRTUAL TABLE note_lines_fts USING fts5(
    text,
    content = 'note_lines',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);
CREATE TRIGGER note_lines_insert AFTER INSERT ON note_lines BEGIN
    INSERT INTO note_lines_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER note_lines_delete AFTER DELETE ON note_lines BEGIN
    INSERT INTO note_lines_fts (note_lines_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- Which notes are indexed, and by which version of the extraction: startup
-- indexes the rest, and a new version indexes everything again.
CREATE TABLE note_search_state (
    owner    TEXT NOT NULL,
    note_id  TEXT NOT NULL,
    version  INTEGER NOT NULL,
    PRIMARY KEY (owner, note_id)
);
