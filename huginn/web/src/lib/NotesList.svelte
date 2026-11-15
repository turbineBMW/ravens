<script lang="ts">
    import { onMount, tick, untrack, type Snippet } from 'svelte';
    import { goto } from '$app/navigation';
    import { page } from '$app/state';
    import { dismiss } from '$lib/dismiss';
    import FolderActions from '$lib/FolderActions.svelte';
    import FolderPicker from '$lib/FolderPicker.svelte';
    import { childFolders, folderPath, folderTree, shownFolder, shownParents, within, type Folder } from '$lib/folders';
    import Icon from '$lib/Icon.svelte';
    import SketchThumb from '$lib/SketchThumb.svelte';
    import { MIN_SEARCH, searchNotes, snippetParts, type SearchHit } from '$lib/search';
    import { listHref, noteHref, scopeOf, type Scope } from '$lib/scope';
    import { openNote, type Index, type NoteMeta } from '$lib/notes';

    let { index, settings }: { index: Index; settings: Snippet } = $props();
    const notes = $derived(index.notes);
    const folderStore = $derived(index.folders);
    const synced = $derived(index.doc.synced);
    const status = $derived(index.doc.status);
    let ready = $state(false);
    let loadError = $state(false);
    let query = $state('');
    let menu: HTMLDetailsElement;

    // What the list shows: every note as a tree of folders, or Recently Deleted.
    const scope = $derived(scopeOf(page.url));
    const trash = $derived(scope.kind === 'trash');
    const folders = $derived($folderStore);
    const tree = $derived(folderTree(folders));
    const live = $derived(new Set(tree.map((r) => r.folder.id)));
    /** The folder a note shows in; see folders.ts. */
    const placeOf = (n: NoteMeta) => shownFolder(n.folder, live);
    const active = $derived($notes.filter((n) => !n.deletedAt));
    const deleted = $derived($notes.filter((n) => n.deletedAt));
    const children = $derived(childFolders(folders));
    /** The active notes in each place ('' for the top level), in list order. */
    const notesIn = $derived.by(() => {
        const by = new Map<string, NoteMeta[]>();
        for (const n of active) by.set(placeOf(n), [...(by.get(placeOf(n)) ?? []), n]);
        return by;
    });
    /** How many notes each folder holds, the folders inside it included. */
    const counts = $derived.by(() => {
        const c = new Map<string, number>();
        const total = (id: string): number => {
            const n =
                (notesIn.get(id)?.length ?? 0) + (children.get(id) ?? []).reduce((sum, f) => sum + total(f.id), 0);
            c.set(id, n);
            return n;
        };
        for (const f of children.get('') ?? []) total(f.id);
        return c;
    });

    // Folders collapsed in the list: this device's view only, like collapsed sections.
    const COLLAPSED_KEY = 'huginn.folders.collapsed';
    let collapsed = $state(readCollapsed());
    function readCollapsed(): Set<string> {
        try {
            return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
        } catch {
            return new Set();
        }
    }
    function setCollapsed(next: Set<string>) {
        collapsed = next;
        try {
            localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
        } catch {
            /* It still applies for this visit. */
        }
    }
    function toggleFolder(id: string) {
        const next = new Set(collapsed);
        if (!next.delete(id)) next.add(id);
        setCollapsed(next);
    }
    /** Expand a folder and the folders it's in. */
    function expand(id: string) {
        const parents = shownParents(folders);
        const next = new Set(collapsed);
        let changed = false;
        for (let at = id; at; at = parents.get(at) ?? '') changed = next.delete(at) || changed;
        if (changed) setCollapsed(next);
    }
    // The open note is always in view: highlighted, with the folders it's in expanded.
    $effect(() => {
        const id = page.params.id;
        if (!id || !ready) return;
        untrack(() => {
            const n = $notes.find((note) => note.id === id);
            if (n) expand(placeOf(n));
            void tick().then(() => scroller?.querySelector('.note-row.selected')?.scrollIntoView({ block: 'nearest' }));
        });
    });
    /** Folders deleted themselves, not along with the folder they were in. */
    const deletedFolders = $derived(
        folders.filter((f) => f.deletedAt && f.deletedWith === f.id).sort((a, b) => b.deletedAt - a.deletedAt),
    );
    const inScope = (n: NoteMeta, s: Scope) => (s.kind === 'trash' ? !!n.deletedAt : !n.deletedAt);

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
        const q = query.trim().toLocaleLowerCase();
        const pool = $notes.filter((n) => inScope(n, scope));
        if (!q) return pool;
        const byTitle = pool.filter((n) => (n.title || 'New note').toLocaleLowerCase().includes(q));
        if (!hits) return byTitle;
        const titled = new Set(byTitle.map((n) => n.id));
        const byId = new Map(pool.map((n) => [n.id, n]));
        const byText = [...hits.keys()].flatMap((id) => (!titled.has(id) && byId.get(id)) || []);
        return [...byTitle, ...byText];
    });
    type Row = { kind: 'folder'; folder: Folder; depth: number } | { kind: 'note'; note: NoteMeta; depth: number };
    /** The list as a tree of folders and notes, unless it's search results or Recently Deleted. */
    const asTree = $derived(!trash && !query.trim());
    const rows = $derived.by((): Row[] => {
        if (!asTree) return visible.map((note) => ({ kind: 'note', note, depth: 0 }));
        const out: Row[] = [];
        const walk = (place: string, depth: number) => {
            for (const folder of children.get(place) ?? []) {
                out.push({ kind: 'folder', folder, depth });
                if (!collapsed.has(folder.id)) walk(folder.id, depth + 1);
            }
            for (const note of notesIn.get(place) ?? []) out.push({ kind: 'note', note, depth });
        };
        walk('', 0);
        return out;
    });
    /** Where a row opens: at the section its match is in, when searching. */
    function href(id: string): string {
        return noteHref(id, scope, query.trim() ? hits?.get(id)?.section : undefined);
    }
    /** Where a note is, in search results; the tree shows it already. */
    function whereIs(n: NoteMeta): string {
        const place = placeOf(n);
        return asTree || trash || !place ? '' : folderPath(folders, place);
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

    /** A new note, at the top level or in a folder. */
    async function create(folder = '') {
        query = '';
        if (folder) expand(folder);
        const id = index.create('text', folder);
        const note = openNote(id, index);
        note.initialise();
        note.release();
        await goto(noteHref(id, scope));
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

    /** All Notes or Recently Deleted; the open note stays open if it's in it. */
    function choose(next: Scope) {
        menu.open = false;
        query = '';
        stopSelecting();
        const open = $notes.find((n) => n.id === page.params.id);
        void goto(open && inScope(open, next) ? noteHref(open.id, next) : listHref(next));
    }

    // A new folder at the top level, from the drawer; folders inside one come from its menu.
    let naming = $state(false);
    let newName = $state('');
    function createFolder(event: SubmitEvent) {
        event.preventDefault();
        const name = newName.trim();
        if (!name) return;
        index.createFolder(name, '');
        naming = false;
        newName = '';
        menu.open = false;
        if (trash) choose({ kind: 'all' });
    }
    const focus = (input: HTMLInputElement) => input.focus();

    // Selecting several notes, to move or delete them together.
    let selecting = $state(false);
    let chosen = $state<string[]>([]);
    let movingChosen = $state(false);
    function stopSelecting() {
        selecting = false;
        chosen = [];
        movingChosen = false;
    }
    function toggle(id: string) {
        chosen = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    }
    /** Where every chosen note already is, if they're all in one place: not offered as a move. */
    const chosenPlace = $derived.by(() => {
        const places = new Set($notes.filter((n) => chosen.includes(n.id)).map(placeOf));
        return places.size === 1 ? [...places][0] : null;
    });
    function moveChosen(folder: string) {
        index.moveNotes(chosen, folder);
        stopSelecting();
    }
    function deleteChosen() {
        const leavingOpen = chosen.includes(page.params.id ?? '');
        for (const id of chosen) index.remove(id);
        stopSelecting();
        if (leavingOpen) void goto(listHref(scope));
    }

    /** A folder went to Recently Deleted: so did the open note, if it was in it. */
    function folderDeleted(gone: Set<string>) {
        // It's deleted by now, so it's found among all notes, by the folder it's in.
        const open = $notes.find((n) => n.id === page.params.id);
        if (open && gone.has(open.folder)) void goto(listHref(scope));
    }
</script>

<header class="headerbar">
    <div class="headerbar-start">
        {#if !trash}
            <button class="icon-btn" type="button" onclick={() => create()} disabled={!ready} aria-label="New note">
                <Icon name="add" />
            </button>
        {/if}
    </div>
    <div class="headerbar-title"><h1>{trash ? 'Recently Deleted' : 'Huginn'}</h1></div>
    <div class="headerbar-end">
        <details
            class="menu primary-menu"
            bind:this={menu}
            use:dismiss
            ontoggle={(e) => !e.currentTarget.open && (naming = false)}
        >
            <summary class="icon-btn" aria-label="Main menu">
                <Icon name="menu" />
                {#if $status !== 'online'}<span class="sync {$status}"></span>{/if}
            </summary>
            <div class="sheet actions">
                <button
                    class="btn"
                    type="button"
                    aria-current={scope.kind === 'all'}
                    onclick={() => choose({ kind: 'all' })}
                >
                    All Notes <span class="muted">{active.length}</span>
                </button>
                {#if naming}
                    <form class="folder-form" onsubmit={createFolder}>
                        <input
                            bind:value={newName}
                            aria-label="New folder name"
                            placeholder="Folder name"
                            maxlength="100"
                            use:focus
                        />
                        <button class="btn primary" type="submit" disabled={!newName.trim()}>Create</button>
                        <button class="btn" type="button" onclick={() => (naming = false)}>Cancel</button>
                    </form>
                {:else}
                    <button class="btn" type="button" onclick={() => (naming = true)}>New folder…</button>
                {/if}
                <button class="btn" type="button" aria-current={trash} onclick={() => choose({ kind: 'trash' })}>
                    Recently Deleted <span class="muted">{deleted.length + deletedFolders.length}</span>
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
        {#if !trash && rows.some((r) => r.kind === 'note')}
            <button
                class="btn select-toggle"
                type="button"
                aria-pressed={selecting}
                onclick={() => (selecting ? stopSelecting() : (selecting = true))}
                >{selecting ? 'Done' : 'Select'}</button
            >
        {/if}
    </div>
    {#if textSearch === 'unavailable'}<p class="library-hint muted small" role="status">
            Searching titles only. Note text is searched when connected.
        </p>{/if}
    {#if trash}
        <p class="library-hint muted small">
            Deleted notes and folders stay here until you restore them. Automatic expiry is not enabled.
        </p>
        {#each deletedFolders as f (f.id)}
            <div class="note-row folder-row">
                <span class="note-text">
                    <strong>{f.name || 'Untitled folder'}</strong>
                    <span class="small muted"
                        >Folder · {when(f.deletedAt)} · {deleted.filter((n) => n.deletedWith === f.id).length} notes</span
                    >
                </span>
                <button class="btn" type="button" onclick={() => index.restoreFolder(f.id)}>Restore</button>
            </div>
        {/each}
    {/if}
    <nav class="note-rows" aria-label={trash ? 'Deleted notes' : 'Notes'}>
        {#if loadError}
            <p class="library-hint" role="alert">Could not open local storage. Reload to try again.</p>
        {:else if !ready}
            <p class="library-hint" role="status">Loading your notes…</p>
        {:else}
            {#each rows as row (row.kind === 'note' ? row.note.id : `folder:${row.folder.id}`)}
                {#if row.kind === 'folder'}
                    {@const f = row.folder}
                    {@const open = !collapsed.has(f.id)}
                    <div class="folder-node" style:--depth={row.depth}>
                        <button
                            class="folder-label"
                            type="button"
                            aria-expanded={open}
                            title="{open ? 'Collapse' : 'Expand'} {f.name || 'Untitled folder'}"
                            onclick={() => toggleFolder(f.id)}
                        >
                            <Icon name="chevron" />
                            <span class="folder-name">{f.name || 'Untitled folder'}</span>
                            <span class="muted small">{counts.get(f.id) ?? 0}</span>
                        </button>
                        {#if !selecting}
                            <FolderActions
                                {index}
                                folder={f}
                                {folders}
                                notesInside={active.filter((n) => within(folders, f.id).has(placeOf(n))).length}
                                onnewnote={(folder) => void create(folder)}
                                onexpand={expand}
                                ondelete={folderDeleted}
                            />
                        {/if}
                    </div>
                {:else}
                    {@const n = row.note}
                    {@const where = whereIs(n)}
                    {#snippet summary()}
                        <span class="note-text">
                            <strong>{n.title || 'New note'}</strong>
                            <span class="small muted"
                                >{n.pinned && !trash ? 'Pinned · ' : ''}{when(trash ? n.deletedAt : n.updated)}{where
                                    ? ` · ${where}`
                                    : ''}{n.open ? ` · ${n.open} open` : ''}</span
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
                    {/snippet}
                    <div
                        class="note-row"
                        class:selected={!selecting && page.params.id === n.id}
                        style:--depth={row.depth}
                        data-depth={row.depth}
                    >
                        {#if selecting}
                            <label class="note-select">
                                <input type="checkbox" checked={chosen.includes(n.id)} onchange={() => toggle(n.id)} />
                                {@render summary()}
                            </label>
                        {:else}
                            <a
                                onkeydown={navigateRows}
                                href={href(n.id)}
                                aria-current={page.params.id === n.id ? 'page' : undefined}
                            >
                                {@render summary()}
                            </a>
                            {#if !trash}
                                <button
                                    class="pin-button"
                                    type="button"
                                    aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
                                    aria-pressed={n.pinned}
                                    onclick={() => index.touch(n.id, { pinned: !n.pinned })}
                                    >{n.pinned ? '◆' : '◇'}</button
                                >
                            {/if}
                        {/if}
                    </div>
                {/if}
            {:else}
                <div class="library-empty">
                    <p>
                        {query
                            ? textSearch === 'done'
                                ? 'No matching notes'
                                : 'No matching titles'
                            : trash
                              ? deletedFolders.length
                                  ? 'No other deleted notes'
                                  : 'No deleted notes'
                              : tree.length
                                ? 'No notes yet'
                                : 'No notes on this device yet'}
                    </p>
                    {#if !trash && !query}<button class="btn primary" type="button" onclick={() => create()}
                            >New note</button
                        >{/if}
                    {#if !$synced}<p class="small muted">Connect to load notes from your other devices.</p>{/if}
                </div>
            {/each}
        {/if}
    </nav>
</div>
{#if selecting}
    <div class="selection-bar" role="toolbar" aria-label="Selected notes">
        {#if movingChosen}
            <p class="small muted">Move {chosen.length} {chosen.length === 1 ? 'note' : 'notes'} to</p>
            <FolderPicker rows={tree} current={chosenPlace} onpick={moveChosen} />
            <button class="btn" type="button" onclick={() => (movingChosen = false)}>Cancel</button>
        {:else}
            <span class="small">{chosen.length} selected</span>
            <button class="btn" type="button" disabled={!chosen.length} onclick={() => (movingChosen = true)}
                >Move…</button
            >
            <button class="btn danger" type="button" disabled={!chosen.length} onclick={deleteChosen}>Delete</button>
        {/if}
    </div>
{/if}
