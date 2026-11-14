//! Huginn, "thought": notes, checklists, sketches.

mod search;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use raven_server::identity::User;
use raven_server::{AppSpec, RavenApp, SharedState};
use serde::Deserialize;

/// The schema, one file per step; see raven_server::db.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_search.sql"),
];

fn routes(_state: SharedState) -> Router<SharedState> {
    // Notes, checklists and ink sync under /v1/sync; this is what the server adds.
    Router::new().route("/v1/search", get(search_notes))
}

/// Notes stored before search existed, or since its extraction changed, are
/// indexed in the background, so the server answers while it works.
fn start(state: SharedState) {
    std::thread::spawn(move || match search::index_pending(&state.db) {
        Ok(0) => {}
        Ok(n) => tracing::info!(notes = n, "indexed notes for search"),
        Err(err) => tracing::error!(?err, "indexing notes for search"),
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

fn main() -> anyhow::Result<()> {
    raven_server::run(AppSpec {
        app: RavenApp::Huginn,
        // Drawings (note format 4). Format 3 clients already refuse to edit those
        // notes; this keeps the client and the format moving together.
        min_client: 4,
        migrations: MIGRATIONS,
        routes,
        on_change: Some(search::on_change),
        on_start: Some(start),
    })
}
