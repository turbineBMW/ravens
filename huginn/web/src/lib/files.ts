/**
 * Attachments' bytes on this device, and getting them to and from the server
 * (huginn-server's blobs.rs).
 *
 * A file added here gets an id at once and is kept in IndexedDB, so a note can
 * show it straight away, offline included, and it survives a restart. A queue
 * uploads waiting files in the order they were added, in chunks that resume
 * where they stopped, whenever there's a connection; one tab runs it at a time.
 * Once the server has a file, this device keeps its copy as a cached one.
 * Files from other devices are fetched when shown and cached the same way, so
 * they're there offline next time, until the browser needs the space.
 */
import { base } from '$app/paths';
import { newId } from '@ravens/ui/sync';
import { readable, writable, type Readable, type Writable } from 'svelte/store';

/** Bytes sent per request; a dropped connection loses at most this much. */
export const CHUNK = 8 * 1024 * 1024;
const DB_NAME = `ravens${base}:files`;
const PENDING = 'pending';
const CACHE = 'cache';

export type FileState =
    /** On this device, waiting for a connection. */
    | 'waiting'
    | 'uploading'
    /** The server has it. */
    | 'stored'
    /** Neither here nor on the server yet: another device hasn't sent it. */
    | 'missing'
    /** Not on this device, and the server can't be asked right now. */
    | 'offline'
    | 'failed'
    | 'unknown';

export interface FileStatus {
    state: FileState;
    /** 0 to 1 while uploading. */
    progress: number;
    /** Why it failed, in words. */
    error: string;
}

interface Pending {
    id: string;
    blob: Blob;
    size: number;
    sha256: string;
    type: string;
    added: number;
    error?: string;
}

// ---------- IndexedDB ----------

let opened: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
    opened ??= new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(PENDING, { keyPath: 'id' });
            req.result.createObjectStore(CACHE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return opened;
}

function run<T>(store: string, mode: IDBTransactionMode, act: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return db().then(
        (d) =>
            new Promise<T>((resolve, reject) => {
                const tx = d.transaction(store, mode);
                const req = act(tx.objectStore(store));
                tx.oncomplete = () => resolve(req.result);
                tx.onerror = () => reject(tx.error ?? req.error);
                tx.onabort = () => reject(tx.error ?? req.error);
            }),
    );
}

const getPending = (id: string) => run<Pending | undefined>(PENDING, 'readonly', (s) => s.get(id));
const allPending = () => run<Pending[]>(PENDING, 'readonly', (s) => s.getAll());
const getCached = (id: string) => run<Blob | undefined>(CACHE, 'readonly', (s) => s.get(id));

