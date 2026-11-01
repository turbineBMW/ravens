//! The router both apps share: `/v1/health` and `/v1/me`, the app's own
//! routes merged in, and the web client with an SPA fallback to its
//! `index.html`. All of it is answered both at the root and under the app's
//! base path: `tailscale serve --set-path /huginn` strips the mount path
//! before proxying (so `/huginn/_app/x.js` arrives as `/_app/x.js`), while
//! the Vite dev proxy and a plain `cargo run` keep it.

use std::path::Path;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path as UrlPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use raven_core::HealthResponse;
use tower_http::services::{ServeDir, ServeFile};

use crate::identity::User;
use crate::sync::{self, DocKey};
use crate::{db, SharedState};

pub fn router(state: SharedState, app_routes: Router<SharedState>) -> Router {
    let v1 = || {
        Router::new()
            .route("/v1/health", get(health))
            .route("/v1/me", get(me))
            .route("/v1/sync/{name}", get(sync_ws))
            .merge(app_routes.clone())
    };
    let base = state.app.base();
    let under_base = match &state.config.web_dir {
        Some(dir) => v1().fallback_service(web_service(dir)),
        None => v1(),
    };
    let mut app = Router::new().merge(v1()).nest(base, under_base);
    if let Some(dir) = &state.config.web_dir {
        // `nest` answers `/huginn` and `/huginn/<anything>` but not the bare
        // `/huginn/` a link lands on: that is the shell too. And everything
        // else at the root is the shell as it arrives through tailscale serve.
        app = app
            .route_service(&format!("{base}/"), ServeFile::new(dir.join("index.html")))
            .fallback_service(web_service(dir));
    }
    app.layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(state)
}

pub fn web_service(dir: &Path) -> ServeDir<ServeFile> {
    ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))
}

async fn health(State(state): State<SharedState>) -> Json<HealthResponse> {
    let schema = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::schema_version(&conn).unwrap_or(0)
    };
    Json(HealthResponse {
        app: state.app,
        version: state.version.clone(),
        schema,
    })
}

async fn me(User(identity): User) -> Json<raven_core::Identity> {
    Json(identity)
}

#[derive(serde::Deserialize)]
struct SyncParams {
    /// The client's version; anything missing or unreadable counts as 0.
    v: Option<String>,
}

