-- Schema 2: the tables are a mirror of the Yjs documents (the documents are
-- the truth; see raven_server::sync). Re-made whole from the document on
-- every change, so they can be dropped and rebuilt at will.
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS lists;
CREATE TABLE tasks (
    owner           TEXT NOT NULL,
    list_id         TEXT NOT NULL,
    id              TEXT NOT NULL,
    title           TEXT NOT NULL,
    done            INTEGER NOT NULL,
    due             TEXT NOT NULL,        -- '' | YYYY-MM-DD | RFC 3339 with offset
    all_day         INTEGER NOT NULL,
    flagged         INTEGER NOT NULL,
    source_app      TEXT,                 -- raven_core::RavenApp name, when made from another app
    source_id       TEXT,
    source_fragment TEXT,
    PRIMARY KEY (owner, list_id, id)
);
CREATE INDEX tasks_source ON tasks (owner, source_app, source_id);
CREATE INDEX tasks_due ON tasks (done, due);
