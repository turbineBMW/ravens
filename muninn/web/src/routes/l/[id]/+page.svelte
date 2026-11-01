<script lang="ts">
    import { getContext } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { page } from '$app/state';
    import ListEditor from '$lib/ListEditor.svelte';
    import { openList, type Index, type List } from '$lib/tasks';

    const index = getContext<Index>('index');
    let list = $state<List | null>(null);

    $effect(() => {
        const id = page.params.id;
        if (!id) return;
        const l = openList(id, index);
        list = l;
        return () => {
            l.release();
            if (list === l) list = null;
        };
    });

    function remove() {
        const id = page.params.id;
        if (!id) return;
        index.remove(id);
        void goto(`${base}/`);
    }
</script>

{#if list && page.params.id}
    <ListEditor {list} id={page.params.id} {index} ondelete={remove} />
{/if}
