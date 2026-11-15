-- Huginn, schema 3: tags. A note's #tags, as written in its text, mirrored as
-- it changes (tags.rs, with the search lines), so the notes list can show and
-- filter by them without opening every note.
CREATE TABLE note_tags (
    owner    TEXT NOT NULL,                 -- Identity.login
    note_id  TEXT NOT NULL,
    tag      TEXT NOT NULL,                 -- lowercase: #Work and #work are one tag
    name     TEXT NOT NULL,                 -- as first written in the note, without '#'
    PRIMARY KEY (owner, note_id, tag)
);
CREATE INDEX note_tags_tag ON note_tags (owner, tag);
