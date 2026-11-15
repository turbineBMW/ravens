/**
 * Every attachment in the person's notes, as the server mirrors them from the
 * notes (huginn-server's blobs.rs), the ones this device has never opened
 * included: for the attachments browser and the Smart Folder condition.
 * Cached on this device, as the tags are, so both work offline as of the last
 * connection.
 */
import { writable, type Writable } from 'svelte/store';
import { api } from '$lib/api';
import type { AttachmentKind } from '$lib/thumbs';

export interface AttachmentInfo {
    note: string;
    section?: string;
    blob: string;
    kind: AttachmentKind;
    name: string;
    type: string;
    size: number;
    thumb?: string;
    alt?: string;
    url?: string;
    /** Whether the file has reached the server. */
    stored: boolean;
}

const CACHE_KEY = 'huginn.attachments';

function cached(): AttachmentInfo[] {
    try {
        const list = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

export const libraryAttachments: Writable<AttachmentInfo[]> = writable(
    typeof localStorage === 'undefined' ? [] : cached(),
);

let pending: Promise<void> | null = null;
/** Fetch the list again; overlapping calls share one request. */
export function refreshAttachments(): Promise<void> {
    pending ??= api
        .request<AttachmentInfo[]>('/attachments')
        .then(
            (list) => {
                libraryAttachments.set(list);
                try {
                    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
                } catch {
                    /* It still applies for this visit. */
                }
            },
            () => {},
        )
        .finally(() => (pending = null));
    return pending;
}

/** Each note's kinds of attachment. */
export function kindsByNote(all: AttachmentInfo[]): Map<string, Set<AttachmentKind>> {
    const by = new Map<string, Set<AttachmentKind>>();
    for (const a of all) {
        if (!by.has(a.note)) by.set(a.note, new Set());
        by.get(a.note)!.add(a.kind);
    }
    return by;
}

export const KIND_NAMES: Record<AttachmentKind, string> = {
    image: 'Images',
    video: 'Videos',
    pdf: 'PDFs',
    file: 'Other files',
    link: 'Links',
};
