<script lang="ts">
    // The body's checklist block: the same list, driven by the note's items map.
    import Checklist from '$lib/Checklist.svelte';
    import type { Note } from '$lib/notes';

    let { note, id }: { note: Note; id: string } = $props();
    const items = $derived(note.items);
    const title = $derived(note.title);
</script>

<Checklist items={$items} {note} noteId={id} noteTitle={$title} />
