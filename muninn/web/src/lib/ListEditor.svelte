<script lang="ts">
    import TaskList from '$lib/TaskList.svelte';
    import { LIST_COLORS, type Index, type List } from '$lib/tasks';

    let { list, id, index, ondelete }: { list: List; id: string; index: Index; ondelete: () => void } = $props();

    const tasks = $derived(list.tasks);
    const lists = $derived(index.lists);
    const meta = $derived($lists.find((l) => l.id === id));
    let confirmDelete = $state(false);
</script>

<article class="list">
    <header class="list-head">
        <span class="dot big {meta?.color ?? 'accent'}"></span>
        <input
            class="title"
            type="text"
            placeholder="List name"
            value={meta?.name ?? ''}
            autocomplete="off"
            oninput={(e) => index.update(id, { name: e.currentTarget.value })}
        />
        <details class="menu">
            <summary class="btn" aria-label="List actions">⋯</summary>
            <div class="sheet actions">
                <div class="chips">
                    {#each LIST_COLORS as c}
                        <button
                            type="button"
                            class="swatch {c}"
                            class:on={meta?.color === c}
                            aria-label={c}
                            onclick={() => index.update(id, { color: c })}
                        ></button>
                    {/each}
                </div>
                <button class="btn" type="button" onclick={() => list.removeDone()}>Clear completed</button>
                {#if confirmDelete}
                    <button class="btn danger" type="button" onclick={ondelete}>Yes, delete this list</button>
                    <button class="btn" type="button" onclick={() => (confirmDelete = false)}>Keep it</button>
                {:else}
                    <button class="btn" type="button" onclick={() => (confirmDelete = true)}>Delete list…</button>
                {/if}
            </div>
        </details>
    </header>
    <TaskList tasks={$tasks} {list} />
</article>
