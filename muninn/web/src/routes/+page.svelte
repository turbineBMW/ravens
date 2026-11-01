<script lang="ts">
    import { getContext, onDestroy } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { createReorder } from '@ravens/ui/reorder';
    import { openAll } from '$lib/all';
    import { dueState, LIST_COLORS, type Index } from '$lib/tasks';

    const index = getContext<Index>('index');
    const lists = index.lists;
    const all = openAll(index);
    const tasks = all.tasks;
    onDestroy(() => all.release());

    let adding = $state(false);
    let name = $state('');
    let color = $state<string>('accent');
    let preview = $state<string[] | null>(null);

    const ordered = $derived.by(() => {
        if (!preview) return $lists;
        const byId = new Map($lists.map((l) => [l.id, l]));
        return preview.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l);
    });

    const counts = $derived.by(() => {
        const open = $tasks.filter((t) => !t.done);
        return {
            today: open.filter((t) => ['today', 'overdue'].includes(dueState(t))).length,
            scheduled: open.filter((t) => !!t.due).length,
            flagged: open.filter((t) => t.flagged).length,
            all: open.length,
        };
    });

    const reorder = createReorder({
        order: () => $lists.map((l) => l.id),
        preview: (o) => (preview = o),
        commit: (id, b, a) => index.move(id, b, a),
        rows: () => [...document.querySelectorAll<HTMLElement>('.lists li[data-reorder-row]')],
        rowId: (row) => row.dataset.list,
    });

    function create() {
        const n = name.trim();
        if (!n) return;
        const id = index.create(n, color);
        name = '';
        adding = false;
        void goto(`${base}/l/${id}`);
    }
</script>

<nav class="smart">
    <a class="card smart-card today" href="{base}/view/today"><span class="n">{counts.today}</span>Today</a>
    <a class="card smart-card scheduled" href="{base}/view/scheduled"
        ><span class="n">{counts.scheduled}</span>Scheduled</a
    >
    <a class="card smart-card flagged" href="{base}/view/flagged"><span class="n">{counts.flagged}</span>Flagged</a>
    <a class="card smart-card all" href="{base}/view/all"><span class="n">{counts.all}</span>All</a>
</nav>

<h2 class="section">My lists</h2>
<ul class="lists card">
    {#each ordered as l (l.id)}
        <li data-list={l.id} data-reorder-row="">
            <span class="handle" use:reorder.handle={l.id} aria-hidden="true">⋮⋮</span>
            <a href="{base}/l/{l.id}">
                <span class="dot {l.color}"></span>
                <span class="name">{l.name || 'Untitled list'}</span>
                <span class="count muted">{l.open}</span>
            </a>
        </li>
    {/each}
    {#if adding}
        <li class="new">
            <span class="handle blank"></span>
            <form
                onsubmit={(e) => {
                    e.preventDefault();
                    create();
                }}
            >
                <input class="text" type="text" placeholder="List name" bind:value={name} autocomplete="off" />
                <div class="chips">
                    {#each LIST_COLORS as c}
                        <button
                            type="button"
                            class="swatch {c}"
                            class:on={color === c}
                            aria-label={c}
                            onclick={() => (color = c)}
                        ></button>
                    {/each}
                    <span class="spacer"></span>
                    <button class="chip" type="button" onclick={() => (adding = false)}>Cancel</button>
                    <button class="chip on" type="submit">Add</button>
                </div>
            </form>
        </li>
    {:else}
        <li class="new">
            <span class="handle blank"></span>
            <button class="add-list" type="button" onclick={() => (adding = true)}>+ Add list</button>
        </li>
    {/if}
</ul>
