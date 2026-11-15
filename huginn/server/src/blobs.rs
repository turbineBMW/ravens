//! Attachments' bytes. A file is one on disk, `<dir>/<owner, hex>/<id>`, and a
//! row in `blobs`. The client chooses the id and declares the size, SHA-256 and
//! media type (`POST /v1/blobs/<id>`), then sends the bytes in order, in as
//! many chunks as it likes (`PATCH /v1/blobs/<id>` with `Upload-Offset`), into
//! `<id>.part`. When the last byte arrives the file is hashed, and renamed into
//! place only if it's what was declared, so a file is either whole or absent.
//!
//! Declaring again is how a client resumes: it's told how much has arrived.
//! Declaring something else under the same id is refused, so a retried upload
//! can never make a second file or swap one file for another.
//!
//! The server never reads a file beyond hashing it: thumbnails and the like are
//! made by the client and stored as files of their own (see the roadmap's
//! Phase 4 decisions).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{Path as UrlPath, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures_util::StreamExt;
use raven_server::identity::User;
use raven_server::SharedState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;

/// A file no note has referred to for this long is removed.
pub const GRACE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// An upload that hasn't finished in this long is abandoned.
pub const ABANDONED_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FILE: u64 = 200 * 1024 * 1024;
const DEFAULT_QUOTA: u64 = 20 * 1024 * 1024 * 1024;
/// The hash of no bytes at all.
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Where files go and how many may.
pub struct Store {
    pub dir: PathBuf,
    /// `RAVEN_BLOB_MAX_BYTES`: the largest file.
    pub max_file: u64,
    /// `RAVEN_BLOB_QUOTA_BYTES`: everything one person stores, uploads under way included.
    pub quota: u64,
    /// Uploads receiving bytes right now, so two chunks for one can't interleave.
    busy: Mutex<HashSet<(String, String)>>,
}

impl Store {
    pub fn new(dir: PathBuf, max_file: u64, quota: u64) -> Self {
        Self {
            dir,
            max_file,
            quota,
            busy: Mutex::new(HashSet::new()),
        }
    }

    /// From `RAVEN_BLOB_DIR` (default: `blobs` beside the database) and the limits above.
    pub fn from_env(db_path: &Path) -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let bytes = |name: &str, default: u64| {
            var(name)
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(default)
        };
        let dir = var("RAVEN_BLOB_DIR").map(PathBuf::from).unwrap_or_else(|| {
            db_path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."))
                .join("blobs")
        });
        Self::new(
            dir,
            bytes("RAVEN_BLOB_MAX_BYTES", DEFAULT_MAX_FILE),
            bytes("RAVEN_BLOB_QUOTA_BYTES", DEFAULT_QUOTA),
        )
    }

    fn owner_dir(&self, owner: &str) -> PathBuf {
        // Hex, so a login can't name a path.
        self.dir.join(hex::encode(owner.as_bytes()))
    }
    pub fn path(&self, owner: &str, id: &str) -> PathBuf {
        self.owner_dir(owner).join(id)
    }
    fn part(&self, owner: &str, id: &str) -> PathBuf {
        self.owner_dir(owner).join(format!("{id}.part"))
    }
}

/// Ids are the client's, so they're checked: letters, digits, `-` and `_`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_sha(sha: &str) -> bool {
    sha.len() == 64 && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A declared media type, kept only if it looks like one; otherwise unknown bytes.
pub fn clean_type(t: &str) -> String {
    let t = t.trim().to_ascii_lowercase();
    let token = |s: &str| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    match t.split_once('/') {
        Some((a, b)) if token(a) && token(b) => t,
        _ => "application/octet-stream".into(),
    }
}

#[derive(Debug, Deserialize)]
pub struct Declare {
    pub size: u64,
    pub sha256: String,
    #[serde(rename = "type", default)]
    pub media_type: String,
}

