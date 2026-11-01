use std::path::PathBuf;

use anyhow::{bail, Result};
use raven_core::RavenApp;

/// Server configuration, from `RAVEN_*` environment variables. Each app runs
/// in its own container (or its own shell), so one prefix serves both.
#[derive(Debug, Clone)]
pub struct Config {
    /// `RAVEN_LISTEN_ADDR`; default `127.0.0.1:8081` (Huginn) / `:8082` (Muninn).
    pub listen_addr: String,
    /// `RAVEN_DB_PATH`; default `<app>.db` in the working directory.
    pub db_path: PathBuf,
    /// `RAVEN_WEB_DIR`: the web client's built files, served under the app's
    /// base path. Unset: API only (the Vite dev server serves the client).
    pub web_dir: Option<PathBuf>,
    /// `RAVEN_TRUST_IDENTITY_HEADERS=true`: believe `Tailscale-User-Login`.
    /// Only safe when nothing but `tailscale serve` can reach this port, which
    /// is why compose binds the containers to loopback.
    pub trust_identity_headers: bool,
    /// `RAVEN_DEV_USER`: who every request is from when no trusted header
    /// says otherwise. For `cargo run` on a workstation; never set it in compose.
    pub dev_user: Option<String>,
    /// `RAVEN_LOG_LEVEL` (a tracing filter); `RUST_LOG` wins when set.
    pub log_level: String,
}

impl Config {
    pub fn load(app: RavenApp) -> Result<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let default_port = match app {
            RavenApp::Huginn => 8081,
            RavenApp::Muninn => 8082,
        };
        let trust = match var("RAVEN_TRUST_IDENTITY_HEADERS").as_deref() {
            None | Some("false") | Some("0") | Some("no") => false,
            Some("true") | Some("1") | Some("yes") => true,
            Some(other) => {
                bail!("RAVEN_TRUST_IDENTITY_HEADERS must be true or false, not {other:?}")
            }
        };
        Ok(Self {
            listen_addr: var("RAVEN_LISTEN_ADDR")
                .unwrap_or_else(|| format!("127.0.0.1:{default_port}")),
            db_path: var("RAVEN_DB_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| format!("{app}.db").into()),
            web_dir: var("RAVEN_WEB_DIR").map(PathBuf::from),
            trust_identity_headers: trust,
            dev_user: var("RAVEN_DEV_USER"),
            log_level: var("RAVEN_LOG_LEVEL").unwrap_or_else(|| "info".into()),
        })
    }
}
