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
 * merge without clobbering each other.
 *
 * `meta.format` versions the shape. Format 2 adds `body`, a Y.XmlFragment of
 * rich text whose `checklist` block shows the `items` map; items themselves are
 * unchanged from format 1, which has no `format` and no body. `meta.title` holds
 * only a title the user set: without one, the title is the note's first line.
 * Format 3 is the same with more checklists, each its own top-level `items:<id>`
 * map named by the block's `list` attribute.
 *
 * Format 4 adds drawings. An `ink` block names its own top-level `strokes:<id>`
 * map, of stroke id to Y.Map { tool, color, width, created, points }. A stroke
 * never changes once drawn: erasing deletes it. `points` is binary, four
 * little-endian float32s per sample (x, y, pressure, milliseconds since the
 * stroke began), with x and y in the block's own units, INK_WIDTH across, so a
 * drawing scales with the column instead of being cut off or distorted.
 */
import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { base } from '$app/paths';
import { openDoc, yStore, newId, type OpenDoc } from '@ravens/ui/sync';
import { readable, type Readable } from 'svelte/store';

export type NoteKind = 'checklist' | 'text';

/** The newest note format this client can safely edit. */
export const NOTE_FORMAT = 4;
/** A note with more than its first checklist. */
const SEVERAL_LISTS_FORMAT = 3;
/** A note with a drawing. */
const INK_FORMAT = 4;

/** What migrated and new notes are: format 3 is only a note with more than the first list. */
const BASE_FORMAT = 2;
/** The checklist format 1 notes have. Others are named `items:<id>`. */
const FIRST_LIST = 'items';

/** Marks the migration, so undo and the index don't treat it as an edit. */
const MIGRATION = 'huginn-migration';
const INDEX_DELAY_MS = 300;

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
type YStroke = Y.Map<string | number | Uint8Array>;

// ---------- ink ----------

/** A drawing's width in its own units; the block scales them to the column. */
export const INK_WIDTH = 1000;
/** Numbers per stored sample: x, y, pressure, milliseconds since the stroke began. */
export const INK_STRIDE = 4;
export const INK_COLORS = ['ink', 'blue', 'red', 'green'] as const;
export type InkColor = (typeof INK_COLORS)[number];

export interface Stroke {
    id: string;
    tool: 'pen';
    color: InkColor;
    /** In drawing units, at full pressure. */
    width: number;
    created: number;
    /** INK_STRIDE numbers per sample. */
    points: Float32Array;
}

export function encodePoints(points: Float32Array): Uint8Array {
    const bytes = new Uint8Array(points.length * 4);
    const view = new DataView(bytes.buffer);
    points.forEach((n, i) => view.setFloat32(i * 4, n, true));
    return bytes;
}

export function decodePoints(bytes: Uint8Array): Float32Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points = new Float32Array(Math.floor(bytes.byteLength / 4 / INK_STRIDE) * INK_STRIDE);
    for (let i = 0; i < points.length; i++) points[i] = view.getFloat32(i * 4, true);
    return points;
}

function readStroke(id: string, m: YStroke): Stroke {
    const color = String(m.get('color') ?? 'ink') as InkColor;
    const points = m.get('points');
    return {
        id,
        tool: 'pen',
        color: INK_COLORS.includes(color) ? color : 'ink',
        width: Number(m.get('width') ?? 4),
        created: Number(m.get('created') ?? 0),
        points: points instanceof Uint8Array ? decodePoints(points) : new Float32Array(),
    };
}

/** One drawing: a strokes map, in the order they were drawn, and the edits it allows. */
export interface InkModel {
    strokes: Readable<Stroke[]>;
    /** Store a finished stroke; returns its id. */
    add(stroke: Pick<Stroke, 'color' | 'width' | 'points'>): string;
    remove(ids: string[]): void;
}

// ---------- the migration ----------

