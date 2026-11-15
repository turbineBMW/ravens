-- Huginn, schema 4: links between notes. Each note's links to other notes (and
-- their sections), mirrored as it changes (links.rs, with the search lines), so
-- a note can list the notes linking to it without opening every note.
CREATE TABLE note_links (
    owner           TEXT NOT NULL,             -- Identity.login
    note_id         TEXT NOT NULL,             -- the note the link is in
    section         TEXT NOT NULL DEFAULT '',  -- the heading the link is under there
    target          TEXT NOT NULL,             -- the note it points at
    target_section  TEXT NOT NULL DEFAULT '',  -- and the heading there, if any
    PRIMARY KEY (owner, note_id, section, target, target_section)
);
CREATE INDEX note_links_target ON note_links (owner, target);
