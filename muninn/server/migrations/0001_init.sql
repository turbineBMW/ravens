-- Muninn, schema 1: lists and the tasks in them. Due dates, recurrence,
-- subtasks, tags and notifications come with their features.
CREATE TABLE lists (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,
    name        TEXT NOT NULL,
    position    TEXT NOT NULL,                    -- fractional index; sorts lexically
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
);
CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,
    list_id     TEXT NOT NULL REFERENCES lists (id),
    title       TEXT NOT NULL,
    position    TEXT NOT NULL,
    completed_at TEXT,
    due_at      TEXT,
    -- Where this came from, when it was made from a Huginn note: a
    -- raven_core::LinkTarget as JSON, or NULL.
    source_link TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
);
CREATE INDEX tasks_list_position ON tasks (list_id, completed_at, position);
