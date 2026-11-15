/**
 * Links between notes (format 5). A link is an inline `noteLink` node naming
 * a note, and optionally a section (heading) in it. Without a label of its own
 * it shows the note's title as it is now, so renaming a note renames its
 * links; a section link adds the heading as it was when the link was made.
 * Links name notes by ID, so moving a note between folders keeps them working.
 *
 * Typing `[[` suggests notes by title, and `[[#` this note's headings. A
 * Huginn note URL, as "Copy link" puts on the clipboard, pastes as a link.
 * The server lists every note's links (huginn/server/src/links.rs) for
 * showing the notes that link to one.
 */
import { writable, type Writable } from 'svelte/store';
import { api } from '$lib/api';
import { fold } from '$lib/find';
import type { NoteMeta } from '$lib/notes';

export interface LinkAttrs {
    note: string;
    /** A heading's section ID, or '' for the top of the note. */
    section: string;
    /** That heading's text when the link was made. */
    heading: string;
    /** What the link says instead of the note's title; '' to follow the title. */
    label: string;
}

/**
 * What a link to a note in this state says, and whether it's live, deleted or
 * missing. `here`: the link is in the note it points at, so a section link
 * says only its heading.
 */
export function linkText(
    attrs: Pick<LinkAttrs, 'section' | 'heading' | 'label'>,
    target: Pick<NoteMeta, 'title' | 'deletedAt'> | undefined,
    here = false,
): { text: string; state: 'live' | 'deleted' | 'missing' } {
    const state = !target ? 'missing' : target.deletedAt ? 'deleted' : 'live';
    if (attrs.label.trim()) return { text: attrs.label.trim(), state };
    const title = target ? target.title.trim() || 'Untitled note' : 'Missing note';
    const heading = attrs.section ? attrs.heading.trim() || 'Section' : '';
    if (here && heading) return { text: heading, state };
    return { text: heading ? `${title} › ${heading}` : title, state };
}

/**
 * A link Huginn made, read back from its URL: `…/huginn/n/<id>` with
 * `#section-<id>` for a section. Only this origin's, under this base.
 */
export function parseNoteUrl(text: string, origin: string, base: string): { note: string; section: string } | null {
    let url: URL;
    try {
        url = new URL(text.trim());
    } catch {
        return null;
    }
    if (url.origin !== origin) return null;
    const m = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/n/([A-Za-z0-9_-]+)/?$`).exec(url.pathname);
    if (!m) return null;
    const hash = decodeURIComponent(url.hash.slice(1));
    return { note: m[1], section: hash.startsWith('section-') ? hash.slice('section-'.length) : '' };
}

/**
 * The link being typed at the end of `before` (the text up to the caret):
 * what follows its `[[`, or null when the caret isn't in one. It ends at a
 * line's end or a bracket, and is at most 100 characters.
 */
export function partialLink(before: string): string | null {
    const m = /\[\[([^[\]\n]{0,100})$/u.exec(before);
    return m ? m[1] : null;
}

/** At most this many suggestions at once. */
export const MAX_LINK_SUGGESTIONS = 6;

/**
 * Notes to suggest for what's been typed: titles starting with it, then
 * containing it, each most recently edited first; with nothing typed, the most
 * recently edited. Deleted notes and `except` (the note being written) are left out.
 */
export function suggestNotes(notes: NoteMeta[], typed: string, except: string): NoteMeta[] {
    const q = fold(typed.trim()).folded;
    const live = notes
        .filter((n) => !n.deletedAt && n.id !== except)
        .sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    const titled = live.map((n) => ({ n, t: fold(n.title.trim() || 'Untitled note').folded }));
    const starting = titled.filter(({ t }) => t.startsWith(q));
    const containing = q ? titled.filter(({ t }) => !t.startsWith(q) && t.includes(q)) : [];
    return [...starting, ...containing].slice(0, MAX_LINK_SUGGESTIONS).map(({ n }) => n);
}

/** Headings to suggest after `[[#`: those starting with what's typed, then containing it, in order. */
export function suggestHeadings<T extends { text: string }>(headings: T[], typed: string): T[] {
    const q = fold(typed.trim()).folded;
    const folded = headings.filter((h) => h.text.trim()).map((h) => ({ h, t: fold(h.text.trim()).folded }));
    const starting = folded.filter(({ t }) => t.startsWith(q));
    const containing = q ? folded.filter(({ t }) => !t.startsWith(q) && t.includes(q)) : [];
    return [...starting, ...containing].slice(0, MAX_LINK_SUGGESTIONS).map(({ h }) => h);
}

// ---------- every link in the library, from the server, for backlinks ----------

/** One link: the note it's in and the heading it's under there, and what it points at. */
export interface LibraryLink {
    note: string;
    section?: string;
    target: string;
    target_section?: string;
}

/** The notes linking to `id`, once each, at the first place each does; never `id` itself. */
export function backlinksOf(all: LibraryLink[], id: string): { note: string; section: string }[] {
    const seen = new Set<string>();
    const out: { note: string; section: string }[] = [];
    for (const link of all) {
        if (link.target !== id || link.note === id || seen.has(link.note)) continue;
        seen.add(link.note);
        out.push({ note: link.note, section: link.section ?? '' });
    }
    return out;
}

const CACHE_KEY = 'huginn.links';

function cached(): LibraryLink[] {
    try {
        const list = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/** Every link, as last fetched; cached on this device so backlinks show offline. */
export const libraryLinks: Writable<LibraryLink[]> = writable(typeof localStorage === 'undefined' ? [] : cached());

let pending: Promise<void> | null = null;
/** Fetch the links again; overlapping calls share one request. */
export function refreshLinks(): Promise<void> {
    pending ??= api
        .request<LibraryLink[]>('/links')
        .then(
            (list) => {
                libraryLinks.set(list);
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
                } catch {
                    /* It still applies for this visit. */
                }
            },
            () => undefined,
        )
        .finally(() => (pending = null));
    return pending;
}
