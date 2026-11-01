<script lang="ts">
    import { onMount, type Snippet } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { page } from '$app/state';
    import { dismiss } from '$lib/dismiss';
    import Icon from '$lib/Icon.svelte';
    import { openNote, type Index } from '$lib/notes';

    let { index, settings }: { index: Index; settings: Snippet } = $props();
    const notes = $derived(index.notes);
    const synced = $derived(index.doc.synced);
    const status = $derived(index.doc.status);
    let ready = $state(false);
    let loadError = $state(false);
    let query = $state('');
    let menu: HTMLDetailsElement;
    const trash = $derived(page.url.searchParams.get('view') === 'trash');
    const active = $derived($notes.filter((n) => !n.deletedAt));
    const deleted = $derived($notes.filter((n) => n.deletedAt));
    const visible = $derived(
        (trash ? deleted : active).filter((n) =>
            (n.title || 'Untitled list').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
        ),
    );

    onMount(() => {
        let live = true;
        index.doc.whenLocal.then(
            () => {
                if (live) ready = true;
            },
            () => {
                if (live) loadError = true;
            },
        );
        return () => {
            live = false;
        };
    });

    async function create() {
        query = '';
        const id = index.create('checklist');
        const note = openNote(id, index);
        note.setTitle('');
        note.release();
        await goto(`${base}/n/${id}`);
    }

    function navigateRows(event: KeyboardEvent) {
        if (event.target instanceof HTMLAnchorElement && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            const links = [
                ...(event.currentTarget as HTMLElement).closest('nav')!.querySelectorAll<HTMLAnchorElement>('a'),
            ];
            const at = links.indexOf(event.target);
            const next =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? links.length - 1
                      : at + (event.key === 'ArrowDown' ? 1 : -1);
            if (links[next]) {
                event.preventDefault();
                links[next].focus();
            }
        }
    }

    function when(ms: number) {
        return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function choose(deleted: boolean) {
        menu.open = false;
        query = '';
        void goto(`${base}/${deleted ? '?view=trash' : ''}`);
    }
</script>

<header class="headerbar">
    <div class="headerbar-start">
        {#if !trash}
            <button class="icon-btn" type="button" onclick={create} disabled={!ready} aria-label="New checklist">
                <Icon name="add" />
            </button>
        {/if}
    </div>
    <div class="headerbar-title"><h1>{trash ? 'Recently Deleted' : 'Huginn'}</h1></div>
    <div class="headerbar-end">
        <details class="menu primary-menu" bind:this={menu} use:dismiss>
            <summary class="icon-btn" aria-label="Main menu">
                <Icon name="menu" />
                {#if $status !== 'online'}<span class="sync {$status}"></span>{/if}
            </summary>
            <div class="sheet actions">
                <button class="btn" type="button" aria-current={!trash} onclick={() => choose(false)}>
                    All Notes <span class="muted">{active.length}</span>
                </button>
                <button class="btn" type="button" aria-current={trash} onclick={() => choose(true)}>
                    Recently Deleted <span class="muted">{deleted.length}</span>
                </button>
                <hr />
                {@render settings()}
            </div>
        </details>
    </div>
</header>
<div class="library-scroll">
    <div class="library-search">
        <input type="search" bind:value={query} placeholder="Search titles" aria-label="Search note titles" />
    </div>
    {#if trash}<p class="library-hint muted small">
            Deleted notes stay here until you restore them. Automatic expiry is not enabled.
        </p>{/if}
    <nav class="note-rows" aria-label={trash ? 'Deleted notes' : 'Notes'}>
        {#if loadError}
            <p class="library-hint" role="alert">Could not open local storage. Reload to try again.</p>
        {:else if !ready}
            <p class="library-hint" role="status">Loading your notes…</p>
        {:else}
            {#each visible as n (n.id)}
                <div class="note-row" class:selected={page.params.id === n.id}>
                    <a
                        onkeydown={navigateRows}
                        href="{base}/n/{n.id}{trash ? '?view=trash' : ''}"
                        aria-current={page.params.id === n.id ? 'page' : undefined}
                    >
                        <strong>{n.title || 'Untitled list'}</strong>
                        <span class="small muted"
                            >{n.pinned && !trash ? 'Pinned · ' : ''}{when(trash ? n.deletedAt : n.updated)} · {n.open} open</span
                        >
                        <span class="note-excerpt muted">{n.preview.split('\n').join(' · ') || 'No items yet'}</span>
                    </a>
                    {#if !trash}
                        <button
                            class="pin-button"
                            type="button"
                            aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
                            aria-pressed={n.pinned}
                            onclick={() => index.touch(n.id, { pinned: !n.pinned })}>{n.pinned ? '◆' : '◇'}</button
                        >
                    {/if}
                </div>
            {:else}
                <div class="library-empty">
                    <p>{query ? 'No matching titles' : trash ? 'No deleted notes' : 'No notes on this device yet'}</p>
                    {#if !trash && !query}<button class="btn primary" type="button" onclick={create}
                            >New checklist</button
                        >{/if}
                    {#if !$synced}<p class="small muted">Connect to load notes from your other devices.</p>{/if}
                </div>
            {/each}
        {/if}
    </nav>
</div>
