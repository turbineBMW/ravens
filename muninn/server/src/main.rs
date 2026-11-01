//! Muninn, "memory": reminders, tasks, schedules.

mod mirror;
mod notify;

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use raven_server::identity::User;
use raven_server::{AppSpec, RavenApp, SharedState};
use serde::{Deserialize, Serialize};

/// The schema, one file per step; see raven_server::db.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_mirror.sql"),
    include_str!("../migrations/0003_notify.sql"),
];

fn routes(_state: SharedState) -> Router<SharedState> {
    Router::new()
        .route("/v1/links", get(links))
        .merge(notify::routes())
}

fn start(state: SharedState) {
    {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(err) = notify::init(&conn) {
            tracing::error!(?err, "notifications are off: VAPID setup failed");
            return;
        }
    }
    notify::start(state);
}

#[derive(Deserialize)]
struct LinksQuery {
    /// The other app, e.g. `huginn`.
    app: String,
    /// The record there, e.g. a note id.
    id: String,
}

/// A reminder that points at a record in another app.
#[derive(Serialize)]
struct Link {
    list_id: String,
    id: String,
    title: String,
    done: bool,
    due: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fragment: Option<String>,
}

/// `GET /v1/links?app=huginn&id=<note>`: the user's reminders made from that record.
async fn links(
    User(me): User,
    Query(q): Query<LinksQuery>,
    State(state): State<SharedState>,
) -> Json<Vec<Link>> {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let rows = conn
        .prepare(
            "SELECT list_id, id, title, done, due, source_fragment FROM tasks
             WHERE owner = ?1 AND source_app = ?2 AND source_id = ?3 ORDER BY done, due, title",
        )
        .and_then(|mut st| {
            st.query_map(rusqlite::params![me.login, q.app, q.id], |r| {
                Ok(Link {
                    list_id: r.get(0)?,
                    id: r.get(1)?,
                    title: r.get(2)?,
                    done: r.get::<_, i64>(3)? != 0,
                    due: r.get(4)?,
                    fragment: r.get::<_, Option<String>>(5)?.filter(|s| !s.is_empty()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .unwrap_or_default();
    Json(rows)
}

fn main() -> anyhow::Result<()> {
    raven_server::run(AppSpec {
        app: RavenApp::Muninn,
        migrations: MIGRATIONS,
        routes,
        on_change: Some(mirror::on_change),
        on_start: Some(start),
    })
}
