<script lang="ts">
    /**
     * The list itself: tap to check and the item slides to the bottom, drag
     * the handle to reorder, type at the end to add, Enter for the next
     * item, Backspace on an empty one to remove it. Every change goes
     * straight to the note's Yjs document; this component only renders it.
     */
    import { flip } from 'svelte/animate';
    import { onMount, tick } from 'svelte';
    import { createReorder } from '@ravens/ui/reorder';
    import { remindMeHref } from '$lib/links';
    import type { Item, Note } from '$lib/notes';

    let {
        items,
        note,
        noteId,
        noteTitle = '',
    }: { items: Item[]; note: Note; noteId: string; noteTitle?: string } = $props();

    // A link into the note (from a Muninn reminder) names the item in the hash.
    onMount(() => {
        const target = location.hash.slice(1);
        if (target) void focusItem(target);
    });

    let draft = $state('');
    let showDone = $state(true);
    let dragging = $state<{ id: string; order: string[] } | null>(null);

    type Row = { id: string; kind: 'item'; item: Item } | { id: string; kind: 'add' } | { id: string; kind: 'divider' };

    const open = $derived(items.filter((i) => !i.checked));
    const done = $derived(items.filter((i) => i.checked));
    const openOrdered = $derived.by(() => {
        if (!dragging) return open;
        const byId = new Map(open.map((i) => [i.id, i]));
        const ordered = dragging.order.map((id) => byId.get(id)).filter((i): i is Item => !!i);
        for (const i of open) if (!dragging.order.includes(i.id)) ordered.push(i);
        return ordered;
    });
    const rows = $derived.by(() => {
        const r: Row[] = openOrdered.map((item) => ({ id: item.id, kind: 'item', item }));
        r.push({ id: '__add', kind: 'add' });
        if (done.length) {
            r.push({ id: '__divider', kind: 'divider' });
            if (showDone) for (const item of done) r.push({ id: item.id, kind: 'item', item });
        }
        return r;
    });

    async function focusItem(id: string, atEnd = true) {
        await tick();
        const el = document.querySelector<HTMLInputElement>(`[data-item="${id}"] input.text`);
        if (!el) return;
        el.focus();
        if (atEnd) el.setSelectionRange(el.value.length, el.value.length);
    }

    function addFromDraft() {
        const text = draft.trim();
        if (!text) return;
        note.addItem(text);
        draft = '';
    }

    function onItemKey(e: KeyboardEvent, item: Item, index: number) {
        const input = e.currentTarget as HTMLInputElement;
        if (e.isComposing) return;
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !item.checked) {
            e.preventDefault();
            const ids = openOrdered.map((i) => i.id);
            const at = ids.indexOf(item.id);
            const to = at + (e.key === 'ArrowUp' ? -1 : 1);
            if (to < 0 || to >= ids.length) return;
            ids.splice(at, 1);
            ids.splice(to, 0, item.id);
            note.move(item.id, ids[to - 1] ?? null, ids[to + 1] ?? null);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (item.checked) return;
            // Split at the caret: the tail becomes the next item.
            const at = input.selectionStart ?? input.value.length;
            const head = input.value.slice(0, at);
            const tail = input.value.slice(at);
            if (tail) note.setText(item.id, head);
            const id = note.addItem(tail, item.id);
            void focusItem(id, false);
        } else if (e.key === 'Backspace' && input.value === '') {
            e.preventDefault();
            const prev = openOrdered[index - 1];
            note.remove(item.id);
            if (prev) void focusItem(prev.id);
        } else if (e.key === 'Escape') {
            input.blur();
        }
    }

    // ---- drag to reorder (the handle only, so fingers still scroll the list) ----
    const reorder = createReorder({
        order: () => open.map((i) => i.id),
        preview: (order) => (dragging = order ? { id: order.join('\n'), order } : null),
        commit: (id, before, after) => note.move(id, before, after),
        rows: () => [...document.querySelectorAll<HTMLElement>('ul.checklist li[data-reorder-row]:not(.done)')],
        rowId: (row) => row.dataset.item,
    });
</script>

<ul class="checklist" class:is-dragging={!!dragging}>
    {#each rows as row, index (row.id)}
        <li
            animate:flip={{ duration: 180 }}
            data-item={row.kind === 'item' ? row.id : undefined}
            data-reorder-row={row.kind === 'item' ? '' : undefined}
            class:done={row.kind === 'item' && row.item.checked}
            class:add={row.kind === 'add'}
            class:divider={row.kind === 'divider'}
        >
            {#if row.kind === 'item'}
                {#if !row.item.checked}
                    <span class="handle" use:reorder.handle={row.id} aria-hidden="true">⋮⋮</span>
                {:else}
                    <span class="handle blank" aria-hidden="true"></span>
                {/if}
                <label class="check">
                    <input
                        type="checkbox"
                        checked={row.item.checked}
                        onchange={(e) => note.setChecked(row.id, e.currentTarget.checked)}
                        aria-label={row.item.checked ? 'Uncheck' : 'Check'}
                    />
                </label>
                <input
                    class="text"
                    type="text"
                    value={row.item.text}
                    placeholder="List item"
                    aria-label="List item"
                    title="Alt + Up or Down to reorder"
                    autocomplete="off"
                    autocapitalize="sentences"
                    enterkeyhint="next"
                    oninput={(e) => note.setText(row.id, e.currentTarget.value)}
                    onkeydown={(e) => onItemKey(e, row.item, index)}
                />
                <button class="remove" type="button" aria-label="Remove item" onclick={() => note.remove(row.id)}
                    >×</button
                >
            {:else if row.kind === 'add'}
                <span class="handle blank" aria-hidden="true"></span>
                <span class="plus" aria-hidden="true">+</span>
                <input
                    class="text"
                    type="text"
                    placeholder="Add item"
                    autocomplete="off"
                    autocapitalize="sentences"
                    enterkeyhint="done"
                    bind:value={draft}
                    onkeydown={(e) => {
                        if (e.key === 'Enter' && !e.isComposing) {
                            e.preventDefault();
                            addFromDraft();
                        }
                    }}
                    onblur={addFromDraft}
                />
            {:else}
                <button class="divider-btn" type="button" onclick={() => (showDone = !showDone)}>
                    <span class="chev" class:open={showDone}>›</span>
                    {done.length} checked {done.length === 1 ? 'item' : 'items'}
                </button>
            {/if}
        </li>
    {/each}
</ul>
