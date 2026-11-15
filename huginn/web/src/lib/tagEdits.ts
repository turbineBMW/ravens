/**
 * Renaming or deleting a tag in every note written with it. Each note is
 * edited on this device, as typing would, and syncs from here; notes not on
 * this device are fetched first, so this needs a connection.
 */
import { get, type Readable } from 'svelte/store';
import { openNote, type Index } from '$lib/notes';
import { refreshTags, tagFilter, tagKey, type TagInfo } from '$lib/tags';

/** How long to wait for a note's copy on the server before leaving it out. */
const FETCH_MS = 15_000;

function whenTrue(store: Readable<boolean>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        let stop = () => {};
        const timer = setTimeout(() => {
            stop();
            resolve(false);
        }, ms);
        stop = store.subscribe((value) => {
            if (!value) return;
            clearTimeout(timer);
            queueMicrotask(() => stop());
            resolve(true);
        });
    });
}

export interface TagEdit {
    /** Notes the tag was changed in. */
    changed: number;
    /** Notes that couldn't be reached, so still have the old tag. */
    missed: number;
}

/** Rename `tag` to `to` in its notes, or with `to` empty make it a plain word there. */
export async function renameTag(index: Index, tag: TagInfo, to: string): Promise<TagEdit> {
    const result: TagEdit = { changed: 0, missed: 0 };
    for (const id of tag.notes) {
        const note = openNote(id, index);
        try {
            await note.doc.whenLocal;
            if (!(await whenTrue(note.doc.synced, FETCH_MS))) {
                result.missed++;
                continue;
            }
            if (note.renameTag(tag.tag, to)) result.changed++;
        } catch {
            result.missed++;
        } finally {
            note.release();
        }
    }
    // A filter on the old tag follows it.
    const swap = (keys: string[]) =>
        [...new Set(keys.map((k) => (k === tag.tag ? (to ? tagKey(to) : '') : k)))].filter(Boolean);
    const filter = get(tagFilter);
    tagFilter.set({ include: swap(filter.include), exclude: swap(filter.exclude) });
    // The server lists tags from the notes it has, so give the edits a moment to arrive.
    setTimeout(() => void refreshTags(), 1000);
    return result;
}
