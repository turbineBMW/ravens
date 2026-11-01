<script lang="ts">
    import { getContext, onDestroy } from 'svelte';
    import { base } from '$app/paths';
    import { page } from '$app/state';
    import TaskList from '$lib/TaskList.svelte';
    import { openAll, type TaskIn } from '$lib/all';
    import { dueState, type Index } from '$lib/tasks';

    const index = getContext<Index>('index');
    const all = openAll(index);
    const tasks = all.tasks;
    onDestroy(() => all.release());

    const view = $derived(page.params.view ?? 'all');
    const titles: Record<string, string> = { today: 'Today', scheduled: 'Scheduled', flagged: 'Flagged', all: 'All' };

    const shown = $derived.by(() => {
        const open = $tasks.filter((t) => !t.done);
        const pick =
            view === 'today'
                ? open.filter((t) => ['today', 'overdue'].includes(dueState(t)))
                : view === 'scheduled'
                  ? open.filter((t) => !!t.due).sort((a, b) => a.due.localeCompare(b.due))
                  : view === 'flagged'
                    ? open.filter((t) => t.flagged)
                    : open;
        // Group by list, keeping each list's own order.
        const groups = new Map<string, TaskIn[]>();
        for (const t of pick) groups.set(t.list.id, [...(groups.get(t.list.id) ?? []), t]);
        return [...groups.values()];
    });
</script>

<article class="list">
    <header class="list-head">
        <h1 class="title view-title {view}">{titles[view] ?? view}</h1>
    </header>
    {#if shown.length === 0}
        <p class="card muted">Nothing {view === 'today' ? 'due today' : view === 'flagged' ? 'flagged' : 'here'}.</p>
    {/if}
    {#each shown as group (group[0].list.id)}
        {@const l = all.listFor(group[0].list.id)}
        {#if l}
            <h2 class="section">
                <a href="{base}/l/{group[0].list.id}"
                    ><span class="dot {group[0].list.color}"></span> {group[0].list.name}</a
                >
            </h2>
            <TaskList tasks={group} list={l} readonlyOrder />
        {/if}
    {/each}
</article>
