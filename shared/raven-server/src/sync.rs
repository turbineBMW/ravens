//! Document sync: the server end of y-websocket. Each client holds a Yjs
//! document (one per note, one index per user); the server keeps the same
//! document in yrs, merges every client's updates, persists them in SQLite
//! and fans them out to the other connections on the same document. The
//! wire format is the y-sync protocol the `y-websocket` client speaks, so
//! the client needs nothing custom.
//!
//! Documents are keyed by (owner, name): a name like `index` or `note:abc`
//! is always read inside the signed-in user's namespace, so one user can
//! never open another's document by guessing a name.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use axum::extract::ws::{Message as WsMessage, WebSocket};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{params, Connection};
use tokio::sync::{broadcast, RwLock};
use yrs::sync::{Awareness, DefaultProtocol, Message, MessageReader, Protocol, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{Doc, ReadTxn, StateVector, Transact, TransactionMut, Update};

/// After this many stored updates a document is folded into one state blob on next load.
const COMPACT_AFTER: usize = 200;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS ydocs (
    owner      TEXT NOT NULL,
    name       TEXT NOT NULL,
    state      BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, name)
);
CREATE TABLE IF NOT EXISTS yupdates (
    id    INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    name  TEXT NOT NULL,
    data  BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS yupdates_doc ON yupdates (owner, name, id);
";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DocKey {
    pub owner: String,
    pub name: String,
}

/// A document name a client may ask for: a lowercase word, optionally
/// `:` and an id. Anything else is refused before touching the database.
pub fn valid_name(name: &str) -> bool {
    let (kind, id) = name.split_once(':').unwrap_or((name, ""));
    !kind.is_empty()
        && kind.len() <= 32
        && kind.bytes().all(|b| b.is_ascii_lowercase())
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && (name.contains(':') == !id.is_empty())
}

/// One open document and everyone connected to it.
pub struct OpenDoc {
    pub awareness: RwLock<Awareness>,
    /// Encoded protocol messages (updates, awareness) for every connection.
    pub tx: broadcast::Sender<Arc<Vec<u8>>>,
}

/// An app's mirror of a changed document into its own tables (see AppSpec).
pub type OnChange = fn(&DocKey, &TransactionMut, &Connection);

/// The open documents of this process; loads from and persists to SQLite.
pub struct SyncHub {
    db: Arc<Mutex<Connection>>,
    docs: Mutex<HashMap<DocKey, Arc<OpenDoc>>>,
    on_change: Option<OnChange>,
}

impl SyncHub {
    pub fn new(db: Arc<Mutex<Connection>>, on_change: Option<OnChange>) -> Result<Self> {
        db.lock()
            .unwrap_or_else(|e| e.into_inner())
            .execute_batch(SCHEMA)
            .context("creating the sync tables")?;
        Ok(Self {
            db,
            docs: Mutex::new(HashMap::new()),
            on_change,
        })
    }

    /// The document, loaded on first use. Documents stay open for the life
    /// of the process; a personal server has few enough of them.
    pub fn open(&self, key: DocKey) -> Result<Arc<OpenDoc>> {
        if let Some(doc) = self
            .docs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
        {
            return Ok(doc.clone());
        }
        let doc = self.load(&key)?;
        let (tx, _) = broadcast::channel(256);
        let open = Arc::new(OpenDoc {
            awareness: RwLock::new(Awareness::new(doc)),
            tx,
        });
        self.attach(&key, &open);
        let mut docs = self.docs.lock().unwrap_or_else(|e| e.into_inner());
        Ok(docs.entry(key).or_insert(open).clone())
    }

