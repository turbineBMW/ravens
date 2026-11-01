//! Reminders leaving the server. A scheduler walks the mirrored tasks every
//! half minute and, for each one whose time has come (its date-time, or its
//! all-day date at the user's chosen hour in their time zone), delivers one
//! event: to every connection on the user's SSE stream (the desktop agent)
//! and to every web push subscription the user's browsers registered (the
//! Fold). `notified` remembers what fired so a reminder fires once per due
//! time; changing the due time makes it a new reminder.

use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Result;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use futures_util::stream::Stream;
use raven_server::identity::User;
use raven_server::SharedState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use web_push::{
    ContentEncoding, HyperWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

const TICK: Duration = Duration::from_secs(30);
/// A reminder older than this when the server first sees it is not fired (a
/// server that was down for a week does not spray a week of reminders); one
/// missed earlier the same day still fires.
const STALE: chrono::Duration = chrono::Duration::hours(24);

/// What a reminder looks like on the wire, to the agent and to push.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reminder {
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// Relative to the origin: `/muninn/l/<list>`.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub tag: String,
}

#[derive(Debug, Clone)]
struct Owned {
    owner: String,
    reminder: Reminder,
}

struct Notify {
    events: broadcast::Sender<Owned>,
    push: HyperWebPushClient,
    vapid_private: String,
    vapid_public: String,
}

static NOTIFY: OnceLock<Notify> = OnceLock::new();

fn notify() -> &'static Notify {
    NOTIFY.get().expect("notify::init runs at startup")
}

/// Load or create the VAPID key pair; call from `on_start`.
pub fn init(conn: &Connection) -> Result<()> {
    let private: String =
        match conn.query_row("SELECT private_key FROM vapid WHERE id = 1", [], |r| {
            r.get(0)
        }) {
            Ok(k) => k,
            Err(_) => {
                let secret = p256::SecretKey::random(&mut rand::thread_rng());
                let k = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secret.to_bytes());
                conn.execute(
                    "INSERT INTO vapid (id, private_key) VALUES (1, ?1)",
                    params![k],
                )?;
                tracing::info!("generated a VAPID key pair");
                k
            }
        };
    let public = VapidSignatureBuilder::from_base64_no_sub(&private)
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .get_public_key();
    let (events, _) = broadcast::channel(256);
    let _ = NOTIFY.set(Notify {
        events,
        push: HyperWebPushClient::new(),
        vapid_private: private,
        vapid_public: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public),
    });
    Ok(())
}

pub fn routes() -> Router<SharedState> {
    Router::new()
        .route("/v1/push/key", get(push_key))
        .route(
            "/v1/push/subscriptions",
            post(subscribe).delete(unsubscribe),
        )
        .route("/v1/push/test", post(push_test))
        .route("/v1/notifications/stream", get(stream))
}

pub fn start(state: SharedState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        loop {
            tick.tick().await;
            match due_now(&state) {
                Ok(due) => {
                    for (owner, reminder) in due {
                        deliver(&state, &owner, reminder).await;
                    }
                }
                Err(err) => tracing::error!(?err, "scheduler"),
            }
        }
    });
}

// ---------- the scheduler ----------

/// When a task's reminder fires, in UTC: a timed task at its time; an
/// all-day task at the user's `all_day_at` in their time zone.
fn fire_at(due: &str, all_day: bool, tz: &str, all_day_at: &str) -> Option<DateTime<Utc>> {
    if all_day || due.len() == 10 {
        let date = NaiveDate::parse_from_str(&due[..10.min(due.len())], "%Y-%m-%d").ok()?;
        let time = NaiveTime::parse_from_str(all_day_at, "%H:%M")
            .unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).unwrap());
        let zone: chrono_tz::Tz = tz.parse().unwrap_or(chrono_tz::UTC);
        zone.from_local_datetime(&date.and_time(time))
            .earliest()
            .map(|d| d.with_timezone(&Utc))
    } else {
        DateTime::parse_from_rfc3339(due)
            .ok()
            .map(|d| d.with_timezone(&Utc))
    }
}

