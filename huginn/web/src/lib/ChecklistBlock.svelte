<script lang="ts">
    // A checklist block in the body: the same list, driven by the items map it names.
    import { getContext } from 'svelte';
    import { readable, type Readable } from 'svelte/store';
    import Checklist from '$lib/Checklist.svelte';
    import type { Found } from '$lib/find';
    import type { Note } from '$lib/notes';

    let { note, id, list }: { note: Note; id: string; list: string } = $props();
    const model = $derived(note.list(list));
    const items = $derived(model.items);
    const title = $derived(note.title);
    // What find in note is looking for, from the editor this block is in.
    const found =
        getContext<Readable<Found> | undefined>('find') ?? readable({ query: '', list: null, item: null, shown: 0 });
</script>

<Checklist
    items={$items}
    note={model}
    noteId={id}
    noteTitle={$title}
    findQuery={$found.query}
    findCurrent={$found.list === list ? $found.item : null}
    findShown={$found.shown}
/>