function fnv1a(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * Format 1 to format 2, as a Yjs update. Its author and content depend only on
 * the note ID, so every device produces the same operations, and applying them
 * twice, or after they were edited or deleted, changes nothing. Never change
 * what this writes: devices must keep agreeing on it.
 */
export function migrationSeed(noteId: string): Uint8Array {
    const seed = new Y.Doc();
    seed.clientID = fnv1a(`huginn-format-2:${noteId}`);
    seed.transact(() => {
        seed.getMap('meta').set('format', 2);
        const checklist = new Y.XmlElement('checklist');
        checklist.setAttribute('list', 'items');
        seed.getXmlFragment('body').insert(0, [checklist, new Y.XmlElement('paragraph')]);
    });
    const update = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    return update;
}

// ---------- plain text from the body ----------

function inlineText(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
    if (node instanceof Y.XmlText) {
        return (node.toDelta() as { insert: unknown }[])
            .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
            .join('');
    }
    if (!(node instanceof Y.XmlElement)) return '';
    if (node.nodeName === 'hardBreak') return ' ';
    return (node.toArray() as Y.XmlElement[]).map(inlineText).join('');
}

/** A block's text lines; `decorate` adds list markers and tabs between table cells. */
function blockLines(node: Y.XmlElement, decorate: boolean): string[] {
    const children = () => node.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement);
    switch (node.nodeName) {
        case 'horizontalRule':
            return decorate ? ['---'] : [];
        case 'bulletList':
        case 'orderedList':
            return children().flatMap((listItem, at) => {
                const marker = !decorate ? '' : node.nodeName === 'bulletList' ? '- ' : `${at + 1}. `;
                return (listItem.toArray() as Y.XmlElement[])
                    .flatMap((part) => blockLines(part, decorate))
                    .map((line, i) => (i === 0 ? marker : decorate ? '  ' : '') + line);
            });
        case 'blockquote':
            return children().flatMap((part) => blockLines(part, decorate));
        case 'table':
            return children().map((row) =>
                (row.toArray() as Y.XmlElement[])
                    .map((cell) => (cell.toArray() as Y.XmlElement[]).map(inlineText).join(' '))
                    .join(decorate ? '\t' : ' '),
            );
        case 'codeBlock':
            return inlineText(node).split('\n');
        default:
            return [inlineText(node)];
    }
}

// ---------- the index ----------