/// Where an upload stands.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Status {
    pub size: u64,
    pub received: u64,
    pub complete: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    BadRequest(&'static str),
    /// A different file already has this id.
    Conflict,
    TooLarge,
    OverQuota,
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        match self {
            Refused::BadRequest(why) => (StatusCode::BAD_REQUEST, why).into_response(),
            Refused::Conflict => {
                (StatusCode::CONFLICT, "a different file has this id").into_response()
            }
            Refused::TooLarge => {
                (StatusCode::PAYLOAD_TOO_LARGE, "the file is too large").into_response()
            }
            Refused::OverQuota => (
                StatusCode::INSUFFICIENT_STORAGE,
                "no room left for attachments",
            )
                .into_response(),
        }
    }
}

fn internal(err: impl std::fmt::Debug) -> Response {
    tracing::error!(?err, "attachments");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

struct Row {
    size: u64,
    sha256: String,
    received: u64,
    completed: bool,
}

fn row(conn: &Connection, owner: &str, id: &str) -> rusqlite::Result<Option<Row>> {
    conn.prepare_cached(
        "SELECT size, sha256, received, completed IS NOT NULL FROM blobs WHERE owner = ?1 AND id = ?2",
    )?
    .query_row(params![owner, id], |r| {
        Ok(Row {
            size: r.get::<_, i64>(0)? as u64,
            sha256: r.get(1)?,
            received: r.get::<_, i64>(2)? as u64,
            completed: r.get(3)?,
        })
    })
    .optional()
}

/// Bytes the owner has stored or is uploading.
pub fn used(conn: &Connection, owner: &str) -> rusqlite::Result<u64> {
    conn.query_row(
        "SELECT COALESCE(SUM(size), 0) FROM blobs WHERE owner = ?1",
        [owner],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n as u64)
}

/// Record a declared upload, or say where an existing one stands. A new one
/// gets an empty `.part` file (or, for no bytes at all, is complete at once).
pub fn declare(
    store: &Store,
    conn: &Connection,
    owner: &str,
    id: &str,
    d: &Declare,
    now: i64,
) -> Result<Status, Refused> {
    if !valid_id(id) {
        return Err(Refused::BadRequest("bad id"));
    }
    if !valid_sha(&d.sha256) {
        return Err(Refused::BadRequest(
            "sha256 must be 64 lowercase hex digits",
        ));
    }
    let existing = row(conn, owner, id).map_err(|_| Refused::BadRequest("database"))?;
    if let Some(r) = existing {
        if r.size != d.size || r.sha256 != d.sha256 {
            return Err(Refused::Conflict);
        }
        if r.completed {
            return Ok(Status {
                size: r.size,
                received: r.size,
                complete: true,
            });
        }
        // What's on disk is what counts: a chunk cut off by a crash isn't recorded.
        let on_disk = std::fs::metadata(store.part(owner, id))
            .map(|m| m.len())
            .unwrap_or(0);
        let received = on_disk.min(r.received);
        if received != on_disk {
            truncate(&store.part(owner, id), received);
        }
        return Ok(Status {
            size: r.size,
            received,
            complete: false,
        });
    }
    if d.size > store.max_file {
        return Err(Refused::TooLarge);
    }
    let used = used(conn, owner).map_err(|_| Refused::BadRequest("database"))?;
    if used.saturating_add(d.size) > store.quota {
        return Err(Refused::OverQuota);
    }
    let empty = d.size == 0;
    if empty && d.sha256 != EMPTY_SHA256 {
        return Err(Refused::BadRequest("that isn't the hash of an empty file"));
    }
    std::fs::create_dir_all(store.owner_dir(owner)).map_err(|_| Refused::BadRequest("storage"))?;
    let target = if empty {
        store.path(owner, id)
    } else {
        store.part(owner, id)
    };
    std::fs::write(&target, b"").map_err(|_| Refused::BadRequest("storage"))?;
    conn.execute(
        "INSERT INTO blobs (owner, id, size, sha256, type, received, created, completed, referenced)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?6)",
        params![
            owner,
            id,
            d.size as i64,
            d.sha256,
            clean_type(&d.media_type),
            now,
            if empty { Some(now) } else { None }
        ],
    )
    .map_err(|_| Refused::BadRequest("database"))?;
    Ok(Status {
        size: d.size,
        received: 0,
        complete: empty,
    })
}

fn truncate(path: &Path, len: u64) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_len(len);
    }
}

/// A file's SHA-256, as lowercase hex.
pub fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

// ---------- HTTP ----------