    fn load(&self, key: &DocKey) -> Result<Doc> {
        let doc = Doc::new();
        let conn = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let state: Option<Vec<u8>> = conn
            .query_row(
                "SELECT state FROM ydocs WHERE owner = ?1 AND name = ?2",
                params![key.owner, key.name],
                |r| r.get(0),
            )
            .ok();
        let updates: Vec<Vec<u8>> = conn
            .prepare("SELECT data FROM yupdates WHERE owner = ?1 AND name = ?2 ORDER BY id")?
            .query_map(params![key.owner, key.name], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        {
            let mut txn = doc.transact_mut();
            if let Some(state) = state {
                txn.apply_update(Update::decode_v1(&state).context("stored state")?)?;
            }
            for u in &updates {
                txn.apply_update(Update::decode_v1(u).context("stored update")?)?;
            }
        }
        if updates.len() >= COMPACT_AFTER {
            let state = doc
                .transact()
                .encode_state_as_update_v1(&StateVector::default());
            conn.execute(
                "INSERT INTO ydocs (owner, name, state, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (owner, name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
                params![key.owner, key.name, state, now()],
            )?;
            conn.execute(
                "DELETE FROM yupdates WHERE owner = ?1 AND name = ?2",
                params![key.owner, key.name],
            )?;
            tracing::info!(
                owner = key.owner,
                name = key.name,
                updates = updates.len(),
                "compacted document"
            );
        }
        Ok(doc)
    }

    /// Persist and broadcast every change applied to the document, whoever applies it.
    fn attach(&self, key: &DocKey, open: &Arc<OpenDoc>) {
        let db = self.db.clone();
        let tx = open.tx.clone();
        let key = key.clone();
        let on_change = self.on_change;
        let awareness = open.awareness.try_write().expect("fresh document");
        awareness
            .doc()
            .observe_update_v1("raven", move |txn, e| {
                let conn = db.lock().unwrap_or_else(|e| e.into_inner());
                if let Err(err) = conn.execute(
                    "INSERT INTO yupdates (owner, name, data) VALUES (?1, ?2, ?3)",
                    params![key.owner, key.name, e.update],
                ) {
                    tracing::error!(?err, owner = key.owner, name = key.name, "storing update");
                }
                if let Some(f) = on_change {
                    f(&key, txn, &conn);
                }
                drop(conn);
                let mut enc = EncoderV1::new();
                Message::Sync(SyncMessage::Update(e.update.clone())).encode(&mut enc);
                let _ = tx.send(Arc::new(enc.to_vec()));
            })
            .expect("fresh document has no observer");
        let tx = open.tx.clone();
        let mut awareness = awareness;
        awareness.on_update("raven", move |awareness, event, _origin| {
            if let Ok(update) = awareness.update_with_clients(event.all_changes()) {
                let mut enc = EncoderV1::new();
                Message::Awareness(update).encode(&mut enc);
                let _ = tx.send(Arc::new(enc.to_vec()));
            }
        });
    }
}

/// Reading plain values out of a document, for an app's `OnChange`.
pub mod read {
    use yrs::{Any, Out, ReadTxn};

    pub fn string(v: Option<Out>) -> String {
        match v {
            Some(Out::Any(Any::String(s))) => s.to_string(),
            Some(Out::Any(Any::Number(n))) => n.to_string(),
            Some(Out::Any(Any::Bool(b))) => b.to_string(),
            _ => String::new(),
        }
    }

    pub fn boolean(v: Option<Out>) -> bool {
        matches!(v, Some(Out::Any(Any::Bool(true))))
    }

    pub fn number(v: Option<Out>) -> f64 {
        match v {
            Some(Out::Any(Any::Number(n))) => n.as_f64().unwrap_or(0.0),
            _ => 0.0,
        }
    }

    /// Every (key, map) pair of a top-level map of maps, such as a note's items.
    pub fn maps<'a, T: ReadTxn>(txn: &'a T, name: &str) -> Vec<(String, yrs::MapRef)> {
        use yrs::Map;
        let Some(top) = txn.get_map(name) else {
            return Vec::new();
        };
        top.iter(txn)
            .filter_map(|(k, v)| match v {
                Out::YMap(m) => Some((k.to_string(), m)),
                _ => None,
            })
            .collect()
    }
}

fn now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

/// Handle one client's messages against the document: every y-sync message
/// in `data` is applied, and the replies (sync step 2, awareness) come back
/// as one encoded buffer, or `None` when there is nothing to say.
pub async fn handle_incoming(
    open: &OpenDoc,
    data: &[u8],
) -> std::result::Result<Option<Vec<u8>>, yrs::sync::Error> {
    let mut decoder = DecoderV1::from(data);
    let reader = MessageReader::new(&mut decoder);
    let mut enc = EncoderV1::new();
    let mut any = false;
    let mut awareness = open.awareness.write().await;
    for msg in reader {
        if let Some(reply) = DefaultProtocol.handle_message(&mut awareness, msg?)? {
            reply.encode(&mut enc);
            any = true;
        }
    }
    Ok(any.then(|| enc.to_vec()))
}

/// What the server says first: its state vector (so the client sends what
/// the server lacks) and the current awareness.
pub async fn greeting(open: &OpenDoc) -> std::result::Result<Vec<u8>, yrs::sync::Error> {
    let awareness = open.awareness.read().await;
    let mut enc = EncoderV1::new();
    DefaultProtocol.start(&awareness, &mut enc)?;
    Ok(enc.to_vec())
}

