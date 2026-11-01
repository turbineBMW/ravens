/**
 * Huginn's data, as Yjs documents (see @ravens/ui/sync).
 *
 * `index`: one document per user listing their notes: a Y.Map of note id to
 * a Y.Map { title, kind, created, updated, pinned }. Titles are mirrored
 * here so the notes page renders offline without opening every note.
 *
 * `note:<id>`: one document per note. `meta` holds { title }; `items` is a
 * Y.Map of item id to Y.Map { text, checked, checkedAt, pos }. Each item is
 * its own object with a stable id, a completion state and a fractional
 * index `pos`, so reordering, checking and offline editing on two devices
 * merge without clobbering each other. `meta.format` versions that shape;
 * a note without it is format 1.
 */
import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { base } from '$app/paths';
import { openDoc, yStore, newId, type OpenDoc } from '@ravens/ui/sync';
import type { Readable } from 'svelte/store';

export type NoteKind = 'checklist' | 'text';

/** The newest note format this client can safely edit. */
export const NOTE_FORMAT = 1;

export interface NoteMeta {
    id: string;
    title: string;
    kind: NoteKind;
    created: number;
    updated: number;
    pinned: boolean;
    /** Zero for active notes; otherwise retained in Recently Deleted until restored. */
    deletedAt: number;
    /** The first open items, one per line, for the card on the notes page. */
    preview: string;
    open: number;
    done: number;
}

export interface Item {
    id: string;
    text: string;
    checked: boolean;
    checkedAt: number;
    pos: string;
}

type YNoteMeta = Y.Map<string | number | boolean>;
type YItem = Y.Map<string | number | boolean>;

// ---------- the index ----------

export interface Index {
    doc: OpenDoc;
    notes: Readable<NoteMeta[]>;
    create(kind: NoteKind): string;
    touch(id: string, patch: Partial<Pick<NoteMeta, 'title' | 'pinned' | 'preview' | 'open' | 'done'>>): void;
    /** Correct the mirrored fields from the note itself, without counting as an edit. */
    repair(id: string, patch: Partial<Pick<NoteMeta, 'title' | 'preview' | 'open' | 'done'>>): void;
    remove(id: string): void;
    restore(id: string): void;
    release(): void;
}

function readMeta(id: string, m: YNoteMeta): NoteMeta {
    return {
        id,
        title: String(m.get('title') ?? ''),
        kind: (m.get('kind') as NoteKind) ?? 'checklist',
        created: Number(m.get('created') ?? 0),
        updated: Number(m.get('updated') ?? 0),
        pinned: Boolean(m.get('pinned') ?? false),
        deletedAt: Number(m.get('deletedAt') ?? 0),
        preview: String(m.get('preview') ?? ''),
        open: Number(m.get('open') ?? 0),
        done: Number(m.get('done') ?? 0),
    };
}

export function openIndex(): Index {
    const doc = openDoc(base, 'index');
    const map = doc.doc.getMap<YNoteMeta>('notes');
    const notes = yStore(map, () => {
        const all: NoteMeta[] = [];
        map.forEach((m, id) => all.push(readMeta(id, m)));
        // Pinned first, then most recently edited.
        return all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated);
    });
    return {
        doc,
        notes,
        create(kind) {
            const id = newId();
            const now = Date.now();
            doc.doc.transact(() => {
                const m = new Y.Map<string | number | boolean>();
                m.set('title', '');
                m.set('kind', kind);
                m.set('created', now);
                m.set('updated', now);
                m.set('pinned', false);
                map.set(id, m);
            });
            return id;
        },
        touch(id, patch) {
            const m = map.get(id);
            if (!m) return;
            doc.doc.transact(() => {
                for (const k of ['title', 'pinned', 'preview', 'open', 'done'] as const) {
                    if (patch[k] !== undefined) m.set(k, patch[k]);
                }
                m.set('updated', Date.now());
            });
        },
        repair(id, patch) {
            const m = map.get(id);
            if (!m) return;
            doc.doc.transact(() => {
                for (const k of ['title', 'preview', 'open', 'done'] as const) {
                    const value = patch[k];
                    if (value !== undefined && value !== readMeta(id, m)[k]) m.set(k, value);
                }
            });
        },
        remove(id) {
            map.get(id)?.set('deletedAt', Date.now());
        },
        restore(id) {
            map.get(id)?.set('deletedAt', 0);
        },
        release: () => doc.release(),
    };
}

// ---------- one note ----------

export interface Note {
    doc: OpenDoc;
    title: Readable<string>;
    /** Saved by a newer client: shown as unavailable, and every edit below does nothing. */
    tooNew: Readable<boolean>;
    /** Unchecked items by position, then checked items in the order they were checked. */
    items: Readable<Item[]>;
    setTitle(title: string): void;
    /** Insert after `afterId` (or at the end); returns the new id. */
    addItem(text: string, afterId?: string | null): string;
    setText(id: string, text: string): void;
    setChecked(id: string, checked: boolean): void;
    /** Place `id` between its new neighbours in the unchecked list. */
    move(id: string, beforeId: string | null, afterId: string | null): void;
    remove(id: string): void;
    uncheckAll(): void;
    removeChecked(): void;
    /** Bring this note's entry in the index back in line with its contents. */
    repairIndex(): void;
    release(): void;
}

