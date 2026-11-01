//! Everything a raven server does the same way as the other one. An app crate
//! supplies its name, its SQLite migrations and its own routes, and calls
//! [`run`]; this crate loads the config, opens the database, resolves who the
//! user is, serves the web client and answers health.

pub mod api;
pub mod config;
pub mod db;
pub mod identity;
pub mod sync;

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use axum::Router;
use rusqlite::Connection;
use tracing_subscriber::EnvFilter;

pub use raven_core::{HealthResponse, Identity, LinkTarget, RavenApp};

use crate::config::Config;

/// What the shared handlers and the app's own handlers see.
pub struct AppState {
    pub app: RavenApp,
    pub version: String,
    /// Sync clients older than this are turned away (see `AppSpec`).
    pub min_client: u32,
    pub config: Config,
    /// One connection behind a mutex is plenty for a personal server; a pool
    /// comes when something measures the need.
    pub db: Arc<Mutex<Connection>>,
    /// The open Yjs documents (see `sync`).
    pub sync: sync::SyncHub,
}

pub type SharedState = Arc<AppState>;

/// The app crate's description of itself.
pub struct AppSpec {
    pub app: RavenApp,
    /// The oldest client version allowed to sync. Raise it, with the client's
    /// `CLIENT_VERSION`, when a change would let an older client damage documents.
    pub min_client: u32,
    /// Applied in order; `PRAGMA user_version` records how many have run.
    pub migrations: &'static [&'static str],
    /// The app's API, routed under `/v1/...` (and `/<base>/v1/...`).
    pub routes: fn(SharedState) -> Router<SharedState>,
    /// Called after every change to a document, with the transaction that
    /// made it and the database connection, so the app can mirror what it
    /// needs into tables (search, links, due dates). Runs on the sync path:
    /// keep it quick. None: nothing is mirrored.
    pub on_change: Option<sync::OnChange>,
    /// Called once on the runtime before serving, for background work (a
    /// scheduler, a watcher) that needs the state.
    pub on_start: Option<fn(SharedState)>,
}

/// Load config, open the database, serve until SIGINT/SIGTERM.
pub fn run(spec: AppSpec) -> Result<()> {
    let config = Config::load(spec.app)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(config.log_level.clone())),
        )
        .init();
    let version =
        std::env::var("RAVEN_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    tracing::info!(app = %spec.app, %version, ?config, "starting");

    let conn = db::open(&config.db_path, spec.migrations).context("opening the database")?;
    let db = Arc::new(Mutex::new(conn));
    let sync = sync::SyncHub::new(db.clone(), spec.on_change)?;
    let state: SharedState = Arc::new(AppState {
        app: spec.app,
        version,
        min_client: spec.min_client,
        config,
        db,
        sync,
    });

    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind(&state.config.listen_addr)
            .await
            .with_context(|| format!("binding {}", state.config.listen_addr))?;
        tracing::info!(addr = %state.config.listen_addr, base = state.app.base(), "listening");
        if let Some(start) = spec.on_start {
            start(state.clone());
        }
        let router = api::router(state.clone(), (spec.routes)(state.clone()));
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown())
            .await?;
        Ok(())
    })
}

async fn shutdown() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await.ok();
    tracing::info!("shutting down");
}
