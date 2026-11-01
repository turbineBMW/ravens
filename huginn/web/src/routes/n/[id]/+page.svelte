<script lang="ts">
    import { getContext } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { page } from '$app/state';
    import NoteEditor from '$lib/NoteEditor.svelte';
    import { openNote, type Index, type Note } from '$lib/notes';

    const index = getContext<Index>('index');

    let note = $state<Note | null>(null);

    // The route's id can change while this component stays mounted (back/forward).
    $effect(() => {
        const id = page.params.id;
        if (!id) return;
        const n = openNote(id, index);
        note = n;
        return () => {
            n.release();
            if (note === n) note = null;
        };
    });

    function deleteList() {
        const id = page.params.id;
        if (!id) return;
        index.remove(id);
        void goto(`${base}/`);
    }
</script>

{#if note}
    <NoteEditor {note} id={page.params.id ?? ''} ondelete={deleteList} />
{/if}
