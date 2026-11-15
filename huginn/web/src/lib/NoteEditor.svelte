<script lang="ts">
    import { getContext, onMount } from 'svelte';
    import { page } from '$app/state';
    import { remindersFor, reminderHref, type Reminder } from '$lib/links';
    import { backlinksOf, libraryLinks, refreshLinks } from '$lib/noteLinks';
    import type { Index, Note } from '$lib/notes';
    import { noteHref, scopeOf } from '$lib/scope';

    let { note, id }: { note: Note; id: string } = $props();

    // The editor is its own chunk; the service worker keeps it for offline use.
    const editor = import('$lib/RichEditor.svelte');

    // Reminders Muninn holds for this note (best effort: Muninn may be down).
    let reminders = $state<Reminder[]>([]);
    let remindersKnown = $state(false);
    onMount(() => {
        let gone = false;
        remindersFor(id).then(
            (r) => {
                if (gone) return;
                reminders = r;
                remindersKnown = true;
            },
            () => undefined,
        );
        return () => (gone = true);
    });
    const openReminders = $derived(reminders.filter((r) => !r.done));

    // The notes linking to this one, as the server last listed them, leaving out deleted ones.
    const libraryNotes = getContext<Index>('index').notes;
    onMount(() => void refreshLinks());
    const backlinks = $derived.by(() => {
        const live = new Map($libraryNotes.filter((n) => !n.deletedAt).map((n) => [n.id, n]));
        return backlinksOf($libraryLinks, id).flatMap(({ note: from, section }) => {
            const entry = live.get(from);
            if (!entry) return [];
            const href = noteHref(from, scopeOf(page.url), section || undefined);
            return [{ id: from, href, title: entry.title.trim() || 'Untitled note' }];
        });
    });
</script>

<article class="note">
    {#if openReminders.length}
        <p class="reminders small">
            ⏰
            {#each openReminders as r, i (r.id)}
                {#if i > 0}·{/if}
                <a href={reminderHref(r)}>{r.title}{r.due ? ` (${r.due.slice(0, 10)})` : ''}</a>
            {/each}
        </p>
    {/if}
    {#await editor}
        <p class="muted" role="status">Opening the editor…</p>
    {:then { default: RichEditor }}
        <RichEditor {note} {id} />
    {:catch}
        <p role="alert">Could not load the editor. Reconnect and reopen Huginn.</p>
    {/await}
    {#if backlinks.length}
        <p class="backlinks small">
            <span class="muted">Linked from</span>
            {#each backlinks as link, i (link.id)}
                {#if i > 0}·{/if}
                <a href={link.href}>{link.title}</a>
            {/each}
        </p>
    {/if}
</article>