/// Everything due by now that has not fired, marked as fired.
fn due_now(state: &SharedState) -> Result<Vec<(String, Reminder)>> {
    let now = Utc::now();
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let mut st = conn.prepare_cached(
        "SELECT t.owner, t.list_id, t.id, t.title, t.due, t.all_day, COALESCE(s.tz, 'UTC'), COALESCE(s.all_day_at, '09:00')
         FROM tasks t LEFT JOIN settings s ON s.owner = t.owner
         WHERE t.done = 0 AND t.due <> ''
           AND NOT EXISTS (SELECT 1 FROM notified n WHERE n.owner = t.owner AND n.list_id = t.list_id AND n.id = t.id AND n.due = t.due)",
    )?;
    let rows: Vec<(String, String, String, String, String, bool, String, String)> = st
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get::<_, i64>(5)? != 0,
                r.get(6)?,
                r.get(7)?,
            ))
        })?
        .collect::<std::result::Result<_, _>>()?;
    let mut out = Vec::new();
    for (owner, list_id, id, title, due, all_day, tz, at) in rows {
        let Some(when) = fire_at(&due, all_day, &tz, &at) else {
            continue;
        };
        if when > now {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO notified (owner, list_id, id, due, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![owner, list_id, id, due, now.to_rfc3339()],
        )?;
        if now - when > STALE {
            tracing::info!(owner, id, due, "skipping a stale reminder");
            continue;
        }
        let body = if all_day {
            String::new()
        } else {
            when.with_timezone(&tz.parse().unwrap_or(chrono_tz::UTC))
                .format("%-I:%M %p")
                .to_string()
        };
        out.push((
            owner,
            Reminder {
                title,
                body,
                url: format!("/muninn/l/{list_id}"),
                tag: format!("{list_id}:{id}"),
            },
        ));
    }
    Ok(out)
}

async fn deliver(state: &SharedState, owner: &str, reminder: Reminder) {
    let n = notify();
    tracing::info!(owner, title = reminder.title, "reminder");
    let _ = n.events.send(Owned {
        owner: owner.to_string(),
        reminder: reminder.clone(),
    });
    let subs: Vec<(String, String, String)> = {
        let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
        conn.prepare_cached(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner = ?1",
        )
        .and_then(|mut st| {
            st.query_map(params![owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect()
        })
        .unwrap_or_default()
    };
    let payload = serde_json::to_vec(&reminder).unwrap_or_default();
    for (endpoint, p256dh, auth) in subs {
        let info = SubscriptionInfo::new(endpoint.clone(), p256dh, auth);
        let sent = async {
            let sig = VapidSignatureBuilder::from_base64(&n.vapid_private, &info)?.build()?;
            let mut msg = WebPushMessageBuilder::new(&info);
            msg.set_payload(ContentEncoding::Aes128Gcm, &payload);
            msg.set_vapid_signature(sig);
            msg.set_ttl(6 * 3600);
            n.push.send(msg.build()?).await
        }
        .await;
        match sent {
            Ok(()) => {}
            Err(WebPushError::EndpointNotValid(_)) | Err(WebPushError::EndpointNotFound(_)) => {
                tracing::info!(owner, "dropping an expired push subscription");
                let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
                let _ = conn.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint = ?1",
                    params![endpoint],
                );
            }
            Err(err) => tracing::warn!(?err, owner, "web push failed"),
        }
    }
}

// ---------- the API ----------

async fn push_key() -> String {
    notify().vapid_public.clone()
}

/// A browser's PushSubscription.toJSON().
#[derive(Deserialize)]
struct Subscription {
    endpoint: String,
    keys: Keys,
}
#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

async fn subscribe(
    User(me): User,
    State(state): State<SharedState>,
    Json(sub): Json<Subscription>,
) -> StatusCode {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    match conn.execute(
        "INSERT INTO push_subscriptions (owner, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (endpoint) DO UPDATE SET owner = excluded.owner, p256dh = excluded.p256dh, auth = excluded.auth",
        params![me.login, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Utc::now().to_rfc3339()],
    ) {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(err) => {
            tracing::error!(?err, "storing a push subscription");
            StatusCode::INTERNAL_SERVER_ERROR
        }
    }
}

#[derive(Deserialize)]
struct Unsubscribe {
    endpoint: String,
}

async fn unsubscribe(
    User(me): User,
    State(state): State<SharedState>,
    Json(u): Json<Unsubscribe>,
) -> StatusCode {
    let conn = state.db.lock().unwrap_or_else(|e| e.into_inner());
    let _ = conn.execute(
        "DELETE FROM push_subscriptions WHERE owner = ?1 AND endpoint = ?2",
        params![me.login, u.endpoint],
    );
    StatusCode::NO_CONTENT
}

async fn push_test(User(me): User, State(state): State<SharedState>) -> StatusCode {
    deliver(
        &state,
        &me.login,
        Reminder {
            title: "Muninn is set up".into(),
            body: "Reminders will arrive here.".into(),
            url: "/muninn/".into(),
            tag: "test".into(),
        },
    )
    .await;
    StatusCode::NO_CONTENT
}

/// Server-sent events: every reminder for the signed-in user, as it fires.
async fn stream(User(me): User) -> impl IntoResponse {
    let rx = notify().events.subscribe();
    let owner = me.login;
    let s = async_stream_for(rx, owner);
    Sse::new(s).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(25))
            .text("keep-alive"),
    )
}

