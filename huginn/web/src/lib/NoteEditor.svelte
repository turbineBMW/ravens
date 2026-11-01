<script lang="ts">
    import { onMount } from 'svelte';
    import Checklist from '$lib/Checklist.svelte';
    import { remindMeHref, remindersFor, reminderHref, type Reminder } from '$lib/links';
    import type { Note } from '$lib/notes';

    let { note, id, ondelete }: { note: Note; id: string; ondelete: () => void } = $props();

    // Top-level store declarations, re-derived when the note changes.
    const title = $derived(note.title);
    const items = $derived(note.items);
    let confirmDelete = $state(false);

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
    <header class="note-head">
        <input
            class="title"
            type="text"
            placeholder="Title"
            aria-label="Note title"
            value={$title}
            autocomplete="off"
            oninput={(e) => note.setTitle(e.currentTarget.value)}
        />
        <details class="menu">
            <summary class="btn" aria-label="List actions">⋯</summary>
            <div class="sheet actions">
                <a class="btn" href={remindMeHref(id, $title || 'Untitled list')}>Remind me about this list…</a>
                <button class="btn" type="button" onclick={() => note.uncheckAll()}>Uncheck all</button>
                <button class="btn" type="button" onclick={() => note.removeChecked()}>Delete checked items</button>
                {#if confirmDelete}
                    <button class="btn danger" type="button" onclick={ondelete}>Move to Recently Deleted</button>
                    <button class="btn" type="button" onclick={() => (confirmDelete = false)}>Keep it</button>
                {:else}
                    <button class="btn" type="button" onclick={() => (confirmDelete = true)}>Delete list…</button>
                {/if}
            </div>
        </details>
    </header>
    {#if openReminders.length}
        <p class="reminders small">
            ⏰
            {#each openReminders as r, i (r.id)}
                {#if i > 0}·{/if}
                <a href={reminderHref(r)}>{r.title}{r.due ? ` (${r.due.slice(0, 10)})` : ''}</a>
            {/each}
        </p>
    {/if}
    <Checklist items={$items} {note} noteId={id} noteTitle={$title} />
</article>
