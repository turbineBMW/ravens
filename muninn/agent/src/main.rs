//! muninn-agent: reminders as desktop notifications.
//!
//! Keeps one HTTPS connection to the Muninn server's event stream
//! (`/v1/notifications/stream`, server-sent events) and shows every
//! reminder through the desktop notification daemon (omarchy-shell on Omarchy) via
//! D-Bus. Identity comes from the tailnet: the request leaves this machine
//! through Tailscale, and `tailscale serve` on the server stamps it with the
//! user's login. Reconnects with backoff; runs as a systemd user service.
//!
//!   MUNINN_URL=https://brandons-mac-mini.tail339aa4.ts.net/muninn muninn-agent

use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Deserialize)]
struct Reminder {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let base = std::env::var("MUNINN_URL")
        .context("MUNINN_URL (e.g. https://host.tailnet.ts.net/muninn) is not set")?;
    let base = base.trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()?;
    let mut backoff = Duration::from_secs(1);
    loop {
        match follow(&client, &base).await {
            Ok(()) => {
                tracing::info!("stream ended; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(err) => {
                tracing::warn!(?err, "stream failed; retrying in {backoff:?}");
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

/// One connection, until the server closes it or it breaks.
async fn follow(client: &reqwest::Client, base: &str) -> Result<()> {
    let res = client
        .get(format!("{base}/v1/notifications/stream"))
        .header("accept", "text/event-stream")
        .send()
        .await?
        .error_for_status()?;
    tracing::info!("following {base}");
    let mut stream = res.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk?));
        // Events end with a blank line.
        while let Some(end) = buf.find("\n\n") {
            let event = buf[..end].to_string();
            buf.drain(..end + 2);
            if let Some((name, data)) = parse_event(&event) {
                if name == "reminder" {
                    match serde_json::from_str::<Reminder>(&data) {
                        Ok(r) => {
                            tracing::info!(title = r.title, "reminder");
                            show(&r)
                        }
                        Err(err) => tracing::warn!(?err, data, "bad reminder"),
                    }
                }
            }
        }
    }
    Ok(())
}

/// (event name, joined data) from one SSE event block; comments and keep-alives yield None.
fn parse_event(block: &str) -> Option<(String, String)> {
    let mut name = "message".to_string();
    let mut data = Vec::new();
    for line in block.lines() {
        if let Some(v) = line.strip_prefix("event:") {
            name = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("data:") {
            data.push(v.strip_prefix(' ').unwrap_or(v).to_string());
        }
    }
    if data.is_empty() {
        return None;
    }
    Some((name, data.join("\n")))
}

/// The server's origin (scheme and host), for the relative urls reminders carry.
fn origin() -> Option<String> {
    let base = std::env::var("MUNINN_URL").ok()?;
    let rest = base.split_once("://")?;
    let host = rest.1.split('/').next()?;
    Some(format!("{}://{}", rest.0, host))
}

fn show(r: &Reminder) {
    let mut n = notify_rust::Notification::new();
    let url = if r.url.starts_with('/') {
        origin()
            .map(|o| format!("{o}{}", r.url))
            .unwrap_or_default()
    } else {
        r.url.clone()
    };
    n.appname("Muninn")
        .summary(&r.title)
        .body(&r.body)
        .icon("alarm-symbolic")
        .timeout(notify_rust::Timeout::Never);
    if !url.is_empty() {
        // The daemon offers the action; a click opens the list with the default handler.
        n.action("default", "Open");
    }
    match n.show() {
        Ok(handle) => {
            tracing::info!("shown");
            if !url.is_empty() {
                std::thread::spawn(move || {
                    handle.wait_for_action(|action| {
                        if action == "default" {
                            let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
                        }
                    });
                });
            }
        }
        Err(err) => tracing::warn!(?err, "showing notification"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_blocks_are_parsed() {
        assert_eq!(
            parse_event("event: reminder\ndata: {\"title\":\"x\"}"),
            Some(("reminder".into(), "{\"title\":\"x\"}".into()))
        );
        assert_eq!(parse_event(": keep-alive"), None);
        assert_eq!(
            parse_event("data: a\ndata: b"),
            Some(("message".into(), "a\nb".into()))
        );
    }
}
