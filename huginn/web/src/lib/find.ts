/**
 * Finding text in a note: case and accents don't matter, as in search, so
 * "cafe" finds "Café". Matches are reported in the original text's offsets,
 * so they can be highlighted where they are.
 */

/** The text folded for comparing, and for each folded unit the span of the original it came from. */
export function fold(text: string): { folded: string; starts: number[]; ends: number[] } {
    let folded = '';
    const starts: number[] = [];
    const ends: number[] = [];
    let at = 0;
    for (const char of text) {
        const end = at + char.length;
        const plain = /\s/u.test(char)
            ? ' '
            : char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
        for (let i = 0; i < plain.length; i++) {
            starts.push(at);
            ends.push(end);
        }
        folded += plain;
        at = end;
    }
    return { folded, starts, ends };
}

/** Where `query` is in `text`, as [start, end) offsets, left to right and not overlapping. */
export function findIn(text: string, query: string): [number, number][] {
    const needle = fold(query).folded;
    if (!needle || !text) return [];
    const { folded, starts, ends } = fold(text);
    const found: [number, number][] = [];
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
        found.push([starts[at], ends[at + needle.length - 1]]);
    }
    return found;
}

/** What the count beside the find field says. */
export function matchCount(current: number, total: number): string {
    if (!total) return 'No matches';
    return `${current + 1} of ${total}`;
}

/** What a note's checklist blocks are told: what's being looked for, and which item is current. */
export interface Found {
    query: string;
    list: string | null;
    item: string | null;
    /** Goes up each time the current match is brought into view on purpose. */
    shown: number;
}