pub type Shared = Arc<Store>;

/// `POST /v1/blobs/<id>` { size, sha256, type }: declare, or ask where an upload stands.
pub async fn post(
    User(me): User,
    UrlPath(id): UrlPath<String>,
    State(state): State<SharedState>,
    Extension(store): Extension<Shared>,
    Json(d): Json<Declare>,
) -> Response {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    match declare(&store, &conn, &me.login, &id, &d, now_ms()) {
        Ok(status) => Json(status).into_response(),
        Err(refused) => refused.into_response(),
    }
}

/// Releases an upload's place in `busy` however the chunk ends.
struct Receiving<'a> {
    store: &'a Store,
    key: (String, String),
}
impl Drop for Receiving<'_> {
    fn drop(&mut self) {
        self.store
            .busy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

/// `PATCH /v1/blobs/<id>` with `Upload-Offset`: the next bytes. The offset must
/// be what's arrived so far (a 409 says what that is); the last chunk finishes it.
pub async fn patch(
    User(me): User,
    UrlPath(id): UrlPath<String>,
    State(state): State<SharedState>,
    Extension(store): Extension<Shared>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let owner = me.login;
    if !valid_id(&id) {
        return Refused::BadRequest("bad id").into_response();
    }
    let Some(offset) = headers
        .get("upload-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
    else {
        return Refused::BadRequest("Upload-Offset is required").into_response();
    };
    let key = (owner.clone(), id.clone());
    if !store
        .busy
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key.clone())
    {
        return (StatusCode::CONFLICT, "this file is already receiving bytes").into_response();
    }
    let _receiving = Receiving { store: &store, key };

    let current = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        match row(&conn, &owner, &id) {
            Ok(Some(r)) => r,
            Ok(None) => return (StatusCode::NOT_FOUND, "declare the file first").into_response(),
            Err(err) => return internal(err),
        }
    };
    if current.completed {
        return Json(Status {
            size: current.size,
            received: current.size,
            complete: true,
        })
        .into_response();
    }
    let part = store.part(&owner, &id);
    let on_disk = tokio::fs::metadata(&part)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let received = on_disk.min(current.received);
    if offset != received {
        let status = Status {
            size: current.size,
            received,
            complete: false,
        };
        return (StatusCode::CONFLICT, Json(status)).into_response();
    }
    if on_disk != received {
        truncate(&part, received);
    }

    let mut file = match tokio::fs::OpenOptions::new().append(true).open(&part).await {
        Ok(f) => f,
        Err(err) => return internal(err),
    };
    let mut total = received;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            // The connection dropped: keep what was written, the client resumes from it.
            Err(_) => break,
        };
        if total + chunk.len() as u64 > current.size {
            drop(file);
            truncate(&part, received);
            return Refused::TooLarge.into_response();
        }
        if let Err(err) = file.write_all(&chunk).await {
            drop(file);
            truncate(&part, received);
            return internal(err);
        }
        total += chunk.len() as u64;
    }
    if let Err(err) = file.sync_data().await {
        return internal(err);
    }
    drop(file);

    if total < current.size {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(err) = conn.execute(
            "UPDATE blobs SET received = ?3 WHERE owner = ?1 AND id = ?2",
            params![owner, id, total as i64],
        ) {
            return internal(err);
        }
        return Json(Status {
            size: current.size,
            received: total,
            complete: false,
        })
        .into_response();
    }

    // Every byte is here: is it the file that was declared?
    let hash_of = part.clone();
    let hash = match tokio::task::spawn_blocking(move || sha256_of(&hash_of)).await {
        Ok(Ok(h)) => h,
        Ok(Err(err)) => return internal(err),
        Err(err) => return internal(err),
    };
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    if hash != current.sha256 {
        truncate(&part, 0);
        let _ = conn.execute(
            "UPDATE blobs SET received = 0 WHERE owner = ?1 AND id = ?2",
            params![owner, id],
        );
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            "the bytes don't match the declared hash; send them again",
        )
            .into_response();
    }
    if let Err(err) = std::fs::rename(&part, store.path(&owner, &id)) {
        return internal(err);
    }
    if let Err(err) = conn.execute(
        "UPDATE blobs SET received = size, completed = ?3 WHERE owner = ?1 AND id = ?2",
        params![owner, id, now_ms()],
    ) {
        return internal(err);
    }
    Json(Status {
        size: current.size,
        received: current.size,
        complete: true,
    })
    .into_response()
}

