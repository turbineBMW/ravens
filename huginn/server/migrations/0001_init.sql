-- Huginn, schema 1: the smallest thing that is honestly a note. Everything a
-- note holds (text, checklist items, strokes, attachments) comes with the
-- sync layer and gets its own tables then.
CREATE TABLE notes (
    id          TEXT PRIMARY KEY,                 -- client-minted, URL-safe
    owner       TEXT NOT NULL,                    -- Identity.login
    title       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,                    -- RFC 3339, UTC
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT                              -- soft delete; sync needs the tombstone
);
CREATE INDEX notes_owner_updated ON notes (owner, updated_at DESC);
