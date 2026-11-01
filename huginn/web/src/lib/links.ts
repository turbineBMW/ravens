/**
 * The Huginn side of the Huginn ↔ Muninn link. "Remind me" is a deep link
 * into Muninn's new-reminder page carrying a LinkTarget back to this note
 * (and item); the reminders a note already has come from Muninn's API on
 * the same origin, under the same Tailscale identity.
 */
import type { LinkTarget } from '@ravens/ui/api';

export interface Reminder {
    list_id: string;
    id: string;
    title: string;
    done: boolean;
    due: string;
    fragment?: string;
}

export function remindMeHref(noteId: string, title: string, fragment?: string, due?: string): string {
    const source: LinkTarget = { app: 'huginn', id: noteId, ...(fragment ? { fragment } : {}) };
    const q = new URLSearchParams({ title, source: JSON.stringify(source) });
    if (due) q.set('due', due);
    return `/muninn/new?${q}`;
}

export async function remindersFor(noteId: string): Promise<Reminder[]> {
    const res = await fetch(`/muninn/v1/links?${new URLSearchParams({ app: 'huginn', id: noteId })}`, {
        headers: { accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`muninn ${res.status}`);
    return (await res.json()) as Reminder[];
}

export function reminderHref(r: Reminder): string {
    return `/muninn/l/${r.list_id}`;
}
