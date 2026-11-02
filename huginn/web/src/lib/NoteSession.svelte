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
    const save = note.doc.save;
    const outdated = note.doc.outdated;
    const tooNew = note.tooNew;
    const format = note.format;
    const firstLine = note.firstLine;
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
    const editable = $derived(available && $format > 0 && !$tooNew);
    $effect(() => {
        if (local) note.migrate($synced);
    });
    // Once the server's copy has arrived, the note can correct its index entry.
    let repaired = false;
    $effect(() => {
        if (local && $synced && !repaired) {
            repaired = true;
            note.repairIndex();
        }
    });
    const connection = $derived.by(() => {
        if (error) return 'Could not load this note from local storage.';
        if (!local) return 'Loading this note…';
        if ($outdated) return 'Update required · close and reopen Huginn';
        if ($save === 'failed') return "Server couldn't save · retrying";
        if ($status === 'online') {
            if (!$synced) return 'Receiving changes…';
            if ($save === 'saved') return 'Saved';
            return $save === 'pending' ? 'Saving…' : 'Connected';
        }
        if ($save === 'pending') return 'Offline · changes waiting to sync';
        if ($status === 'connecting') return 'Connecting…';
        return $save === 'saved' ? 'Offline' : 'Offline · reconnect to sync';
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
    {#if editable}
        <input
            class="headerbar-input"
            type="text"
            placeholder={$firstLine || 'Title'}
            aria-label="Note title"
            value={$title}
            autocomplete="off"
            oninput={(e) => note.setTitle(e.currentTarget.value)}
        />
    {/if}
    {#snippet actions()}
        {#if editable}<NoteActions {note} {id} {ondelete} />{/if}
    {/snippet}
</EditorBar>
<div class="editor-body">
    {#if editable}
        {@render children(note)}
    {:else if available && $tooNew}
        <div class="workspace-empty">
            <h2>{$title || 'Untitled note'}</h2>
            <p class="muted">A newer version of Huginn saved this note. Close and reopen the app to update it.</p>
        </div>
    {:else if local}
        <div class="workspace-empty">
            <h2>Waiting for this note</h2>
            <p class="muted">Its content is not downloaded on this device yet. Connect to the server to open it.</p>
        </div>
    {/if}
</div>