function readItem(id: string, m: YItem): Item {
    return {
        id,
        text: String(m.get('text') ?? ''),
        checked: Boolean(m.get('checked') ?? false),
        checkedAt: Number(m.get('checkedAt') ?? 0),
        pos: String(m.get('pos') ?? 'a0'),
    };
}

export function sortItems(all: Item[]): Item[] {
    const open = all
        .filter((i) => !i.checked)
        .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id.localeCompare(b.id)));
    const done = all.filter((i) => i.checked).sort((a, b) => a.checkedAt - b.checkedAt || a.id.localeCompare(b.id));
    return [...open, ...done];
}

export function openNote(id: string, index?: Index): Note {
    const doc = openDoc(base, `note:${id}`);
    const meta = doc.doc.getMap<string | number>('meta');
    const items = doc.doc.getMap<YItem>('items');

    const readAll = () => {
        const all: Item[] = [];
        items.forEach((m, iid) => all.push(readItem(iid, m)));
        return sortItems(all);
    };
    const openPositions = () =>
        readAll()
            .filter((i) => !i.checked)
            .map((i) => i.pos);

    const isTooNew = () => Number(meta.get('format') ?? 1) > NOTE_FORMAT;

    /** What the index card shows of the items. */
    const summary = () => {
        const all = readAll();
        const open = all.filter((i) => !i.checked);
        return {
            preview: open
                .slice(0, 4)
                .map((i) => i.text)
                .join('\n'),
            open: open.length,
            done: all.length - open.length,
        };
    };

    /** Keep the index card in step with the items. */
    const touched = () => index?.touch(id, summary());

    return {
        doc,
        title: yStore(meta, () => String(meta.get('title') ?? '')),
        tooNew: yStore(meta, isTooNew),
        items: yStore(items, readAll),
        setTitle(title) {
            if (isTooNew()) return;
            meta.set('title', title);
            index?.touch(id, { title });
        },
        addItem(text, afterId = null) {
            if (isTooNew()) return '';
            const iid = newId();
            const open = readAll().filter((i) => !i.checked);
            const at = afterId ? open.findIndex((i) => i.id === afterId) : open.length - 1;
            const before = at >= 0 ? (open[at]?.pos ?? null) : null;
            const after = at + 1 < open.length ? open[at + 1].pos : null;
            const pos = generateKeyBetween(before, after);
            doc.doc.transact(() => {
                const m = new Y.Map<string | number | boolean>();
                m.set('text', text);
                m.set('checked', false);
                m.set('checkedAt', 0);
                m.set('pos', pos);
                items.set(iid, m);
            });
            touched();
            return iid;
        },
        setText(iid, text) {
            if (isTooNew()) return;
            items.get(iid)?.set('text', text);
            touched();
        },
        setChecked(iid, checked) {
            if (isTooNew()) return;
            const m = items.get(iid);
            if (!m) return;
            doc.doc.transact(() => {
                m.set('checked', checked);
                m.set('checkedAt', checked ? Date.now() : 0);
                // Unchecking puts the item back at the end of the open list.
                if (!checked) {
                    const positions = openPositions();
                    m.set('pos', generateKeyBetween(positions[positions.length - 1] ?? null, null));
                }
            });
            touched();
        },
        move(iid, beforeId, afterId) {
            if (isTooNew()) return;
            const m = items.get(iid);
            if (!m) return;
            const before = beforeId ? String(items.get(beforeId)?.get('pos') ?? '') || null : null;
            const after = afterId ? String(items.get(afterId)?.get('pos') ?? '') || null : null;
            m.set('pos', generateKeyBetween(before, after));
            touched();
        },
        remove(iid) {
            if (isTooNew()) return;
            items.delete(iid);
            touched();
        },
        uncheckAll() {
            if (isTooNew()) return;
            doc.doc.transact(() => {
                let last = openPositions().pop() ?? null;
                for (const i of readAll().filter((i) => i.checked)) {
                    const m = items.get(i.id)!;
                    last = generateKeyBetween(last, null);
                    m.set('checked', false);
                    m.set('checkedAt', 0);
                    m.set('pos', last);
                }
            });
            touched();
        },
        removeChecked() {
            if (isTooNew()) return;
            doc.doc.transact(() => {
                for (const i of readAll().filter((i) => i.checked)) items.delete(i.id);
            });
            touched();
        },
        repairIndex() {
            // An empty document may just not be downloaded: it proves nothing.
            if (!index || isTooNew() || (!meta.has('title') && items.size === 0)) return;
            index.repair(id, {
                ...summary(),
                ...(meta.has('title') ? { title: String(meta.get('title')) } : {}),
            });
        },
        release: () => doc.release(),
    };
}
