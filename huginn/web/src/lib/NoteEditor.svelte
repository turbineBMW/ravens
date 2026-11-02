<script lang="ts">
    import { onMount } from 'svelte';
    import { remindersFor, reminderHref, type Reminder } from '$lib/links';
    import type { Note } from '$lib/notes';

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
</article>
