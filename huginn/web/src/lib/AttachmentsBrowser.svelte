<script lang="ts">
    /**
     * Every attachment in the library, newest notes first, filtered by kind or
     * by name: each opens its note at the attachment. From the server's list
     * (attachments.ts), so notes this device has never opened are in it too, and
     * offline it's the list as of the last connection.
     */
    import { goto } from '$app/navigation';
    import { onMount } from 'svelte';
    import Icon from '$lib/Icon.svelte';
    import PictureThumb from '$lib/PictureThumb.svelte';
    import { KIND_NAMES, libraryAttachments, refreshAttachments, type AttachmentInfo } from '$lib/attachments';
    import { sizeText } from '$lib/files';
    import type { Index } from '$lib/notes';
    import { noteHref } from '$lib/scope';
    import type { AttachmentKind } from '$lib/thumbs';

    let { index, onclose }: { index: Index; onclose: () => void } = $props();

    // svelte-ignore state_referenced_locally
    const notes = index.notes;
    let dialog: HTMLDialogElement;
    let kind = $state<AttachmentKind | 'all'>('all');
    let query = $state('');

    const live = $derived(new Map($notes.filter((n) => !n.deletedAt).map((n) => [n.id, n])));
    /** In live notes only, in the order the notes list has them. */
    const all = $derived.by(() => {
        const order = new Map([...live.keys()].map((id, i) => [id, i]));
        return $libraryAttachments
            .filter((a) => live.has(a.note))
            .sort((a, b) => order.get(a.note)! - order.get(b.note)!);
    });
    const counts = $derived.by(() => {
        const c = new Map<AttachmentKind, number>();
        for (const a of all) c.set(a.kind, (c.get(a.kind) ?? 0) + 1);
        return c;
    });
    const shown = $derived.by(() => {
        const q = query.trim().toLocaleLowerCase();
        return all.filter(
            (a) =>
                (kind === 'all' || a.kind === kind) &&
                (!q || [a.name, a.alt, a.url, live.get(a.note)?.title].some((t) => t?.toLocaleLowerCase().includes(q))),
        );
    });
    const label = (a: AttachmentInfo) =>
        (a.kind === 'link' ? a.url?.replace(/^https?:\/\/(www\.)?/, '') : a.name) || 'Untitled';
    const pictureOf = (a: AttachmentInfo) => a.thumb || (a.kind === 'image' ? a.blob : '');

    /** Put away: said at once and once, since the dialog's own close event comes later. */
    let closed = false;
    function finish() {
        if (closed) return;
        closed = true;
        if (dialog.open) dialog.close();
        onclose();
    }

    function open(a: AttachmentInfo) {
        finish();
        void goto(`${noteHref(a.note, { kind: 'all' })}#attachment-${a.blob}`);
    }

    onMount(() => {
        dialog.showModal();
        void refreshAttachments();
    });
</script>

<dialog class="attachments-browser" bind:this={dialog} onclose={finish} aria-label="Attachments">
    <header class="viewer-bar">
        <span class="viewer-title">Attachments</span>
        <button class="icon-btn" type="button" aria-label="Close" onclick={finish}><Icon name="close" /></button>
    </header>
    <div class="browser-tools">
        <input type="search" placeholder="Find by name" aria-label="Find attachments by name" bind:value={query} />
        <div class="browser-kinds" role="radiogroup" aria-label="Kind">
            <button type="button" class="chip" role="radio" aria-checked={kind === 'all'} onclick={() => (kind = 'all')}
                >All <span class="muted">{all.length}</span></button
            >
            {#each Object.entries(KIND_NAMES) as [k, name] (k)}
                {#if counts.get(k as AttachmentKind)}
                    <button
                        type="button"
                        class="chip"
                        role="radio"
                        aria-checked={kind === k}
                        onclick={() => (kind = k as AttachmentKind)}
                        >{name} <span class="muted">{counts.get(k as AttachmentKind)}</span></button
                    >
                {/if}
            {/each}
        </div>
    </div>
    <div class="browser-body">
        {#if !shown.length}
            <p class="muted library-empty">
                {all.length
                    ? 'Nothing matches.'
                    : 'No attachments yet. Add one from a note’s toolbar, or paste or drop a file into it.'}
            </p>
        {:else}
            <ul class="browser-grid">
                {#each shown as a (a.note + a.blob)}
                    <li>
                        <button type="button" class="browser-item" onclick={() => open(a)}>
                            <span class="browser-picture">
                                {#if pictureOf(a)}
                                    <PictureThumb id={pictureOf(a)} />
                                {:else}
                                    <span class="file-icon" aria-hidden="true"
                                        >{a.kind === 'link'
                                            ? 'LINK'
                                            : (/\.([a-z0-9]{1,5})$/i.exec(a.name)?.[1] ?? 'FILE').toUpperCase()}</span
                                    >
                                {/if}
                            </span>
                            <span class="card-title">{label(a)}</span>
                            <span class="small muted card-detail"
                                >{live.get(a.note)?.title || 'Untitled note'}{a.size
                                    ? ` · ${sizeText(a.size)}`
                                    : ''}</span
                            >
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</dialog>
