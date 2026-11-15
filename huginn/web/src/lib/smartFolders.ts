/**
 * Smart Folders: saved filters. Each is a name, whether a note must match all
 * of its conditions or any, and the conditions. They're kept in the index
 * document (notes.ts) and worked out here from what the index and the tag
 * list already know, so they show offline and never open a note.
 */
import type { NoteMeta } from '$lib/notes';
import type { AttachmentKind } from '$lib/thumbs';

/** Any attachment, or one kind of them. */
export type AttachmentFilter = 'any' | AttachmentKind;
const ATTACHMENT_FILTERS: AttachmentFilter[] = ['any', 'image', 'video', 'pdf', 'file', 'link'];

export type Condition =
    | { kind: 'tag'; has: boolean; tag: string }
    | { kind: 'folder'; within: boolean; folder: string }
    | { kind: 'edited' | 'created'; within: boolean; days: number }
    | { kind: 'checklist'; state: 'open' | 'done' | 'none' }
    | { kind: 'pinned'; pinned: boolean }
    | { kind: 'attachments'; has: boolean; of: AttachmentFilter };

export interface SmartFolder {
    id: string;
    name: string;
    /** A note must match every condition, or at least one. */
    match: 'all' | 'any';
    conditions: Condition[];
    created: number;
}

const DAY = 24 * 60 * 60 * 1000;

/** Conditions as stored: anything unreadable or unknown is dropped, so a newer client's never breaks this one. */
export function readConditions(json: string): Condition[] {
    let list: unknown;
    try {
        list = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(list)) return [];
    return list.flatMap((c): Condition[] => {
        if (!c || typeof c !== 'object') return [];
        const o = c as Record<string, unknown>;
        switch (o.kind) {
            case 'tag':
                return typeof o.tag === 'string' && o.tag ? [{ kind: 'tag', has: o.has !== false, tag: o.tag }] : [];
            case 'folder':
                return typeof o.folder === 'string'
                    ? [{ kind: 'folder', within: o.within !== false, folder: o.folder }]
                    : [];
            case 'edited':
            case 'created': {
                const days = Number(o.days);
                return days > 0 ? [{ kind: o.kind, within: o.within !== false, days: Math.round(days) }] : [];
            }
            case 'checklist':
                return o.state === 'open' || o.state === 'done' || o.state === 'none'
                    ? [{ kind: 'checklist', state: o.state }]
                    : [];
            case 'pinned':
                return [{ kind: 'pinned', pinned: o.pinned !== false }];
            case 'attachments':
                return [
                    {
                        kind: 'attachments',
                        has: o.has !== false,
                        of: ATTACHMENT_FILTERS.includes(o.of as AttachmentFilter) ? (o.of as AttachmentFilter) : 'any',
                    },
                ];
            default:
                return [];
        }
    });
}

/** What a condition needs to know beyond the note itself. */
export interface Context {
    now: number;
    /** Each tag's notes, by key. */
    tagNotes: Map<string, Set<string>>;
    /** The folder a note shows in ('' at the top level). */
    placeOf: (note: NoteMeta) => string;
    /** A live folder and the folders inside it; empty for one that's gone. */
    within: (folder: string) => Set<string>;
    /** Each note's kinds of attachment (attachments.ts); a note with none isn't in it. */
    attachmentKinds: Map<string, Set<AttachmentKind>>;
}

export function holds(c: Condition, note: NoteMeta, ctx: Context): boolean {
    switch (c.kind) {
        case 'tag':
            return (ctx.tagNotes.get(c.tag)?.has(note.id) ?? false) === c.has;
        case 'folder':
            // The top level is '' and has nothing inside it but itself.
            return (c.folder ? ctx.within(c.folder).has(ctx.placeOf(note)) : ctx.placeOf(note) === '') === c.within;
        case 'edited':
        case 'created':
            return ctx.now - (c.kind === 'edited' ? note.updated : note.created) <= c.days * DAY === c.within;
        case 'checklist':
            return c.state === 'open'
                ? note.open > 0
                : c.state === 'done'
                  ? note.open === 0 && note.done > 0
                  : note.open + note.done === 0;
        case 'pinned':
            return note.pinned === c.pinned;
        case 'attachments': {
            const kinds = ctx.attachmentKinds.get(note.id);
            const has = c.of === 'any' ? !!kinds?.size : (kinds?.has(c.of) ?? false);
            return has === c.has;
        }
    }
}

/** Whether a note belongs in a Smart Folder. One with no conditions holds nothing. */
export function matches(folder: SmartFolder, note: NoteMeta, ctx: Context): boolean {
    if (note.deletedAt || !folder.conditions.length) return false;
    return folder.match === 'all'
        ? folder.conditions.every((c) => holds(c, note, ctx))
        : folder.conditions.some((c) => holds(c, note, ctx));
}

/**
 * Conditions after tag `from` is renamed to `to`, or, with `to` empty,
 * deleted: renamed tags follow, deleted ones are dropped. Null when nothing changes.
 */
export function retagConditions(conditions: Condition[], from: string, to: string): Condition[] | null {
    if (!conditions.some((c) => c.kind === 'tag' && c.tag === from)) return null;
    return conditions.flatMap((c) => (c.kind !== 'tag' || c.tag !== from ? [c] : to ? [{ ...c, tag: to }] : []));
}

/** A condition in words, for the editor and the row's tooltip. */
export function describe(c: Condition, tagName: (key: string) => string, folderName: (id: string) => string): string {
    switch (c.kind) {
        case 'tag':
            return `${c.has ? 'Tagged' : 'Not tagged'} #${tagName(c.tag)}`;
        case 'folder':
            return `${c.within ? 'In' : 'Not in'} ${c.folder ? folderName(c.folder) : 'no folder'}`;
        case 'edited':
        case 'created':
            return `${c.within ? '' : 'Not '}${c.within ? (c.kind === 'edited' ? 'Edited' : 'Created') : c.kind} in the last ${c.days} ${c.days === 1 ? 'day' : 'days'}`;
        case 'checklist':
            return c.state === 'open'
                ? 'Has unchecked items'
                : c.state === 'done'
                  ? 'Every item checked'
                  : 'No checklist items';
        case 'pinned':
            return c.pinned ? 'Pinned' : 'Not pinned';
        case 'attachments': {
            const what = {
                any: 'attachments',
                image: 'images',
                video: 'videos',
                pdf: 'PDFs',
                file: 'other files',
                link: 'links',
            }[c.of];
            return `${c.has ? 'Has' : 'Has no'} ${what}`;
        }
    }
}
