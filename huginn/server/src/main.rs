//! Huginn, "thought": notes, checklists, sketches.

mod blobs;
mod links;
mod preview;
mod search;
mod tags;

use std::sync::{Arc, OnceLock};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use raven_server::identity::User;
use raven_server::{AppSpec, RavenApp, SharedState};
use serde::Deserialize;

/// The schema, one file per step; see raven_server::db.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_search.sql"),
    include_str!("../migrations/0003_tags.sql"),
    include_str!("../migrations/0004_links.sql"),
    include_str!("../migrations/0005_attachments.sql"),
];

/// Where attachments are kept: one store, from the environment, for the routes and collection.
fn store(state: &SharedState) -> blobs::Shared {
    static STORE: OnceLock<blobs::Shared> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let store = blobs::Store::from_env(&state.config.db_path);
            tracing::info!(dir = ?store.dir, max_file = store.max_file, quota = store.quota, "attachments");
            Arc::new(store)
        })
        .clone()
}

fn routes(state: SharedState) -> Router<SharedState> {
    // Notes, checklists and ink sync under /v1/sync; this is what the server adds.
    Router::new()
        .route("/v1/search", get(search_notes))
        .route("/v1/tags", get(list_tags))
        .route("/v1/links", get(list_links))
        .route("/v1/attachments", get(blobs::list_all))
        .route("/v1/preview", get(link_preview))
        .route("/v1/preview/image", get(link_preview_image))
        .route("/v1/blobs", get(blobs::usage))
        .route(
            "/v1/blobs/{id}",
            get(blobs::get)
                .post(blobs::post)
                .patch(blobs::patch)
                .delete(blobs::delete),
        )
        .layer(Extension(store(&state)))
}

/// How often unused attachments are looked for.
const COLLECT_EVERY: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Notes stored before search existed, or since its extraction changed, are
/// indexed in the background, so the server answers while it works. Then, and
/// every hour, attachments no note has used for 30 days are removed.
fn start(state: SharedState) {
    let store = store(&state);
    std::thread::spawn(move || {
        match search::index_pending(&state.db) {
            Ok(0) => {}
            Ok(n) => tracing::info!(notes = n, "indexed notes for search"),
            Err(err) => tracing::error!(?err, "indexing notes for search"),
        }
        loop {
            let collected = {
                let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
                blobs::collect(&store, &conn, blobs::now_ms())
            };
            match collected {
                Ok(c) if c == blobs::Collected::default() => {}
                Ok(c) => tracing::info!(
                    files = c.files,
                    abandoned = c.abandoned,
                    "removed unused attachments"
                ),
                Err(err) => tracing::error!(?err, "removing unused attachments"),
            }
            std::thread::sleep(COLLECT_EVERY);
        }
    });
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

/// `GET /v1/search?q=<words>`: the user's notes holding every word, most
/// relevant first, each with its best line and the section it's in.
async fn search_notes(
    User(me): User,
    Query(q): Query<SearchQuery>,
    State(state): State<SharedState>,
) -> Result<Json<Vec<search::Hit>>, StatusCode> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    search::search(&conn, &me.login, &q.q)
        .map(Json)
        .map_err(|err| {
            tracing::error!(?err, "searching notes");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

/// `GET /v1/tags`: the user's tags, each with the notes written with it.
async fn list_tags(
    User(me): User,
    State(state): State<SharedState>,
) -> Result<Json<Vec<tags::Tag>>, StatusCode> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    tags::list(&conn, &me.login).map(Json).map_err(|err| {
        tracing::error!(?err, "listing tags");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

/// `GET /v1/links`: every link between the user's notes, for showing backlinks.
async fn list_links(
    User(me): User,
    State(state): State<SharedState>,
) -> Result<Json<Vec<links::Link>>, StatusCode> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    links::list(&conn, &me.login).map(Json).map_err(|err| {
        tracing::error!(?err, "listing links");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

#[derive(Deserialize)]
struct PreviewQuery {
    url: String,
}

/// How a preview failed, for the client to say.
fn preview_error(err: preview::Error) -> axum::response::Response {
    use axum::response::IntoResponse;
    let status = match err {
        preview::Error::BadUrl | preview::Error::Blocked => StatusCode::BAD_REQUEST,
        preview::Error::NotHtml | preview::Error::NotImage => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        preview::Error::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        preview::Error::Fetch(_) => StatusCode::BAD_GATEWAY,
    };
    (status, err.to_string()).into_response()
}

/// `GET /v1/preview?url=`: a public web page's title, description, site and image.
async fn link_preview(_me: User, Query(q): Query<PreviewQuery>) -> axum::response::Response {
    use axum::response::IntoResponse;
    match preview::fetch_preview(&q.url).await {
        Ok(p) => Json(p).into_response(),
        Err(err) => preview_error(err),
    }
}

/// `GET /v1/preview/image?url=`: a preview's image, fetched the same careful way,
/// for the client to keep as the preview's thumbnail.
async fn link_preview_image(_me: User, Query(q): Query<PreviewQuery>) -> axum::response::Response {
    use axum::http::{header, HeaderValue};
    use axum::response::IntoResponse;
    match preview::fetch_image(&q.url).await {
        Ok(img) => {
            let mut res = img.bytes.into_response();
            let h = res.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&img.content_type) {
                h.insert(header::CONTENT_TYPE, v);
            }
            h.insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            res
        }
        Err(err) => preview_error(err),
    }
}

fn main() -> anyhow::Result<()> {
    raven_server::run(AppSpec {
        app: RavenApp::Huginn,
        // Attachments (note format 6). A format 5 client would drop an
        // attachment it can't read, so it must update before it syncs again.
        min_client: 6,
        migrations: MIGRATIONS,
        routes,
        on_change: Some(search::on_change),
        on_start: Some(start),
    })
}
