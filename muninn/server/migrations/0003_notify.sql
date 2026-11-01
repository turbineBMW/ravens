-- Schema 3: notifications. Where to deliver (push subscriptions per browser),
-- what was already delivered (so a reminder fires once per due time), the
-- user's settings mirrored from the index document, and the VAPID key pair.
CREATE TABLE push_subscriptions (
    owner      TEXT NOT NULL,
    endpoint   TEXT NOT NULL PRIMARY KEY,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_owner ON push_subscriptions (owner);
CREATE TABLE notified (
    owner   TEXT NOT NULL,
    list_id TEXT NOT NULL,
    id      TEXT NOT NULL,
    due     TEXT NOT NULL,
    at      TEXT NOT NULL,
    PRIMARY KEY (owner, list_id, id, due)
);
CREATE TABLE settings (
    owner      TEXT NOT NULL PRIMARY KEY,
    tz         TEXT NOT NULL DEFAULT 'UTC',
    all_day_at TEXT NOT NULL DEFAULT '09:00'
);
CREATE TABLE vapid (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    private_key TEXT NOT NULL              -- base64url, the raw P-256 scalar
);
