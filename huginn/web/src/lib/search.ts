/**
 * Searching note text on the server (huginn/server/src/search.rs), which has
 * every note, including ones this device has never opened.
 */
import { api } from '$lib/api';

export interface SearchHit {
    note: string;
    /** The heading the best line is under, to open the note there. */
    section?: string;
    /** That line around the match, with matches between MARK_START and MARK_END. */
    snippet: string;
}

export const MARK_START = '\u0001';
export const MARK_END = '\u0002';
/** Shorter searches match titles only: one letter would match nearly every note. */
export const MIN_SEARCH = 2;

export function searchNotes(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
    return api.request<SearchHit[]>(`/search?q=${encodeURIComponent(query)}`, { signal });
}

/** A snippet as plain and matched parts, to show matches without inserting HTML. */
export function snippetParts(snippet: string): { text: string; match: boolean }[] {
    const parts: { text: string; match: boolean }[] = [];
    let match = false;
    let text = '';
    for (const ch of snippet) {
        if (ch === MARK_START || ch === MARK_END) {
            if (text) parts.push({ text, match });
            text = '';
            match = ch === MARK_START;
        } else text += ch;
    }
    if (text) parts.push({ text, match });
    return parts;
}
