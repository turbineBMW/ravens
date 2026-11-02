<script lang="ts">
    // A checklist block in the body: the same list, driven by the items map it names.
    import Checklist from '$lib/Checklist.svelte';
    import type { Note } from '$lib/notes';

    let { note, id, list }: { note: Note; id: string; list: string } = $props();
    const model = $derived(note.list(list));
    const items = $derived(model.items);
    const title = $derived(note.title);
</script>

<Checklist items={$items} note={model} noteId={id} noteTitle={$title} />
