/**
 * Muninn's data, as Yjs documents (see @ravens/ui/sync).
 *
 * `index`: one document per user with their lists: a Y.Map of list id to
 * Y.Map { name, color, pos, open, created, updated }. The smart lists
 * (Today, Scheduled, Flagged, All) are views over every list, not records.
 *
 * `list:<id>`: one document per list. `tasks` is a Y.Map of task id to
 * Y.Map { title, notes, done, doneAt, due, allDay, flagged, priority, pos,
 * parent, source }. `due` is an ISO date (`2026-11-03`) when `allDay`, else
 * an ISO date-time with offset. `source` is a raven_core LinkTarget as JSON
 * when the task was made from a Huginn note. Each task is its own object
 * with a stable id and a fractional-index `pos`, as in Huginn.
 */
import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { base } from '$app/paths';
import { openDoc, yStore, newId, type OpenDoc } from '@ravens/ui/sync';
import type { LinkTarget } from '@ravens/ui/api';
import type { Readable } from 'svelte/store';

export interface ListMeta {
    id: string;
    name: string;
    color: string;
    pos: string;
    /** Open tasks, mirrored so the lists page renders offline. */
    open: number;
    created: number;
    updated: number;
}

export type Priority = 0 | 1 | 2 | 3;

export interface Task {
    id: string;
    title: string;
    notes: string;
    done: boolean;
    doneAt: number;
    /** ISO date or date-time; '' when none. */
    due: string;
    allDay: boolean;
    flagged: boolean;
    priority: Priority;
    pos: string;
    /** Parent task id for a subtask; '' at the top level. */
    parent: string;
    source: LinkTarget | null;
}

export const LIST_COLORS = ['accent', 'blue', 'red', 'orange', 'yellow', 'green', 'purple', 'pink'] as const;

type YRec = Y.Map<string | number | boolean>;

// ---------- the index of lists ----------

export interface Index {
    doc: OpenDoc;
    lists: Readable<ListMeta[]>;
    create(name: string, color?: string): string;
    update(id: string, patch: Partial<Pick<ListMeta, 'name' | 'color' | 'open'>>): void;
    move(id: string, beforeId: string | null, afterId: string | null): void;
    remove(id: string): void;
    release(): void;
}

function readList(id: string, m: YRec): ListMeta {
    return {
        id,
        name: String(m.get('name') ?? ''),
        color: String(m.get('color') ?? 'accent'),
        pos: String(m.get('pos') ?? 'a0'),
        open: Number(m.get('open') ?? 0),
        created: Number(m.get('created') ?? 0),
        updated: Number(m.get('updated') ?? 0),
    };
}

const byPos = <T extends { pos: string }>(a: T, b: T) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0);

export function openIndex(): Index {
    const doc = openDoc(base, 'index');
    const map = doc.doc.getMap<YRec>('lists');
    const all = () => {
        const out: ListMeta[] = [];
        map.forEach((m, id) => out.push(readList(id, m)));
        return out.sort(byPos);
    };
    return {
        doc,
        lists: yStore(map, all),
        create(name, color = 'accent') {
            const id = newId();
            const now = Date.now();
            const last = all().pop()?.pos ?? null;
            doc.doc.transact(() => {
                const m = new Y.Map<string | number | boolean>();
                m.set('name', name);
                m.set('color', color);
                m.set('pos', generateKeyBetween(last, null));
                m.set('open', 0);
                m.set('created', now);
                m.set('updated', now);
                map.set(id, m);
            });
            return id;
        },
        update(id, patch) {
            const m = map.get(id);
            if (!m) return;
            doc.doc.transact(() => {
                for (const k of ['name', 'color', 'open'] as const) if (patch[k] !== undefined) m.set(k, patch[k]);
                m.set('updated', Date.now());
            });
        },
        move(id, beforeId, afterId) {
            const m = map.get(id);
            if (!m) return;
            const pos = (x: string | null) => (x ? String(map.get(x)?.get('pos') ?? '') || null : null);
            m.set('pos', generateKeyBetween(pos(beforeId), pos(afterId)));
        },
        remove(id) {
            map.delete(id);
        },
        release: () => doc.release(),
    };
}

// ---------- one list ----------

export interface List {
    doc: OpenDoc;
    /** Open tasks by position (subtasks right after their parent), then done tasks by completion time. */
    tasks: Readable<Task[]>;
    add(
        title: string,
        opts?: { afterId?: string | null; parent?: string; due?: string; allDay?: boolean; source?: LinkTarget },
    ): string;
    update(id: string, patch: Partial<Omit<Task, 'id' | 'pos'>>): void;
    setDone(id: string, done: boolean): void;
    move(id: string, beforeId: string | null, afterId: string | null): void;
    remove(id: string): void;
    removeDone(): void;
    release(): void;
}

function readTask(id: string, m: YRec): Task {
    let source: LinkTarget | null = null;
    const raw = m.get('source');
    if (typeof raw === 'string' && raw) {
        try {
            source = JSON.parse(raw) as LinkTarget;
        } catch {
            source = null;
        }
    }
    return {
        id,
        title: String(m.get('title') ?? ''),
        notes: String(m.get('notes') ?? ''),
        done: Boolean(m.get('done') ?? false),
        doneAt: Number(m.get('doneAt') ?? 0),
        due: String(m.get('due') ?? ''),
        allDay: Boolean(m.get('allDay') ?? true),
        flagged: Boolean(m.get('flagged') ?? false),
        priority: (Number(m.get('priority') ?? 0) as Priority) || 0,
        pos: String(m.get('pos') ?? 'a0'),
        parent: String(m.get('parent') ?? ''),
        source,
    };
}