/// `DELETE /v1/blobs/<id>`: give up an upload. A stored file stays: notes
/// decide when it goes (see `collect`).
pub async fn delete(
    User(me): User,
    UrlPath(id): UrlPath<String>,
    State(state): State<SharedState>,
    Extension(store): Extension<Shared>,
) -> Response {
    if !valid_id(&id) {
        return Refused::BadRequest("bad id").into_response();
    }
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    match row(&conn, &me.login, &id) {
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Ok(Some(r)) if r.completed => (
            StatusCode::CONFLICT,
            "stored files are removed when no note uses them",
        )
            .into_response(),
        Ok(Some(_)) => {
            let _ = std::fs::remove_file(store.part(&me.login, &id));
            match conn.execute(
                "DELETE FROM blobs WHERE owner = ?1 AND id = ?2",
                params![me.login, id],
            ) {
                Ok(_) => StatusCode::NO_CONTENT.into_response(),
                Err(err) => internal(err),
            }
        }
        Err(err) => internal(err),
    }
}

#[derive(Deserialize)]
pub struct GetParams {
    /// Save it under this name rather than showing it.
    download: Option<String>,
}

/// `GET /v1/blobs/<id>`: the file, with range requests, as its declared type.
/// Whatever it holds runs nowhere: a page or an SVG opened on its own is
/// sandboxed, with no scripts and no access to Huginn.
pub async fn get(
    User(me): User,
    UrlPath(id): UrlPath<String>,
    Query(q): Query<GetParams>,
    State(state): State<SharedState>,
    Extension(store): Extension<Shared>,
    request: Request,
) -> Response {
    if !valid_id(&id) {
        return Refused::BadRequest("bad id").into_response();
    }
    let media_type: Option<String> = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        match conn
            .query_row(
                "SELECT type FROM blobs WHERE owner = ?1 AND id = ?2 AND completed IS NOT NULL",
                params![me.login, id],
                |r| r.get(0),
            )
            .optional()
        {
            Ok(t) => t,
            Err(err) => return internal(err),
        }
    };
    let Some(media_type) = media_type else {
        return (StatusCode::NOT_FOUND, "not uploaded yet").into_response();
    };
    let served = tower_http::services::ServeFile::new(store.path(&me.login, &id))
        .oneshot(request)
        .await;
    let mut res = match served {
        Ok(r) => r.map(Body::new),
        Err(err) => return internal(err),
    };
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&media_type) {
        h.insert(header::CONTENT_TYPE, v);
    }
    // The id names these bytes for good: a different file can't take it.
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"),
    );
    if let Some(name) = q.download {
        if let Ok(v) = HeaderValue::from_str(&content_disposition(&name)) {
            h.insert(header::CONTENT_DISPOSITION, v);
        }
    }
    res
}

