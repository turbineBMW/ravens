/**
 * Tags: words written `#like-this` in a note's text. The rule here must match
 * the server's (huginn/server/src/tags.rs), which lists them for every note.
 *
 * A tag starts with `#` at the start of a line or after a space or an opening
 * bracket, and runs over letters, digits, `_` and `-`, at most 64 of them,
 * ending before a trailing `-` or `_`. It needs at least one letter, so `#1`
 * and `#2026` are not tags. Case doesn't matter: `#Work` and `#work` are one tag.
 */
import { writable, type Writable } from 'svelte/store';
import { api } from '$lib/api';

export const MAX_TAG = 64;
const WORD = /^[\p{Alphabetic}\p{N}_-]$/u;
const LETTER = /\p{Alphabetic}/u;

export interface TagMatch {
    /** Where the `#` is, in UTF-16 units, as Yjs and ProseMirror count. */
    at: number;
    /** The tag as written, without `#`. */
    name: string;
}

/** The tags in a piece of text, in order. */
export function tagMatches(text: string): TagMatch[] {
    const found: TagMatch[] = [];
    let i = 0;
    while (i < text.length) {
        const before = i ? text[i - 1] : '';
        if (text[i] === '#' && (!before || /\s/u.test(before) || '([{'.includes(before))) {
            let end = i + 1;
            while (end < text.length) {
                const ch = String.fromCodePoint(text.codePointAt(end)!);
                if (!WORD.test(ch)) break;
                end += ch.length;
            }
            const name = text.slice(i + 1, end).replace(/[-_]+$/u, '');
            if (name && [...name].length <= MAX_TAG && LETTER.test(name)) found.push({ at: i, name });
            i = Math.max(end, i + 1);
        } else i++;
    }
    return found;
}

/** A tag as it's matched: lowercase. */
export const tagKey = (name: string) => name.toLowerCase();

/** What renaming does to a tag's name: the new name, cut to what a tag can be. */
export function cleanTag(name: string): string {
    const match = tagMatches(`#${name.trim().replace(/^#+/u, '')}`)[0];
    return match?.name ?? '';
}

/**
 * Text with tag `from` (a key) renamed to `to`, or, with `to` empty, made a
 * plain word: `#draft` becomes `draft`.
 */
export function retag(text: string, from: string, to: string): string {
    let out = text;
    for (const m of tagMatches(text).reverse()) {
        if (tagKey(m.name) !== from) continue;
        const replacement = to ? `#${to}` : m.name;
        out = out.slice(0, m.at) + replacement + out.slice(m.at + 1 + m.name.length);
    }
    return out;
}

// ---------- the library's tags, from the server ----------

/** One tag and the notes written with it (deleted ones included; the list leaves those out). */
export interface TagInfo {
    tag: string;
    name: string;
    notes: string[];
}

const CACHE_KEY = 'huginn.tags';

function cached(): TagInfo[] {
    try {
        const list = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/** Every tag, as last fetched; cached on this device so the list can filter offline. */
export const tags: Writable<TagInfo[]> = writable(typeof localStorage === 'undefined' ? [] : cached());
/** Whether `tags` came from the server this visit, or is the cache from an earlier one. */
export const tagsFresh = writable(false);

let pending: Promise<void> | null = null;
/** Fetch the tags again; overlapping calls share one request. */
export function refreshTags(): Promise<void> {
    pending ??= api
        .request<TagInfo[]>('/tags')
        .then(
            (list) => {
                tags.set(list);
                tagsFresh.set(true);
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
                } catch {
                    /* It still applies for this visit. */
                }
            },
            () => tagsFresh.set(false),
        )
        .finally(() => (pending = null));
    return pending;
}

// ---------- filtering the notes list ----------

/** Notes must have every tag in `include` and none in `exclude` (keys). */
export interface TagFilter {
    include: string[];
    exclude: string[];
}

export const tagFilter = writable<TagFilter>({ include: [], exclude: [] });

/** Show only notes with this tag, as well as any already chosen. */
export function filterByTag(tag: string) {
    const key = tagKey(tag);
    tagFilter.update((f) => ({
        include: f.include.includes(key) ? f.include : [...f.include, key],
        exclude: f.exclude.filter((t) => t !== key),
    }));
}

// ---------- suggesting tags while one is typed ----------

/**
 * The tag being typed at the end of `before` (the text up to the caret): what
 * follows its `#`, '' right after typing `#`, or null when the caret isn't in one.
 */
export function partialTag(before: string): string | null {
    const m = /(?:^|[\s([{])#([\p{Alphabetic}\p{N}_-]*)$/u.exec(before);
    return m && [...m[1]].length <= MAX_TAG ? m[1] : null;
}

/** At most this many suggestions at once. */
export const MAX_SUGGESTIONS = 6;

/**
 * Tags to suggest for what's been typed: those starting with it, then those
 * containing it, each most used first; with nothing typed yet, the most used.
 * `count` says how many notes each is in (only notes not deleted, say).
 */
export function suggestTags(all: TagInfo[], typed: string, count: (t: TagInfo) => number): TagInfo[] {
    const q = tagKey(typed);
    const used = all.filter((t) => count(t) > 0);
    const rank = (a: TagInfo, b: TagInfo) => count(b) - count(a) || a.tag.localeCompare(b.tag);
    const starting = used.filter((t) => t.tag.startsWith(q)).sort(rank);
    const containing = q ? used.filter((t) => !t.tag.startsWith(q) && t.tag.includes(q)).sort(rank) : [];
    return [...starting, ...containing].slice(0, MAX_SUGGESTIONS);
}
