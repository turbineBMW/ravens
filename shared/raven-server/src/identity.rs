//! Who is asking. There is no login page: the Mac mini's `tailscale serve`
//! terminates TLS for the tailnet and stamps every proxied request with
//! `Tailscale-User-Login` and `Tailscale-User-Name`. The server believes
//! those only when configured to (the port is loopback-only, so nothing else
//! can set them); a workstation `cargo run` names a dev user instead.

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use raven_core::Identity;

use crate::{config::Config, SharedState};

/// Extractor: the signed-in person, or a 401.
#[derive(Debug, Clone)]
pub struct User(pub Identity);

pub fn resolve(config: &Config, headers: &HeaderMap) -> Option<Identity> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    if config.trust_identity_headers {
        if let Some(login) = header("tailscale-user-login") {
            // Tailscale MIME-encodes (RFC 2047) a display name with non-ASCII
            // characters; shown as-is until that matters.
            return Some(Identity {
                login: login.to_string(),
                name: header("tailscale-user-name").map(String::from),
            });
        }
    }
    config
        .dev_user
        .clone()
        .map(|login| Identity { login, name: None })
}

impl FromRequestParts<SharedState> for User {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedState,
    ) -> Result<Self, Self::Rejection> {
        resolve(&state.config, &parts.headers)
            .map(User)
            .ok_or_else(|| {
                (
                    StatusCode::UNAUTHORIZED,
                    "no identity: not reached through tailscale serve",
                )
                    .into_response()
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use raven_core::RavenApp;

    fn config(trust: bool, dev: Option<&str>) -> Config {
        Config {
            listen_addr: String::new(),
            db_path: "x.db".into(),
            web_dir: None,
            trust_identity_headers: trust,
            dev_user: dev.map(String::from),
            log_level: "info".into(),
        }
    }

    fn tailscale_headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            "tailscale-user-login",
            "turbine.bmw@gmail.com".parse().unwrap(),
        );
        h.insert("tailscale-user-name", "Brandon".parse().unwrap());
        h
    }

    #[test]
    fn trusted_headers_name_the_user() {
        let id = resolve(&config(true, None), &tailscale_headers()).unwrap();
        assert_eq!(id.login, "turbine.bmw@gmail.com");
        assert_eq!(id.name.as_deref(), Some("Brandon"));
    }

    #[test]
    fn untrusted_headers_are_ignored() {
        assert_eq!(resolve(&config(false, None), &tailscale_headers()), None);
        let id = resolve(&config(false, Some("dev")), &tailscale_headers()).unwrap();
        assert_eq!(id.login, "dev");
    }

    #[test]
    fn dev_user_fills_in_when_no_header_arrives() {
        let id = resolve(&config(true, Some("dev")), &HeaderMap::new()).unwrap();
        assert_eq!(id.login, "dev");
        assert_eq!(resolve(&config(true, None), &HeaderMap::new()), None);
        let _ = RavenApp::Huginn;
    }
}