/// `attachment` with the name, plainly where it's ASCII and RFC 5987-encoded for the rest.
pub fn content_disposition(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(200).collect();
    let plain: String = name
        .chars()
        .map(|c| {
            if c.is_ascii() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut encoded = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("attachment; filename=\"{plain}\"; filename*=UTF-8''{encoded}")
}

#[derive(Serialize)]
pub struct Usage {
    pub used: u64,
    pub quota: u64,
    pub max_file: u64,
}

/// `GET /v1/blobs`: how much is stored and how much may be.
pub async fn usage(
    User(me): User,
    State(state): State<SharedState>,
    Extension(store): Extension<Shared>,
) -> Response {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    match used(&conn, &me.login) {
        Ok(used) => Json(Usage {
            used,
            quota: store.quota,
            max_file: store.max_file,
        })
        .into_response(),
        Err(err) => internal(err),
    }
}

// ---------- what notes refer to ----------

/// One attachment block in a note, as the server mirrors it.
#[derive(Debug, Serialize, PartialEq, Eq, Clone, Default)]
pub struct Attachment {
    pub note: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub section: String,
    pub blob: String,
    pub kind: String,
    pub name: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub size: u64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub thumb: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub alt: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// Whether the file has arrived on the server.
    #[serde(default)]
    pub stored: bool,
}

/// Replace a note's attachments with `now` (each one's `note` is ignored), when they differ,
/// and mark every file they use as referred to.
pub fn store_refs(
    conn: &Connection,
    owner: &str,
    note: &str,
    now: &[Attachment],
    at: i64,
) -> rusqlite::Result<()> {
    let mut wanted: Vec<&Attachment> = Vec::new();
    for a in now {
        if !a.blob.is_empty() && !wanted.iter().any(|w| w.blob == a.blob) {
            wanted.push(a);
        }
    }
    let was: Vec<Attachment> = conn
        .prepare_cached(
            "SELECT blob, section, kind, name, type, size, thumb, alt, url FROM note_attachments
             WHERE owner = ?1 AND note_id = ?2 ORDER BY rowid",
        )?
        .query_map(params![owner, note], |r| {
            Ok(Attachment {
                blob: r.get(0)?,
                section: r.get(1)?,
                kind: r.get(2)?,
                name: r.get(3)?,
                media_type: r.get(4)?,
                size: r.get::<_, i64>(5)? as u64,
                thumb: r.get(6)?,
                alt: r.get(7)?,
                url: r.get(8)?,
                ..Default::default()
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let same = was.len() == wanted.len()
        && was.iter().zip(&wanted).all(|(a, b)| {
            Attachment {
                note: String::new(),
                stored: false,
                ..(*b).clone()
            } == *a
        });
    if !same {
        conn.execute(
            "DELETE FROM note_attachments WHERE owner = ?1 AND note_id = ?2",
            params![owner, note],
        )?;
        let mut insert = conn.prepare_cached(
            "INSERT INTO note_attachments (owner, note_id, blob, section, kind, name, type, size, thumb, alt, url)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for a in &wanted {
            insert.execute(params![
                owner,
                note,
                a.blob,
                a.section,
                a.kind,
                a.name,
                a.media_type,
                a.size as i64,
                a.thumb,
                a.alt,
                a.url
            ])?;
        }
    }
    let mut touch = conn.prepare_cached(
        "UPDATE blobs SET referenced = ?3 WHERE owner = ?1 AND id = ?2 AND referenced < ?3",
    )?;
    // What the note used until now was referred to until now too, so its 30 days start here.
    for a in wanted.iter().copied().chain(was.iter()) {
        touch.execute(params![owner, a.blob, at])?;
        if !a.thumb.is_empty() {
            touch.execute(params![owner, a.thumb, at])?;
        }
    }
    Ok(())
}

/// Every attachment in the owner's notes, by note, with whether each has arrived.
pub fn list(conn: &Connection, owner: &str) -> rusqlite::Result<Vec<Attachment>> {
    conn.prepare_cached(
        "SELECT a.note_id, a.section, a.blob, a.kind, a.name, a.type, a.size, a.thumb, a.alt, a.url,
                b.completed IS NOT NULL
         FROM note_attachments a LEFT JOIN blobs b ON b.owner = a.owner AND b.id = a.blob
         WHERE a.owner = ?1 ORDER BY a.note_id, a.rowid",
    )?
    .query_map([owner], |r| {
        Ok(Attachment {
            note: r.get(0)?,
            section: r.get(1)?,
            blob: r.get(2)?,
            kind: r.get(3)?,
            name: r.get(4)?,
            media_type: r.get(5)?,
            size: r.get::<_, i64>(6)? as u64,
            thumb: r.get(7)?,
            alt: r.get(8)?,
            url: r.get(9)?,
            stored: r.get::<_, Option<bool>>(10)?.unwrap_or(false),
        })
    })?
    .collect()
}

/// `GET /v1/attachments`: every attachment in the user's notes.
pub async fn list_all(User(me): User, State(state): State<SharedState>) -> Response {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    match list(&conn, &me.login) {
        Ok(all) => Json(all).into_response(),
        Err(err) => internal(err),
    }
}

// ---------- garbage collection ----------

/// What a collection removed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Collected {
    pub files: usize,
    pub abandoned: usize,
}

/// Remove files no note has referred to for GRACE_MS, Recently Deleted
/// included, and uploads that haven't finished in ABANDONED_MS. Files that
/// notes refer to now are marked as referred to first, so the grace period
/// runs from when the last note stopped using a file.
pub fn collect(store: &Store, conn: &Connection, now: i64) -> rusqlite::Result<Collected> {
    conn.execute(
        "UPDATE blobs SET referenced = ?1 WHERE referenced < ?1 AND EXISTS (
             SELECT 1 FROM note_attachments a
             WHERE a.owner = blobs.owner AND (a.blob = blobs.id OR a.thumb = blobs.id))",
        [now],
    )?;
    let doomed: Vec<(String, String, bool)> = conn
        .prepare(
            "SELECT owner, id, completed IS NOT NULL FROM blobs
             WHERE (completed IS NOT NULL AND referenced < ?1)
                OR (completed IS NULL AND created < ?2)",
        )?
        .query_map(params![now - GRACE_MS, now - ABANDONED_MS], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Collected::default();
    for (owner, id, completed) in doomed {
        let path = if completed {
            store.path(&owner, &id)
        } else {
            store.part(&owner, &id)
        };
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            // Kept, to try again next time.
            Err(err) => {
                tracing::warn!(?err, ?path, "removing an unused attachment");
                continue;
            }
        }
        conn.execute(
            "DELETE FROM blobs WHERE owner = ?1 AND id = ?2",
            params![owner, id],
        )?;
        if completed {
            out.files += 1;
        } else {
            out.abandoned += 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Store, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().join("blobs"), 1000, 2500);
        let conn = Connection::open_in_memory().unwrap();
        for m in crate::MIGRATIONS {
            conn.execute_batch(m).unwrap();
        }
        (dir, store, conn)
    }

    fn sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn decl(bytes: &[u8]) -> Declare {
        Declare {
            size: bytes.len() as u64,
            sha256: sha(bytes),
            media_type: "image/png".into(),
        }
    }

    #[test]
    fn ids_and_types_are_checked() {
        assert!(valid_id("abc_DEF-123"));
        for bad in ["", "../x", "a/b", "a.b", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert_eq!(clean_type("Image/PNG"), "image/png");
        assert_eq!(
            clean_type("text/html; charset=utf-8"),
            "application/octet-stream"
        );
        assert_eq!(clean_type("nonsense"), "application/octet-stream");
    }

    #[test]
    fn declaring_twice_is_resuming_and_a_different_file_is_refused() {
        let (_d, store, conn) = setup();
        let s = declare(&store, &conn, "me", "f1", &decl(b"hello"), 1).unwrap();
        assert_eq!(
            s,
            Status {
                size: 5,
                received: 0,
                complete: false
            }
        );
        // Some bytes arrive, as a chunk would leave them.
        std::fs::write(store.part("me", "f1"), b"hel").unwrap();
        conn.execute("UPDATE blobs SET received = 3", []).unwrap();
        let again = declare(&store, &conn, "me", "f1", &decl(b"hello"), 2).unwrap();
        assert_eq!(again.received, 3, "resumes where it stopped");
        assert_eq!(
            declare(&store, &conn, "me", "f1", &decl(b"other"), 3),
            Err(Refused::Conflict)
        );
        // A cut-off write recorded as more than is on disk counts what's on disk.
        conn.execute("UPDATE blobs SET received = 5", []).unwrap();
        assert_eq!(
            declare(&store, &conn, "me", "f1", &decl(b"hello"), 4)
                .unwrap()
                .received,
            3
        );
        // Another person's file of the same id is theirs.
        assert_eq!(
            declare(&store, &conn, "you", "f1", &decl(b"other"), 5)
                .unwrap()
                .received,
            0
        );
        assert_ne!(
            store.path("me", "f1").parent(),
            store.path("you", "f1").parent()
        );
    }

    #[test]
    fn limits_are_kept() {
        let (_d, store, conn) = setup();
        let big = Declare {
            size: 1001,
            sha256: sha(b"x"),
            media_type: String::new(),
        };
        assert_eq!(
            declare(&store, &conn, "me", "big", &big, 1),
            Err(Refused::TooLarge)
        );
        let nine = Declare {
            size: 900,
            sha256: sha(b"x"),
            media_type: String::new(),
        };
        declare(&store, &conn, "me", "a", &nine, 1).unwrap();
        declare(&store, &conn, "me", "b", &nine, 1).unwrap();
        assert_eq!(
            declare(&store, &conn, "me", "c", &nine, 1),
            Err(Refused::OverQuota)
        );
        assert_eq!(used(&conn, "me").unwrap(), 1800);
        assert!(
            declare(&store, &conn, "you", "c", &nine, 1).is_ok(),
            "a quota is per person"
        );
        let bad = Declare {
            size: 1,
            sha256: "XYZ".into(),
            media_type: String::new(),
        };
        assert!(matches!(
            declare(&store, &conn, "me", "d", &bad, 1),
            Err(Refused::BadRequest(_))
        ));
    }

    #[test]
    fn an_empty_file_is_complete_at_once() {
        let (_d, store, conn) = setup();
        let s = declare(&store, &conn, "me", "e", &decl(b""), 1).unwrap();
        assert!(s.complete);
        assert!(store.path("me", "e").exists());
    }

    fn attachment(blob: &str, thumb: &str) -> Attachment {
        Attachment {
            blob: blob.into(),
            thumb: thumb.into(),
            kind: "image".into(),
            name: "x.png".into(),
            ..Default::default()
        }
    }

    fn complete(store: &Store, conn: &Connection, id: &str, at: i64) {
        declare(store, conn, "me", id, &decl(id.as_bytes()), at).unwrap();
        std::fs::write(store.path("me", id), id.as_bytes()).unwrap();
        conn.execute(
            "UPDATE blobs SET completed = ?2, received = size WHERE id = ?1",
            params![id, at],
        )
        .unwrap();
    }

    #[test]
    fn collection_keeps_what_notes_use_and_their_thumbnails() {
        let (_d, store, conn) = setup();
        let day = 24 * 60 * 60 * 1000;
        for id in ["used", "thumb", "dropped", "never"] {
            complete(&store, &conn, id, 0);
        }
        store_refs(
            &conn,
            "me",
            "n1",
            &[attachment("used", "thumb"), attachment("dropped", "")],
            0,
        )
        .unwrap();
        // Ten days on, the note stops using "dropped".
        store_refs(&conn, "me", "n1", &[attachment("used", "thumb")], 10 * day).unwrap();
        assert_eq!(
            collect(&store, &conn, 20 * day).unwrap(),
            Collected::default()
        );
        // "never" was uploaded at 0 and no note took it: gone after 30 days.
        assert_eq!(collect(&store, &conn, 31 * day).unwrap().files, 1);
        assert!(!store.path("me", "never").exists());
        // "dropped" goes 30 days after the note stopped using it, not after it was made.
        assert_eq!(collect(&store, &conn, 39 * day).unwrap().files, 0);
        assert_eq!(collect(&store, &conn, 41 * day).unwrap().files, 1);
        // What the note still uses stays however long it's been.
        assert_eq!(
            collect(&store, &conn, 400 * day).unwrap(),
            Collected::default()
        );
        assert!(store.path("me", "used").exists() && store.path("me", "thumb").exists());
        let listed = list(&conn, "me").unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].stored);
    }

    #[test]
    fn abandoned_uploads_are_removed() {
        let (_d, store, conn) = setup();
        let day = 24 * 60 * 60 * 1000;
        declare(&store, &conn, "me", "half", &decl(b"hello"), 0).unwrap();
        assert_eq!(
            collect(&store, &conn, 6 * day).unwrap(),
            Collected::default()
        );
        assert_eq!(collect(&store, &conn, 8 * day).unwrap().abandoned, 1);
        assert!(!store.part("me", "half").exists());
    }

    #[test]
    fn a_download_names_the_file_safely() {
        assert_eq!(
            content_disposition("report.pdf"),
            "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf"
        );
        let odd = content_disposition("Café \"x\"\r\n.pdf");
        assert!(!odd.contains('\r') && !odd.contains('\n'));
        assert!(odd.contains("filename*=UTF-8''Caf%C3%A9%20%22x%22.pdf"));
    }
}
