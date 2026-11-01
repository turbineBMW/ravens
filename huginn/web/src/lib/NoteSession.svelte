<script lang="ts">
    import { onMount, untrack, type Snippet } from 'svelte';
    import { openNote, type Index, type Note } from '$lib/notes';

    let { id, index, children }: { id: string; index: Index; children: Snippet<[Note]> } = $props();
    // The parent keys this session by note ID; resizing never remounts it.
    const note = untrack(() => openNote(id, index));
    const status = note.doc.status;
    const synced = note.doc.synced;
    const title = note.title;
    const items = note.items;
    let local = $state(false);
    let received = $state(false);
    $effect(() => {
        if ($synced) received = true;
    });
    let error = $state(false);
    const available = $derived(
        local && (received || !!$title || $items.length > 0 || note.doc.doc.getMap('meta').has('title')),
    );
    onMount(() => {
        let live = true;
        note.doc.whenLocal.then(
            () => {
                if (live) local = true;
            },
            () => {
                if (live) error = true;
            },
        );
        return () => {
            live = false;
            note.release();
        };
    });
</script>

<p class="note-connection small muted" role="status">
    {#if error}Could not load this note from local storage.
    {:else if !local}Loading this note…
    {:else if $status === 'online'}Note connected{$synced ? '' : ' · receiving changes…'}
    {:else if $status === 'connecting'}Note connecting…
    {:else}Note offline · reconnect to sync{/if}
</p>
{#if available}
    {@render children(note)}
{:else if local}
    <div class="workspace-empty">
        <h2>Waiting for this note</h2>
        <p class="muted">Its content is not downloaded on this device yet. Connect to the server to open it.</p>
    </div>
{/if}