/** Open tasks in tree order (children under their parent), then the done ones. */
export function sortTasks(all: Task[]): Task[] {
    const open = all.filter((t) => !t.done);
    const children = new Map<string, Task[]>();
    for (const t of open) children.set(t.parent, [...(children.get(t.parent) ?? []), t]);
    const out: Task[] = [];
    const walk = (parent: string) => {
        for (const t of (children.get(parent) ?? []).sort(byPos)) {
            out.push(t);
            walk(t.id);
        }
    };
    walk('');
    // Orphans (parent done or gone) still show, at the end of the open ones.
    for (const t of open) if (!out.includes(t)) out.push(t);
    return [...out, ...all.filter((t) => t.done).sort((a, b) => a.doneAt - b.doneAt)];
}

export function openList(id: string, index?: Index): List {
    const doc = openDoc(base, `list:${id}`);
    const tasks = doc.doc.getMap<YRec>('tasks');
    const readAll = () => {
        const out: Task[] = [];
        tasks.forEach((m, tid) => out.push(readTask(tid, m)));
        return sortTasks(out);
    };
    const siblings = (parent: string) =>
        readAll()
            .filter((t) => !t.done && t.parent === parent)
            .sort(byPos);
    const touched = () => index?.update(id, { open: readAll().filter((t) => !t.done).length });

    return {
        doc,
        tasks: yStore(tasks, readAll),
        add(title, opts = {}) {
            const tid = newId();
            const parent = opts.parent ?? '';
            const sib = siblings(parent);
            const at = opts.afterId ? sib.findIndex((t) => t.id === opts.afterId) : sib.length - 1;
            const before = at >= 0 ? (sib[at]?.pos ?? null) : null;
            const after = at + 1 < sib.length ? sib[at + 1].pos : null;
            doc.doc.transact(() => {
                const m = new Y.Map<string | number | boolean>();
                m.set('title', title);
                m.set('notes', '');
                m.set('done', false);
                m.set('doneAt', 0);
                m.set('due', opts.due ?? '');
                m.set('allDay', opts.allDay ?? true);
                m.set('flagged', false);
                m.set('priority', 0);
                m.set('pos', generateKeyBetween(before, after));
                m.set('parent', parent);
                m.set('source', opts.source ? JSON.stringify(opts.source) : '');
                tasks.set(tid, m);
            });
            touched();
            return tid;
        },
        update(tid, patch) {
            const m = tasks.get(tid);
            if (!m) return;
            doc.doc.transact(() => {
                for (const [k, v] of Object.entries(patch)) {
                    if (v === undefined) continue;
                    m.set(k, k === 'source' ? (v ? JSON.stringify(v) : '') : (v as string | number | boolean));
                }
            });
            touched();
        },
        setDone(tid, done) {
            const m = tasks.get(tid);
            if (!m) return;
            doc.doc.transact(() => {
                m.set('done', done);
                m.set('doneAt', done ? Date.now() : 0);
                if (!done) {
                    const last = siblings(String(m.get('parent') ?? '')).pop()?.pos ?? null;
                    m.set('pos', generateKeyBetween(last, null));
                }
            });
            touched();
        },
        move(tid, beforeId, afterId) {
            const m = tasks.get(tid);
            if (!m) return;
            const pos = (x: string | null) => (x ? String(tasks.get(x)?.get('pos') ?? '') || null : null);
            m.set('pos', generateKeyBetween(pos(beforeId), pos(afterId)));
            touched();
        },
        remove(tid) {
            doc.doc.transact(() => {
                tasks.delete(tid);
                // Subtasks go with their parent.
                for (const t of readAll()) if (t.parent === tid) tasks.delete(t.id);
            });
            touched();
        },
        removeDone() {
            doc.doc.transact(() => {
                for (const t of readAll()) if (t.done) tasks.delete(t.id);
            });
            touched();
        },
        release: () => doc.release(),
    };
}

// ---------- dates ----------

/** Today's ISO date in the device's time zone. */
export function todayIso(d = new Date()): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'overdue' | 'today' | 'tomorrow' | 'later' | 'none', from the device's clock. */
export function dueState(task: Task, now = new Date()): 'overdue' | 'today' | 'tomorrow' | 'later' | 'none' {
    if (!task.due) return 'none';
    const today = todayIso(now);
    const tomorrow = todayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    const day = task.due.slice(0, 10);
    if (day < today) return 'overdue';
    if (day === today) {
        if (!task.allDay && new Date(task.due).getTime() < now.getTime()) return 'overdue';
        return 'today';
    }
    if (day === tomorrow) return 'tomorrow';
    return 'later';
}

export function formatDue(task: Task, now = new Date()): string {
    if (!task.due) return '';
    const state = dueState(task, now);
    const d = new Date(task.allDay ? `${task.due.slice(0, 10)}T12:00:00` : task.due);
    const time = task.allDay ? '' : ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (state === 'today') return 'Today' + time;
    if (state === 'tomorrow') return 'Tomorrow' + time;
    const sameYear = d.getFullYear() === now.getFullYear();
    return (
        d.toLocaleDateString([], {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            ...(sameYear ? {} : { year: 'numeric' }),
        }) + time
    );
}
