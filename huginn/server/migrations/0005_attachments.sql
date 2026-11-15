-- Huginn, schema 5: attachments. A file's bytes are on disk (blobs.rs); this is
-- its record. A client names the file (`id`) and says its size and SHA-256
-- before sending it, in chunks; it's stored once `received` reaches `size` and
-- the hash matches. `referenced` is the last time a note was seen referring to
-- it, which is when garbage collection's 30 days start.
CREATE TABLE blobs (
    owner       TEXT NOT NULL,                 -- Identity.login
    id          TEXT NOT NULL,                 -- chosen by the client
    size        INTEGER NOT NULL,              -- bytes, as declared
    sha256      TEXT NOT NULL,                 -- lowercase hex, as declared
    type        TEXT NOT NULL,                 -- media type, as declared
    received    INTEGER NOT NULL DEFAULT 0,    -- bytes stored so far
    created     INTEGER NOT NULL,              -- ms since the epoch
    completed   INTEGER,                       -- ms; NULL while uploading
    referenced  INTEGER NOT NULL,              -- ms; see above
    PRIMARY KEY (owner, id)
);

-- Each note's attachment blocks, mirrored as it changes (with its search
-- lines), for the attachments browser and for garbage collection, which keeps
-- any file a note refers to, Recently Deleted included. `thumb` is the
-- thumbnail's own file, kept with it.
CREATE TABLE note_attachments (
    owner    TEXT NOT NULL,
    note_id  TEXT NOT NULL,
    blob     TEXT NOT NULL,
    section  TEXT NOT NULL DEFAULT '',
    kind     TEXT NOT NULL,
    name     TEXT NOT NULL DEFAULT '',
    type     TEXT NOT NULL DEFAULT '',
    size     INTEGER NOT NULL DEFAULT 0,
    thumb    TEXT NOT NULL DEFAULT '',
    alt      TEXT NOT NULL DEFAULT '',
    url      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (owner, note_id, blob)
);
CREATE INDEX note_attachments_blob ON note_attachments (owner, blob);
CREATE INDEX note_attachments_thumb ON note_attachments (owner, thumb);
