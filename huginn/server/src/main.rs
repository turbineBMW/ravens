//! Huginn, "thought": notes, checklists, sketches.

use axum::Router;
use raven_server::{AppSpec, RavenApp, SharedState};

/// The schema, one file per step; see raven_server::db.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_init.sql")];

fn routes(_state: SharedState) -> Router<SharedState> {
    // Notes, checklists and ink arrive here, under /v1/....
    Router::new()
}

fn main() -> anyhow::Result<()> {
    raven_server::run(AppSpec {
        app: RavenApp::Huginn,
        // Format 2 notes: older clients would edit them without understanding the body.
        min_client: 2,
        migrations: MIGRATIONS,
        routes,
        on_change: None,
        on_start: None,
    })
}