/// The y-websocket endpoint for one of the user's documents.
async fn sync_ws(
    ws: WebSocketUpgrade,
    User(identity): User,
    UrlPath(name): UrlPath<String>,
    Query(params): Query<SyncParams>,
    State(state): State<SharedState>,
) -> Response {
    let client = params.v.and_then(|v| v.parse().ok()).unwrap_or(0);
    let min_client = state.min_client;
    if !sync::valid_name(&name) {
        return (StatusCode::BAD_REQUEST, "bad document name").into_response();
    }
    let key = DocKey {
        owner: identity.login,
        name,
    };
    let open = match state.sync.open(key.clone()) {
        Ok(open) => open,
        Err(err) => {
            tracing::error!(?err, name = key.name, "opening document");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not open the document",
            )
                .into_response();
        }
    };
    ws.on_upgrade(move |socket| sync::serve_connection(socket, open, key, client, min_client))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use raven_core::RavenApp;
    use tower::ServiceExt;

    use super::*;
    use crate::config::Config;
    use crate::AppState;

    fn web_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("raven-web-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("_app")).unwrap();
        std::fs::write(dir.join("index.html"), "<title>Huginn</title>").unwrap();
        std::fs::write(dir.join("_app").join("app.js"), "console.log('app')").unwrap();
        dir
    }

    fn state(web_dir: Option<std::path::PathBuf>) -> SharedState {
        state_requiring(web_dir, 0)
    }

    fn state_requiring(web_dir: Option<std::path::PathBuf>, min_client: u32) -> SharedState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        db::migrate(&conn, &["CREATE TABLE t (id INTEGER)"]).unwrap();
        let db = Arc::new(Mutex::new(conn));
        let sync = sync::SyncHub::new(db.clone(), None).unwrap();
        Arc::new(AppState {
            app: RavenApp::Huginn,
            version: "test".into(),
            min_client,
            config: Config {
                listen_addr: String::new(),
                db_path: ":memory:".into(),
                web_dir,
                trust_identity_headers: true,
                dev_user: None,
                log_level: "info".into(),
            },
            db,
            sync,
        })
    }

    async fn body(res: axum::response::Response) -> String {
        String::from_utf8(to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec()).unwrap()
    }

    async fn get_path(app: &Router, path: &str, headers: &[(&str, &str)]) -> (u16, String) {
        let mut req = Request::get(path);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        (res.status().as_u16(), body(res).await)
    }

    #[tokio::test]
    async fn health_and_me_answer_at_the_root_and_under_the_base() {
        let app = router(state(None), Router::new());
        for path in ["/v1/health", "/huginn/v1/health"] {
            let (status, text) = get_path(&app, path, &[]).await;
            assert_eq!(status, 200, "{path}");
            let health: HealthResponse = serde_json::from_str(&text).unwrap();
            assert_eq!(health.app, RavenApp::Huginn);
            assert_eq!(health.schema, 1);
        }
        let (status, _) = get_path(&app, "/huginn/v1/me", &[]).await;
        assert_eq!(status, 401);
        let (status, text) = get_path(
            &app,
            "/huginn/v1/me",
            &[
                ("Tailscale-User-Login", "b@example.com"),
                ("Tailscale-User-Name", "B"),
            ],
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(text, r#"{"login":"b@example.com","name":"B"}"#);
    }

    #[tokio::test]
    async fn the_web_client_is_served_under_the_base_with_an_spa_fallback() {
        let dir = web_dir();
        let app = router(state(Some(dir)), Router::new());
        for path in ["/huginn", "/huginn/", "/huginn/n/abc"] {
            let (status, text) = get_path(&app, path, &[]).await;
            assert_eq!(status, 200, "{path}");
            assert!(text.contains("<title>Huginn</title>"), "{path}");
        }
        let (status, text) = get_path(&app, "/huginn/_app/app.js", &[]).await;
        assert_eq!(status, 200);
        assert!(text.contains("console.log"));
        // The same with the base stripped, as tailscale serve forwards it.
        for path in ["/", "/n/abc"] {
            let (status, text) = get_path(&app, path, &[]).await;
            assert_eq!(status, 200, "{path}");
            assert!(text.contains("<title>Huginn</title>"), "{path}");
        }
        let (status, text) = get_path(&app, "/_app/app.js", &[]).await;
        assert_eq!(status, 200);
        assert!(text.contains("console.log"));
    }

    #[tokio::test]
    async fn without_a_web_dir_the_root_is_api_only() {
        let app = router(state(None), Router::new());
        let (status, _) = get_path(&app, "/", &[]).await;
        assert_eq!(status, 404);
        let (status, _) = get_path(&app, "/huginn/", &[]).await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn the_sync_socket_turns_away_old_clients_and_reports_saves_to_new_ones() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message as Ws;

        let app = router(state_requiring(None, 1), Router::new());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let connect = |query: &'static str| async move {
            let mut req = format!("ws://{addr}/v1/sync/note:1{query}")
                .into_client_request()
                .unwrap();
            req.headers_mut()
                .insert("Tailscale-User-Login", "b@example.com".parse().unwrap());
            tokio_tungstenite::connect_async(req).await.unwrap().0
        };

        for query in ["", "?v=0", "?v=nonsense"] {
            let mut old = connect(query).await;
            match old.next().await.unwrap().unwrap() {
                Ws::Close(Some(frame)) => assert_eq!(u16::from(frame.code), sync::CLOSE_OUTDATED),
                other => panic!("{query}: expected a close, got {other:?}"),
            }
        }

        let mut current = connect("?v=1").await;
        assert!(
            matches!(current.next().await, Some(Ok(Ws::Binary(_)))),
            "greeting"
        );
        match current.next().await.unwrap().unwrap() {
            // A message tagged 100 is a save report.
            Ws::Binary(report) => assert_eq!(report[0], 100),
            other => panic!("expected a save report, got {other:?}"),
        }
    }
}