fn async_stream_for(
    rx: broadcast::Receiver<Owned>,
    owner: String,
) -> impl Stream<Item = std::result::Result<Event, std::convert::Infallible>> {
    futures_util::stream::unfold((rx, owner), |(mut rx, owner)| async move {
        loop {
            match rx.recv().await {
                Ok(o) if o.owner == owner => {
                    let ev = Event::default()
                        .event("reminder")
                        .json_data(&o.reminder)
                        .unwrap_or_else(|_| Event::default());
                    return Some((Ok(ev), (rx, owner)));
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

/// Settings mirrored from the index document's `settings` map.
pub fn mirror_settings(
    owner: &str,
    tz: &str,
    all_day_at: &str,
    conn: &Connection,
) -> rusqlite::Result<()> {
    let tz = if tz.is_empty() { "UTC" } else { tz };
    let at = if NaiveTime::parse_from_str(all_day_at, "%H:%M").is_ok() {
        all_day_at
    } else {
        "09:00"
    };
    conn.execute(
        "INSERT INTO settings (owner, tz, all_day_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (owner) DO UPDATE SET tz = excluded.tz, all_day_at = excluded.all_day_at",
        params![owner, tz, at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_day_fires_at_the_users_hour_in_their_zone() {
        let at = fire_at("2026-11-03", true, "America/New_York", "09:00").unwrap();
        assert_eq!(at.to_rfc3339(), "2026-11-03T14:00:00+00:00");
        let at = fire_at("2026-07-03", true, "America/New_York", "07:30").unwrap();
        assert_eq!(at.to_rfc3339(), "2026-07-03T11:30:00+00:00");
        // Unknown zone: UTC.
        let at = fire_at("2026-11-03", true, "Mars/Olympus", "09:00").unwrap();
        assert_eq!(at.to_rfc3339(), "2026-11-03T09:00:00+00:00");
    }

    #[test]
    fn timed_tasks_fire_at_their_instant() {
        let at = fire_at("2026-11-03T18:15:00-05:00", false, "UTC", "09:00").unwrap();
        assert_eq!(at.to_rfc3339(), "2026-11-03T23:15:00+00:00");
        assert!(fire_at("garbage", false, "UTC", "09:00").is_none());
    }

    #[test]
    fn the_scheduler_fires_each_due_time_once_and_skips_stale_ones() {
        let conn = Connection::open_in_memory().unwrap();
        raven_server::db::migrate(&conn, crate::MIGRATIONS).unwrap();
        let today = Utc::now().format("%Y-%m-%d").to_string();
        let ins = |id: &str, due: &str, all_day: i64| {
            conn.execute(
                "INSERT INTO tasks (owner, list_id, id, title, done, due, all_day, flagged) VALUES ('b', 'L', ?1, ?1, 0, ?2, ?3, 0)",
                params![id, due, all_day],
            )
            .unwrap();
        };
        ins(
            "timed-past",
            &(Utc::now() - chrono::Duration::minutes(5)).to_rfc3339(),
            0,
        );
        ins(
            "timed-future",
            &(Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
            0,
        );
        ins(
            "stale",
            &(Utc::now() - chrono::Duration::days(3)).to_rfc3339(),
            0,
        );
        ins("allday-today", &today, 1);
        mirror_settings("b", "UTC", "00:00", &conn).unwrap();
        let state = test_state(conn);
        let mut fired: Vec<String> = due_now(&state)
            .unwrap()
            .into_iter()
            .map(|(_, r)| r.title)
            .collect();
        fired.sort();
        assert_eq!(fired, vec!["allday-today", "timed-past"]);
        // Nothing fires twice; the future one is still pending.
        assert!(due_now(&state).unwrap().is_empty());
        let n: i64 = state
            .db
            .lock()
            .unwrap()
            .query_row("SELECT count(*) FROM notified", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3, "the stale one is marked too, so it never fires");
    }

    fn test_state(conn: Connection) -> SharedState {
        use std::sync::{Arc, Mutex};
        let db = Arc::new(Mutex::new(conn));
        Arc::new(raven_server::AppState {
            min_client: 0,
            app: raven_server::RavenApp::Muninn,
            version: "test".into(),
            config: raven_server::config::Config {
                listen_addr: String::new(),
                db_path: ":memory:".into(),
                web_dir: None,
                trust_identity_headers: false,
                dev_user: Some("b".into()),
                log_level: "info".into(),
            },
            db: db.clone(),
            sync: raven_server::sync::SyncHub::new(db, None).unwrap(),
        })
    }
}
