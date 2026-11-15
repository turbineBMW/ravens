<script lang="ts">
    import { getContext, onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/state';
    import EditorBar from '$lib/EditorBar.svelte';
    import NoteEditor from '$lib/NoteEditor.svelte';
    import NoteSession from '$lib/NoteSession.svelte';
    import { type Index } from '$lib/notes';
    import { listHref, noteHref, scopeOf } from '$lib/scope';

    const index = getContext<Index>('index');
    const notes = index.notes;
    const synced = index.doc.synced;
    let ready = $state(false);
    let loadError = $state(false);
    const entry = $derived($notes.find((n) => n.id === page.params.id));
    const scope = $derived(scopeOf(page.url));
    const back = $derived(listHref(scope));
    onMount(() => {
        void index.doc.whenLocal.then(
            () => {
                ready = true;
            },
            () => {
                loadError = true;
            },
        );
    });

    function deleteList() {
        if (!entry) return;
        index.remove(entry.id);
        void goto(back);
    }
</script>

{#if !loadError && ready && entry && !entry.deletedAt}
    {#key entry.id}
        <NoteSession id={entry.id} {index} {back} ondelete={deleteList}>
            {#snippet children(note)}<NoteEditor {note} id={entry.id} />{/snippet}
        </NoteSession>
    {/key}
{:else}
    <EditorBar {back} />
    <div class="editor-body">
        {#if loadError}
            <p role="alert">Could not open local storage. Reload to try again.</p>
        {:else if !ready}
            <p role="status">Loading your library…</p>
        {:else if entry?.deletedAt}
            <div class="workspace-empty">
                <h2>{entry.title || 'Untitled note'}</h2>
                <p class="muted">This note is in Recently Deleted.</p>
                <button
                    class="btn primary"
                    type="button"
                    onclick={() => {
                        if (entry) {
                            index.restore(entry.id);
                            void goto(noteHref(entry.id, { kind: 'all' }));
                        }
                    }}>Restore note</button
                >
            </div>
        {:else}
            <div class="workspace-empty">
                <h2>{$synced ? 'Note not found' : 'Note unavailable on this device'}</h2>
                <p class="muted">
                    {$synced
                        ? 'It may have been removed. Check Recently Deleted in the library.'
                        : 'Reconnect to load your library and try again.'}
                </p>
            </div>
        {/if}
    </div>
{/if}