/** The browser refused to store something: the device is full. */
function isQuota(err: unknown) {
    return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

// ---------- status ----------

const statuses = new Map<string, Writable<FileStatus>>();
function statusOf(id: string): Writable<FileStatus> {
    let s = statuses.get(id);
    if (!s) {
        s = writable<FileStatus>({ state: 'unknown', progress: 0, error: '' });
        statuses.set(id, s);
        void refresh(id);
    }
    return s;
}
function setStatus(id: string, state: FileState, progress = 0, error = '') {
    statusOf(id).set({ state, progress, error });
}

/** Where a file is: here waiting, uploading, on the server, or nowhere yet. */
export function fileStatus(id: string): Readable<FileStatus> {
    return { subscribe: statusOf(id).subscribe };
}

async function refresh(id: string) {
    const pending = await getPending(id).catch(() => undefined);
    if (pending) return setStatus(id, pending.error ? 'failed' : 'waiting', 0, pending.error ?? '');
    if (await getCached(id).catch(() => undefined)) return setStatus(id, 'stored');
    try {
        const res = await fetch(serverUrl(id), { method: 'HEAD' });
        setStatus(id, res.ok ? 'stored' : res.status === 404 ? 'missing' : 'unknown');
    } catch {
        setStatus(id, 'offline');
    }
}

// ---------- adding ----------

export async function sha256(blob: Blob): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ask the browser not to clear Huginn's storage when space runs low; once is enough. */
let askedToPersist = false;
function persist() {
    if (askedToPersist) return;
    askedToPersist = true;
    void navigator.storage?.persist?.().catch(() => false);
}

export class DeviceFull extends Error {
    constructor() {
        super("This device is out of space for attachments. Free some space, or add the file when it's connected.");
    }
}

/**
 * Keep a file on this device and queue it for the server; its id. `id` is
 * given when the file already has one, as when an archive is imported: the
 * server stores nothing new for a file it already has.
 */
export async function addFile(blob: Blob, id = newId()): Promise<string> {
    persist();
    const entry: Pending = {
        id,
        blob,
        size: blob.size,
        sha256: await sha256(blob),
        type: blob.type || 'application/octet-stream',
        added: Date.now(),
    };
    try {
        await run(PENDING, 'readwrite', (s) => s.put(entry));
    } catch (err) {
        throw isQuota(err) ? new DeviceFull() : err;
    }
    setStatus(id, 'waiting');
    kick();
    return id;
}

/** Stop uploading a file and forget it here; the server drops what it had of it. */
export async function cancelUpload(id: string) {
    await run(PENDING, 'readwrite', (s) => s.delete(id));
    setStatus(id, 'missing');
    void fetch(serverUrl(id), { method: 'DELETE' }).catch(() => {});
}

/** Try a failed upload again. */
export async function retryUpload(id: string) {
    const p = await getPending(id);
    if (!p) return;
    delete p.error;
    await run(PENDING, 'readwrite', (s) => s.put(p));
    setStatus(id, 'waiting');
    kick();
}

// ---------- reading ----------

export const serverUrl = (id: string) => `${base}/v1/blobs/${encodeURIComponent(id)}`;
export const downloadUrl = (id: string, name: string) =>
    `${serverUrl(id)}?${new URLSearchParams({ download: name || 'attachment' })}`;

/** The file's bytes, from this device if they're here, otherwise from the server (and kept here). */
export async function fileBlob(id: string): Promise<Blob | null> {
    const pending = await getPending(id).catch(() => undefined);
    if (pending) return pending.blob;
    const cached = await getCached(id).catch(() => undefined);
    if (cached) return cached;
    let res: Response;
    try {
        res = await fetch(serverUrl(id));
    } catch {
        setStatus(id, 'offline');
        return null;
    }
    if (!res.ok) {
        setStatus(id, res.status === 404 ? 'missing' : 'unknown');
        return null;
    }
    const blob = await res.blob();
    // Kept for offline use if there's room; it still shows if there isn't.
    await run(CACHE, 'readwrite', (s) => s.put(blob, id)).catch(() => {});
    setStatus(id, 'stored');
    return blob;
}

/** Whether the bytes are on this device, so they show offline. */
export async function isLocal(id: string): Promise<boolean> {
    return !!((await getPending(id).catch(() => undefined)) || (await getCached(id).catch(() => undefined)));
}

/**
 * An object URL for a file, for an `<img>` or a download, released when the
 * last subscriber leaves. Null while loading, and if it can't be had.
 */
export function fileUrl(id: string): Readable<string | null> {
    return readable<string | null>(null, (set) => {
        let url: string | null = null;
        let gone = false;
        const load = () =>
            void fileBlob(id).then((blob) => {
                if (gone || !blob) return;
                url = URL.createObjectURL(blob);
                set(url);
            });
        load();
        // A file another device hadn't sent yet shows once it has.
        const unsubscribe = statusOf(id).subscribe((s) => {
            if (!url && s.state === 'stored') load();
        });
        return () => {
            gone = true;
            unsubscribe();
            if (url) URL.revokeObjectURL(url);
        };
    });
}

// ---------- the upload queue ----------

let running = false;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Run the queue soon: after adding, when the connection comes back, and every half minute while anything waits. */
export function kick() {
    if (typeof window === 'undefined') return;
    if (running) {
        again = true;
        return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void drain(), 0);
}

async function drain() {
    running = true;
    again = false;
    try {
        const work = async () => {
            const all = (await allPending()).filter((p) => !p.error).sort((a, b) => a.added - b.added);
            for (const p of all) {
                if (!navigator.onLine) break;
                const ok = await upload(p);
                if (!ok) break;
            }
        };
        // One tab uploads at a time; the others leave it to that one.
        if (navigator.locks) await navigator.locks.request(`${DB_NAME}:uploads`, { ifAvailable: true }, work);
        else await work();
    } catch {
        /* Tried again below. */
    } finally {
        running = false;
    }
    const left = (await allPending().catch(() => [])).some((p) => !p.error);
    if (again) kick();
    else if (left) timer = setTimeout(() => void drain(), 30_000);
}

class Refused extends Error {}

/** Send one file, resuming; whether the queue can go on to the next. */
async function upload(p: Pending): Promise<boolean> {
    const url = serverUrl(p.id);
    try {
        setStatus(p.id, 'uploading', 0);
        const declared = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ size: p.size, sha256: p.sha256, type: p.type }),
        });
        if (!declared.ok) throw new Refused(await reason(declared));
        let status = (await declared.json()) as { received: number; complete: boolean };
        while (!status.complete) {
            const from = status.received;
            setStatus(p.id, 'uploading', p.size ? from / p.size : 0);
            const res = await fetch(url, {
                method: 'PATCH',
                headers: { 'upload-offset': String(from), 'content-type': 'application/octet-stream' },
                body: p.blob.slice(from, Math.min(from + CHUNK, p.size)),
            });
            if (res.status === 409) {
                // Out of step (a crash, another tab): the server says where it's at.
                const body = await res.json().catch(() => null);
                if (body && typeof body.received === 'number') {
                    status = body;
                    continue;
                }
                return true; // Another tab is sending it: leave it.
            }
            if (res.status === 422) {
                // The bytes changed on the way: start this file again, once.
                if (p.error === undefined && !retried.has(p.id)) {
                    retried.add(p.id);
                    status = { received: 0, complete: false };
                    continue;
                }
                throw new Refused("The file didn't arrive intact.");
            }
            if (!res.ok) throw new Refused(await reason(res));
            status = await res.json();
        }
        // Stored: this device keeps its copy as a cached one.
        await run(CACHE, 'readwrite', (s) => s.put(p.blob, p.id)).catch(() => {});
        await run(PENDING, 'readwrite', (s) => s.delete(p.id));
        setStatus(p.id, 'stored', 1);
        return true;
    } catch (err) {
        if (err instanceof Refused) {
            // Kept here with the reason, for Retry; the queue goes on to the next file.
            p.error = err.message;
            await run(PENDING, 'readwrite', (s) => s.put(p)).catch(() => {});
            setStatus(p.id, 'failed', 0, err.message);
            return true;
        }
        // The connection: wait for it.
        setStatus(p.id, 'waiting');
        return false;
    }
}
const retried = new Set<string>();

async function reason(res: Response): Promise<string> {
    if (res.status === 413) return 'The file is too large.';
    if (res.status === 507) return 'There’s no room left on the server for attachments.';
    if (res.status === 409) return 'A different file already has this name on the server.';
    const text = await res.text().catch(() => '');
    return text || `The server said ${res.status}.`;
}

/** Start the queue with the app, and again whenever the connection returns. */
export function startUploads() {
    if (typeof window === 'undefined') return;
    addEventListener('online', kick);
    kick();
}

// ---------- usage ----------

export interface Usage {
    used: number;
    quota: number;
    max_file: number;
}

export async function usage(): Promise<Usage | null> {
    try {
        const res = await fetch(`${base}/v1/blobs`, { headers: { accept: 'application/json' } });
        return res.ok ? ((await res.json()) as Usage) : null;
    } catch {
        return null;
    }
}

/** 1.2 MB, 340 KB, 12 bytes. */
export function sizeText(bytes: number): string {
    if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = bytes / 1000;
    let unit = 0;
    while (n >= 1000 && unit < units.length - 1) {
        n /= 1000;
        unit++;
    }
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[unit]}`;
}
