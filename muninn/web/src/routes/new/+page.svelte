<script lang="ts">
    /**
     * The landing page for "Remind me" from Huginn (and any other deep link):
     * /muninn/new?title=…&source=<LinkTarget JSON>&due=YYYY-MM-DD&list=<id>
     * Shows the reminder before creating it, in the list of the user's choice.
     */
    import { getContext } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { page } from '$app/state';
    import type { LinkTarget } from '@ravens/ui/api';
    import { openList, todayIso, type Index } from '$lib/tasks';

    const index = getContext<Index>('index');
    const lists = index.lists;

    const params = page.url.searchParams;
    let title = $state(params.get('title') ?? '');
    let due = $state(params.get('due') ?? '');
    let listId = $state(params.get('list') ?? '');
    let source = $state<LinkTarget | null>(null);
    try {
        const raw = params.get('source');
        if (raw) source = JSON.parse(raw) as LinkTarget;
    } catch {
        source = null;
    }

    const chosen = $derived(listId || $lists[0]?.id || '');
    const now = new Date();
    const day = (n: number) => todayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));

    function create() {
        const t = title.trim();
        if (!t) return;
        const id = chosen || index.create('Reminders', 'accent');
        const list = openList(id, index);
        list.add(t, { due, allDay: true, source: source ?? undefined });
        list.release();
        void goto(`${base}/l/${id}`);
    }
</script>

<article class="list">
    <header class="list-head"><h1 class="title">New reminder</h1></header>
    <form
        class="card new-form"
        onsubmit={(e) => {
            e.preventDefault();
            create();
        }}
    >
        <input class="text big" type="text" placeholder="What to remember" bind:value={title} autocomplete="off" />
        {#if source}
            <p class="small muted">
                From {source.app === 'huginn' ? 'a Huginn note' : 'Muninn'}; the reminder links back to it.
            </p>
        {/if}
        <div class="chips">
            <span class="small muted">When</span>
            <button class="chip" class:on={due === day(0)} type="button" onclick={() => (due = day(0))}>Today</button>
            <button class="chip" class:on={due === day(1)} type="button" onclick={() => (due = day(1))}>Tomorrow</button
            >
            <label class="chip" class:on={!!due && due !== day(0) && due !== day(1)}>
                Date <input type="date" bind:value={due} />
            </label>
            {#if due}<button class="chip" type="button" onclick={() => (due = '')}>No date</button>{/if}
        </div>
        <div class="chips">
            <span class="small muted">List</span>
            {#each $lists as l (l.id)}
                <button class="chip" class:on={chosen === l.id} type="button" onclick={() => (listId = l.id)}>
                    <span class="dot {l.color}"></span>
                    {l.name}
                </button>
            {/each}
            {#if $lists.length === 0}<span class="small muted">A "Reminders" list will be made.</span>{/if}
        </div>
        <div class="chips">
            <span class="spacer"></span>
            <a class="chip" href="{base}/">Cancel</a>
            <button class="chip on" type="submit" disabled={!title.trim()}>Add reminder</button>
        </div>
    </form>
</article>
