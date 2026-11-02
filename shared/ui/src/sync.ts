/**
 * Local-first documents. Every piece of app data is a Yjs document: edits
 * apply to the local copy instantly, y-indexeddb keeps it on this device
 * across reloads and offline, and y-websocket carries changes to the
 * server (raven-server's /v1/sync/<name>, yrs on the other end) and from
 * there to the other devices. Two tabs on one device sync through a
 * BroadcastChannel without the server.
 *
 * Documents are named per app and per user; the server scopes the name to
 * the Tailscale identity, so `index` here is this user's index.
 */
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { readVarUint8Array, type Decoder } from 'lib0/decoding';
import { readable, writable, type Readable } from 'svelte/store';

export type SyncStatus = 'offline' | 'connecting' | 'online';
/**
 * Whether the server has stored this document's changes. `unknown` until it
 * has said so on this page; `failed` means it holds them but couldn't store them.
 */
export type SaveState = 'unknown' | 'saved' | 'pending' | 'failed';

/**
 * Sent with every connection. A server turns away anything older than its
 * app's `min_client`, so raise both when a change would let an older client
 * damage documents.
 */
export const CLIENT_VERSION = 3;
// The server's custom messages and close code (raven-server's sync.rs).
const MSG_SAVED = 100;
const MSG_SAVE_FAILED = 101;
const CLOSE_OUTDATED = 4426;

export interface OpenDoc {
    name: string;
    doc: Y.Doc;
    /** Resolves once the local copy has loaded; the UI can render from then on. */
    whenLocal: Promise<void>;
    /** True once the server has answered a full sync at least once this session. */
    status: Readable<SyncStatus>;
    synced: Readable<boolean>;
    save: Readable<SaveState>;
    /** The server refuses this client as too old; it stops reconnecting. */
    outdated: Readable<boolean>;
    /** Let go; the document closes after a short linger if nobody else holds it. */
    release(): void;
}

interface Held extends OpenDoc {
    refs: number;
    closeTimer: ReturnType<typeof setTimeout> | null;
    close(): void;
}

const LINGER_MS = 30_000;
const held = new Map<string, Held>();

function wsBase(base: string): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${base}/v1/sync`;
}

/**
 * Open (or share an already open) document. `base` is the app's path
 * (`/huginn`), which also namespaces the IndexedDB store so the two ravens
 * never read each other's local copies.
 */
export function openDoc(base: string, name: string): OpenDoc {
    const key = `${base}:${name}`;
    let h = held.get(key);
    if (h) {
        h.refs++;
        if (h.closeTimer) {
            clearTimeout(h.closeTimer);
            h.closeTimer = null;
        }
        return h;
    }

    const doc = new Y.Doc({ gc: true });
    const local = new IndexeddbPersistence(`ravens${key}`, doc);
    const whenLocal = local.whenSynced.then(() => undefined);
    const provider = new WebsocketProvider(wsBase(base), name, doc, {
        connect: true,
        maxBackoffTime: 10_000,
        params: { v: String(CLIENT_VERSION) },
    });

    const save = writable<SaveState>('unknown');
    let stored: Map<number, number> | null = null;
    let saveFailed = false;
    const refreshSave = () => {
        if (saveFailed) return save.set('failed');
        if (!stored) return save.set('unknown');
        let covered = true;
        Y.decodeStateVector(Y.encodeStateVector(doc)).forEach((clock, client) => {
            if ((stored!.get(client) ?? 0) < clock) covered = false;
        });
        save.set(covered ? 'saved' : 'pending');
    };
    provider.messageHandlers[MSG_SAVED] = (_encoder, decoder: Decoder) => {
        stored = Y.decodeStateVector(readVarUint8Array(decoder));
        saveFailed = false;
        refreshSave();
    };
    provider.messageHandlers[MSG_SAVE_FAILED] = (_encoder, decoder: Decoder) => {
        readVarUint8Array(decoder);
        saveFailed = true;
        refreshSave();
    };
    doc.on('update', refreshSave);

    const outdated = writable(false);
    provider.on('connection-close', (event) => {
        if (event?.code === CLOSE_OUTDATED) {
            outdated.set(true);
            provider.disconnect();
        }
    });

    const status = readable<SyncStatus>('connecting', (set) => {
        const onStatus = ({ status }: { status: 'connected' | 'disconnected' | 'connecting' }) =>
            set(status === 'connected' ? 'online' : status === 'connecting' ? 'connecting' : 'offline');
        // A reopened document may already be connected, with no event coming.
        set(provider.wsconnected ? 'online' : provider.wsconnecting ? 'connecting' : 'offline');
        provider.on('status', onStatus);
        return () => provider.off('status', onStatus);
    });
    const synced = readable<boolean>(provider.synced, (set) => {
        const onSync = (s: boolean) => set(s);
        // The first sync may have finished before anyone subscribed.
        set(provider.synced);
        provider.on('sync', onSync);
        return () => provider.off('sync', onSync);
    });

    const entry: Held = {
        name,
        doc,
        whenLocal,
        status,
        synced,
        save,
        outdated,
        refs: 1,
        closeTimer: null,
        release() {
            entry.refs--;
            if (entry.refs > 0 || entry.closeTimer) return;
            entry.closeTimer = setTimeout(() => {
                if (entry.refs === 0) entry.close();
            }, LINGER_MS);
        },
        close() {
            held.delete(key);
            provider.destroy();
            void local.destroy();
            doc.destroy();
        },
    };
    held.set(key, entry);
    return entry;
}

/** Anything observable deeply: a Y.Map, Y.Array, Y.Text or Y.XmlFragment. */
interface DeepObservable {
    observeDeep(f: (events: Y.YEvent<any>[], txn: Y.Transaction) => void): void;
    unobserveDeep(f: (events: Y.YEvent<any>[], txn: Y.Transaction) => void): void;
}

/** A Svelte store that re-reads `read()` whenever anything under `type` changes. */
export function yStore<T>(type: DeepObservable, read: () => T): Readable<T> {
    return readable<T>(read(), (set) => {
        const update = () => set(read());
        // The document may have changed before anyone subscribed.
        update();
        type.observeDeep(update);
        return () => type.unobserveDeep(update);
    });
}

export function newId(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    return Array.from(
        { length: 20 },
        () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 36)],
    ).join('');
}
