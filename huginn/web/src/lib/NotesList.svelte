<script lang="ts">
    import { onMount, tick, type Snippet } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { page } from '$app/state';
    import { dismiss } from '$lib/dismiss';
    import Icon from '$lib/Icon.svelte';
    import SketchThumb from '$lib/SketchThumb.svelte';
    import { MIN_SEARCH, searchNotes, snippetParts, type SearchHit } from '$lib/search';
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
    // Titles match here, at once and offline; note text matches on the server.
    let hits = $state<Map<string, SearchHit> | null>(null);
    let textSearch = $state<'off' | 'done' | 'unavailable'>('off');
    $effect(() => {
        const q = query.trim();
        if (q.length < MIN_SEARCH) {
            hits = null;
            textSearch = 'off';
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            searchNotes(q, controller.signal).then(
                (found) => {
                    hits = new Map(found.map((h) => [h.note, h]));
                    textSearch = 'done';
                },
                () => {
                    if (controller.signal.aborted) return;
                    hits = null;
                    textSearch = 'unavailable';
                },
            );
        }, 150);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    });
    /** Title matches first, then notes whose text matches, most relevant first. */
    const visible = $derived.by(() => {
        const pool = trash ? deleted : active;
        const q = query.trim().toLocaleLowerCase();
        if (!q) return pool;
        const byTitle = pool.filter((n) => (n.title || 'New note').toLocaleLowerCase().includes(q));
        if (!hits) return byTitle;
        const titled = new Set(byTitle.map((n) => n.id));
        const byId = new Map(pool.map((n) => [n.id, n]));
        const byText = [...hits.keys()].flatMap((id) => (!titled.has(id) && byId.get(id)) || []);
        return [...byTitle, ...byText];
    });
    /** Where a row opens: at the section its match is in, when searching. */
    function href(id: string): string {
        const section = query.trim() ? hits?.get(id)?.section : undefined;
        return `${base}/n/${id}${trash ? '?view=trash' : ''}${section ? `#section-${section}` : ''}`;
    }

    // On a narrow screen the list is hidden while a note is open; come back to the same place.
    let scroller: HTMLElement;
    let listPosition = 0;
    function rememberPosition() {
        if (scroller.offsetParent) listPosition = scroller.scrollTop;
    }
    $effect(() => {
        if (!page.params.id) void tick().then(() => (scroller.scrollTop = listPosition));
    });

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
        const id = index.create('text');
        const note = openNote(id, index);
        note.initialise();
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
            <button class="icon-btn" type="button" onclick={create} disabled={!ready} aria-label="New note">
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
<div class="library-scroll" bind:this={scroller} onscroll={rememberPosition}>
    <div class="library-search">
        <input type="search" bind:value={query} placeholder="Search" aria-label="Search notes" />
    </div>
    {#if textSearch === 'unavailable'}<p class="library-hint muted small" role="status">
            Searching titles only. Note text is searched when connected.
        </p>{/if}
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
                        href={href(n.id)}
                        aria-current={page.params.id === n.id ? 'page' : undefined}
                    >
                        <span class="note-text">
                            <strong>{n.title || 'New note'}</strong>
                            <span class="small muted"
                                >{n.pinned && !trash ? 'Pinned · ' : ''}{when(trash ? n.deletedAt : n.updated)}{n.open
                                    ? ` · ${n.open} open`
                                    : ''}</span
                            >
                            {#if query.trim() && hits?.get(n.id)}
                                <span class="note-excerpt muted"
                                    >{#each snippetParts(hits.get(n.id)!.snippet) as part, i (i)}{#if part.match}<mark
                                                >{part.text}</mark
                                            >{:else}{part.text}{/if}{/each}</span
                                >
                            {:else}
                                <span class="note-excerpt muted"
                                    >{n.preview.split('\n').join(' · ') || 'No additional text'}</span
                                >
                            {/if}
                        </span>
                        {#if n.sketch}<SketchThumb bytes={n.sketch} />{/if}
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
                    <p>
                        {query
                            ? textSearch === 'done'
                                ? 'No matching notes'
                                : 'No matching titles'
                            : trash
                              ? 'No deleted notes'
                              : 'No notes on this device yet'}
                    </p>
                    {#if !trash && !query}<button class="btn primary" type="button" onclick={create}>New note</button
                        >{/if}
                    {#if !$synced}<p class="small muted">Connect to load notes from your other devices.</p>{/if}
                </div>
            {/each}
        {/if}
    </nav>
</div>