export interface Index {
    doc: OpenDoc;
    notes: Readable<NoteMeta[]>;
    create(kind: NoteKind): string;
    kindOf(id: string): NoteKind | undefined;
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
        kindOf(id) {
            const m = map.get(id);
            return m ? readMeta(id, m).kind : undefined;
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

/** One checklist: an items map, by position, and the edits it allows. */
export interface ChecklistModel {
    /** Unchecked items by position, then checked items in the order they were checked. */
    items: Readable<Item[]>;
    /** Insert after `afterId` (or at the end); returns the new id. */
    addItem(text: string, afterId?: string | null): string;
    setText(id: string, text: string): void;
    setChecked(id: string, checked: boolean): void;
    /** Place `id` between its new neighbours in the unchecked list. */
    move(id: string, beforeId: string | null, afterId: string | null): void;
    remove(id: string): void;
    uncheckAll(): void;
    removeChecked(): void;
}

/** The note's own checklist members are its first list, the one format 1 notes have. */
export interface Note extends ChecklistModel {
    doc: OpenDoc;
    /** The title the user set, if any. */
    title: Readable<string>;
    /** What the title is when none is set, for the title field's placeholder. */
    firstLine: Readable<string>;
    /** Zero until the note has a format this client can show: format 1 is migrated first. */
    format: Readable<number>;
    body: Y.XmlFragment;
    hasChecklist: Readable<boolean>;
    /** Saved by a newer client: shown as unavailable, and every edit below does nothing. */
    tooNew: Readable<boolean>;
    setTitle(title: string): void;
    /** Give a brand new note its format and empty body. */
    initialise(): void;
    /** Move a format 1 note to this format. `synced`: the server's copy has arrived. */
    migrate(synced: boolean): void;
    /** The note as plain text, for export. */
    plainText(): string;
    /** The checklist a body block points at. */
    list(name: string): ChecklistModel;
    /** The shared map behind a checklist, for undo. */
    listMap(name: string): Y.Map<unknown>;
    /** Prepare a new checklist for a block to point at; returns its name. */
    newList(): string;
    /** The drawing an ink block points at. */
    ink(name: string): InkModel;
    /** The shared map behind a drawing, for undo. */
    inkMap(name: string): Y.Map<unknown>;
    /** Prepare a new drawing for a block to point at; returns its name. */
    newInk(): string;
    /** Check off nothing and everything: these two cover every checklist in the note. */
    uncheckEverything(): void;
    removeAllChecked(): void;
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
    const items = doc.doc.getMap<YItem>(FIRST_LIST);

    const readList = (map: Y.Map<YItem>) => {
        const all: Item[] = [];
        map.forEach((m, iid) => all.push(readItem(iid, m)));
        return sortItems(all);
    };
    const readAll = () => readList(items);

    const body = doc.doc.getXmlFragment('body');
    const isTooNew = () => Number(meta.get('format') ?? 0) > NOTE_FORMAT;
    const blocks = () => body.toArray().filter((n): n is Y.XmlElement => n instanceof Y.XmlElement);
    const listOf = (block: Y.XmlElement) => doc.doc.getMap<YItem>(block.getAttribute('list') || FIRST_LIST);
    /** The lists the note shows, once each. A format 1 note has no body, and is all its first list. */
    const shownLists = () => {
        if (!meta.has('format')) return [items];
        return [
            ...new Set(
                blocks()
                    .filter((b) => b.nodeName === 'checklist')
                    .map(listOf),
            ),
        ];
    };

    /** The note's text, line by line, with the open checklist items where the checklist is. */
    const textLines = () => {
        const openItems = (map: Y.Map<YItem>) =>
            readList(map)
                .filter((i) => !i.checked)
                .map((i) => i.text);
        const lines = meta.has('format')
            ? blocks().flatMap((block) =>
                  block.nodeName === 'checklist' ? openItems(listOf(block)) : blockLines(block, false),
              )
            : openItems(items);
        return lines.map((line) => line.trim()).filter(Boolean);
    };

    /** What the index shows of this note. */
    const summary = () => {
        const explicit = String(meta.get('title') ?? '').trim();
        const lines = textLines();
        const all = shownLists().flatMap(readList);
        const open = all.filter((i) => !i.checked).length;
        return {
            // Without a set title, the first line is the title and not also the preview.
            title: explicit || (lines[0] ?? ''),
            preview: (explicit ? lines : lines.slice(1)).slice(0, 4).join('\n'),
            open,
            done: all.length - open,
        };
    };

    /** Keep the index card in step with the note. */
    const touched = () => index?.touch(id, summary());

    // Typing reaches the index shortly after, not on every keystroke, and only
    // the device doing the typing writes it.
    let pendingTouch: ReturnType<typeof setTimeout> | null = null;
    const flushTouch = () => {
        if (pendingTouch) clearTimeout(pendingTouch);
        if (pendingTouch) touched();
        pendingTouch = null;
    };
    const onBody = (_events: unknown, txn: Y.Transaction) => {
        if (!txn.local || txn.origin === MIGRATION) return;
        if (pendingTouch) clearTimeout(pendingTouch);
        pendingTouch = setTimeout(flushTouch, INDEX_DELAY_MS);
    };
    body.observeDeep(onBody);

    const lists = new Map<string, ChecklistModel>();
    const list = (name: string): ChecklistModel => {
        const cached = lists.get(name);
        if (cached) return cached;
        const map = doc.doc.getMap<YItem>(name);
        const readThis = () => readList(map);
        const openPositions = () =>
            readThis()
                .filter((i) => !i.checked)
                .map((i) => i.pos);
        const model: ChecklistModel = {
            items: yStore(map, readThis),
            addItem(text, afterId = null) {
                if (isTooNew()) return '';
                const iid = newId();
                const open = readThis().filter((i) => !i.checked);
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
                    map.set(iid, m);
                });
                touched();
                return iid;
            },
            setText(iid, text) {
                if (isTooNew()) return;
                map.get(iid)?.set('text', text);
                touched();
            },
            setChecked(iid, checked) {
                if (isTooNew()) return;
                const m = map.get(iid);
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
                const m = map.get(iid);
                if (!m) return;
                const before = beforeId ? String(map.get(beforeId)?.get('pos') ?? '') || null : null;
                const after = afterId ? String(map.get(afterId)?.get('pos') ?? '') || null : null;
                m.set('pos', generateKeyBetween(before, after));
                touched();
            },
            remove(iid) {
                if (isTooNew()) return;
                map.delete(iid);
                touched();
            },
            uncheckAll() {
                if (isTooNew()) return;
                doc.doc.transact(() => {
                    let last = openPositions().pop() ?? null;
                    for (const i of readThis().filter((i) => i.checked)) {
                        const m = map.get(i.id)!;
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
                    for (const i of readThis().filter((i) => i.checked)) map.delete(i.id);
                });
                touched();
            },
        };
        lists.set(name, model);
        return model;
    };
    const drawings = new Map<string, InkModel>();
    const ink = (name: string): InkModel => {
        const cached = drawings.get(name);
        if (cached) return cached;
        const map = doc.doc.getMap<YStroke>(name);
        const model: InkModel = {
            strokes: yStore(map, () => {
                const all: Stroke[] = [];
                map.forEach((m, sid) => all.push(readStroke(sid, m)));
                return all.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
            }),
            add({ color, width, points }) {
                if (isTooNew()) return '';
                const sid = newId();
                doc.doc.transact(() => {
                    const m = new Y.Map<string | number | Uint8Array>();
                    m.set('tool', 'pen');
                    m.set('color', color);
                    m.set('width', width);
                    m.set('created', Date.now());
                    m.set('points', encodePoints(points));
                    map.set(sid, m);
                });
                touched();
                return sid;
            },
            remove(ids) {
                if (isTooNew() || !ids.length) return;
                doc.doc.transact(() => {
                    for (const sid of ids) map.delete(sid);
                });
                touched();
            },
        };
        drawings.set(name, model);
        return model;
    };
    /** Raise the note's format to at least `format`, for a block older clients can't show. */
    const needFormat = (format: number) => {
        if (Number(meta.get('format') ?? 0) < format) meta.set('format', format);
    };

    const shownNames = () => {
        if (!meta.has('format')) return [FIRST_LIST];
        const named = blocks()
            .filter((b) => b.nodeName === 'checklist')
            .map((b) => b.getAttribute('list') || FIRST_LIST);
        return [...new Set(named)];
    };

    return {
        doc,
        ...list(FIRST_LIST),
        title: yStore(meta, () => String(meta.get('title') ?? '')),
        firstLine: readable('', (set) => {
            // Any list may hold the first line, and lists come and go, so watch the document.
            const update = () => set(textLines()[0] ?? '');
            update();
            doc.doc.on('update', update);
            return () => doc.doc.off('update', update);
        }),
        format: yStore(meta, () => Number(meta.get('format') ?? 0)),
        body,
        hasChecklist: yStore(body, () => blocks().some((block) => block.nodeName === 'checklist')),
        tooNew: yStore(meta, isTooNew),
        initialise() {
            doc.doc.transact(() => {
                meta.set('format', BASE_FORMAT);
                meta.set('title', '');
                body.insert(0, [new Y.XmlElement('paragraph')]);
            }, MIGRATION);
        },
        migrate(synced) {
            if (meta.has('format')) return;
            // An empty document may just not be downloaded. Once the server's copy
            // has arrived, an empty checklist note really is empty; a new note,
            // whose creator hasn't uploaded it yet, is never treated as format 1.
            const hasContent = meta.has('title') || items.size > 0;
            if (hasContent || (synced && index?.kindOf(id) === 'checklist')) {
                Y.applyUpdate(doc.doc, migrationSeed(id), MIGRATION);
            }
        },
        plainText() {
            const explicit = String(meta.get('title') ?? '').trim();
            const lines = blocks().flatMap((block) =>
                block.nodeName === 'checklist'
                    ? readList(listOf(block)).map((i) => `[${i.checked ? 'x' : ' '}] ${i.text}`)
                    : block.nodeName === 'ink'
                      ? ['[Drawing]']
                      : blockLines(block, true),
            );
            return [...(explicit ? [explicit, ''] : []), ...lines].join('\n').trim() + '\n';
        },
        items: yStore(items, readAll),
        setTitle(title) {
            if (isTooNew()) return;
            meta.set('title', title);
            touched();
        },
        list,
        listMap: (name) => doc.doc.getMap(name),
        newList() {
            if (isTooNew()) return FIRST_LIST;
            needFormat(SEVERAL_LISTS_FORMAT);
            return `${FIRST_LIST}:${newId()}`;
        },
        ink,
        inkMap: (name) => doc.doc.getMap(name),
        newInk() {
            if (!isTooNew()) needFormat(INK_FORMAT);
            return `strokes:${newId()}`;
        },
        uncheckEverything() {
            for (const name of shownNames()) list(name).uncheckAll();
        },
        removeAllChecked() {
            for (const name of shownNames()) list(name).removeChecked();
        },
        repairIndex() {
            // An empty document may just not be downloaded: it proves nothing.
            if (!index || isTooNew() || (!meta.has('format') && !meta.has('title') && items.size === 0)) return;
            index.repair(id, summary());
        },
        release() {
            flushTouch();
            body.unobserveDeep(onBody);
            doc.release();
        },
    };
}
