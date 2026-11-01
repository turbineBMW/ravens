<script lang="ts">
    import { onMount, untrack, type Snippet } from 'svelte';
    import EditorBar from '$lib/EditorBar.svelte';
    import NoteActions from '$lib/NoteActions.svelte';
    import { openNote, type Index, type Note } from '$lib/notes';

    let {
        id,
        index,
        back,
        ondelete,
        children,
    }: { id: string; index: Index; back: string; ondelete: () => void; children: Snippet<[Note]> } = $props();
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
    const connection = $derived.by(() => {
        if (error) return 'Could not load this note from local storage.';
        if (!local) return 'Loading this note…';
        if ($status === 'online') return $synced ? 'Connected' : 'Receiving changes…';
        if ($status === 'connecting') return 'Connecting…';
        return 'Offline · reconnect to sync';
    });
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

<EditorBar {back} subtitle={connection}>
    {#if available}
        <input
            class="headerbar-input"
            type="text"
            placeholder="Title"
            aria-label="Note title"
            value={$title}
            autocomplete="off"
            oninput={(e) => note.setTitle(e.currentTarget.value)}
        />
    {/if}
    {#snippet actions()}
        {#if available}<NoteActions {note} {id} {ondelete} />{/if}
    {/snippet}
</EditorBar>
<div class="editor-body">
    {#if available}
        {@render children(note)}
    {:else if local}
        <div class="workspace-empty">
            <h2>Waiting for this note</h2>
            <p class="muted">Its content is not downloaded on this device yet. Connect to the server to open it.</p>
        </div>
    {/if}
</div>