/// One websocket connection, until it closes.
pub async fn serve_connection(socket: WebSocket, open: Arc<OpenDoc>, key: DocKey) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = open.tx.subscribe();
    match greeting(&open).await {
        Ok(msg) => {
            if sink.send(WsMessage::Binary(msg.into())).await.is_err() {
                return;
            }
        }
        Err(err) => {
            tracing::warn!(?err, name = key.name, "greeting failed");
            return;
        }
    }
    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(msg)) = incoming else { break };
                let data = match msg {
                    WsMessage::Binary(b) => b,
                    WsMessage::Close(_) => break,
                    _ => continue,
                };
                match handle_incoming(&open, &data).await {
                    Ok(Some(reply)) => {
                        if sink.send(WsMessage::Binary(reply.into())).await.is_err() { break; }
                    }
                    Ok(None) => {}
                    Err(err) => {
                        tracing::warn!(?err, name = key.name, "bad sync message; closing");
                        break;
                    }
                }
            }
            fanout = rx.recv() => {
                match fanout {
                    Ok(bytes) => {
                        if sink.send(WsMessage::Binary(bytes.as_slice().to_vec().into())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        // Missed broadcasts: the client's next sync step 1 (resync) catches up.
                        tracing::warn!(name = key.name, missed = n, "slow sync client");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Text, Transact};

    fn hub() -> SyncHub {
        SyncHub::new(
            Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            None,
        )
        .unwrap()
    }

    fn key(name: &str) -> DocKey {
        DocKey {
            owner: "b@example.com".into(),
            name: name.into(),
        }
    }

    /// A client-side document, as y-websocket would drive it.
    fn client_update(text: &str) -> Vec<u8> {
        let doc = Doc::new();
        let t = doc.get_or_insert_text("t");
        let mut txn = doc.transact_mut();
        t.insert(&mut txn, 0, text);
        txn.encode_update_v1()
    }

    fn sync_update_msg(update: Vec<u8>) -> Vec<u8> {
        let mut enc = EncoderV1::new();
        Message::Sync(SyncMessage::Update(update)).encode(&mut enc);
        enc.to_vec()
    }

    #[test]
    fn names_are_checked_before_anything_else() {
        for ok in ["index", "note:abc123", "note:a-b_C9"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "",
            "Index",
            "note:",
            ":abc",
            "note:a b",
            "../x",
            "note:abc:def",
            "a".repeat(40).as_str(),
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn updates_are_applied_persisted_and_fanned_out() {
        let hub = hub();
        let open = hub.open(key("note:1")).await_ok();
        let mut rx = open.tx.subscribe();

        let reply = handle_incoming(&open, &sync_update_msg(client_update("milk")))
            .await
            .unwrap();
        assert!(reply.is_none(), "an update needs no reply");

        // Fanned out to every connection as a sync update message.
        let fanned = rx.try_recv().unwrap();
        let mut dec = DecoderV1::from(fanned.as_slice());
        match Message::decode(&mut dec).unwrap() {
            Message::Sync(SyncMessage::Update(_)) => {}
            other => panic!("expected an update, got {other:?}"),
        }

        // Applied to the server's copy.
        let awareness = open.awareness.read().await;
        let t = awareness.doc().get_or_insert_text("t");
        assert_eq!(t.get_string(&awareness.doc().transact()), "milk");
        drop(awareness);

        // Persisted: a fresh hub on the same database loads it back.
        let hub2 = SyncHub::new(hub.db.clone(), None).unwrap();
        let open2 = hub2.open(key("note:1")).await_ok();
        let awareness = open2.awareness.read().await;
        let t = awareness.doc().get_or_insert_text("t");
        assert_eq!(t.get_string(&awareness.doc().transact()), "milk");
    }

    #[tokio::test]
    async fn the_greeting_asks_for_what_the_server_lacks_and_step1_is_answered() {
        let hub = hub();
        let open = hub.open(key("index")).await_ok();
        let greeting = greeting(&open).await.unwrap();
        let mut dec = DecoderV1::from(greeting.as_slice());
        let msgs: Vec<Message> = MessageReader::new(&mut dec).map(|m| m.unwrap()).collect();
        assert!(matches!(msgs[0], Message::Sync(SyncMessage::SyncStep1(_))));
        assert!(matches!(msgs[1], Message::Awareness(_)));

        // A client's own step 1 gets a step 2 back.
        let mut enc = EncoderV1::new();
        Message::Sync(SyncMessage::SyncStep1(StateVector::default())).encode(&mut enc);
        let reply = handle_incoming(&open, &enc.to_vec())
            .await
            .unwrap()
            .expect("step 2");
        let mut dec = DecoderV1::from(reply.as_slice());
        assert!(matches!(
            Message::decode(&mut dec).unwrap(),
            Message::Sync(SyncMessage::SyncStep2(_))
        ));
    }

    #[tokio::test]
    async fn documents_are_private_to_their_owner() {
        let hub = hub();
        let mine = hub.open(key("note:1")).await_ok();
        handle_incoming(&mine, &sync_update_msg(client_update("secret")))
            .await
            .unwrap();
        let theirs = hub
            .open(DocKey {
                owner: "other@example.com".into(),
                name: "note:1".into(),
            })
            .await_ok();
        let awareness = theirs.awareness.read().await;
        let t = awareness.doc().get_or_insert_text("t");
        assert_eq!(t.get_string(&awareness.doc().transact()), "");
    }

    trait AwaitOk<T> {
        fn await_ok(self) -> T;
    }
    impl<T> AwaitOk<T> for Result<T> {
        fn await_ok(self) -> T {
            self.unwrap()
        }
    }
}
