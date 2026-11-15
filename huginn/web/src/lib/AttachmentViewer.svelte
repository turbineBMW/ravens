<script lang="ts">
    /**
     * An attachment shown whole, over the note: an image at full size, a video,
     * a PDF's pages, or for any other file, what it is and how to get it.
     * Escape, the close button or the backdrop put it away.
     */
    import { onMount } from 'svelte';
    import Icon from '$lib/Icon.svelte';
    import PdfPages from '$lib/PdfPages.svelte';
    import { fileBlob, isLocal, serverUrl, sizeText } from '$lib/files';
    import type { AttachmentAttrs } from '$lib/attachmentNode.svelte';

    let { attrs, onclose }: { attrs: AttachmentAttrs; onclose: () => void } = $props();

    let dialog: HTMLDialogElement;
    let blob = $state.raw<Blob | null>(null);
    let url = $state<string | null>(null);
    let loading = $state(true);

    onMount(() => {
        dialog.showModal();
        let gone = false;
        // A video streams from the server when it isn't here; the rest is read whole.
        void (async () => {
            const stream = attrs.kind === 'video' && !(await isLocal(attrs.blob));
            const b = stream ? null : await fileBlob(attrs.blob);
            if (gone) return;
            loading = false;
            blob = b;
            if (b) url = URL.createObjectURL(b);
            else if (attrs.kind === 'video') url = serverUrl(attrs.blob);
        })();
        return () => {
            gone = true;
            if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
        };
    });

    function download() {
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        a.download = attrs.name || 'attachment';
        a.click();
    }
    /** In a tab of its own, where the browser shows what it can. */
    function openElsewhere() {
        if (url) window.open(url, '_blank', 'noopener');
    }
    /** Put away: said at once and once, since the dialog's own close event comes later. */
    let closed = false;
    function finish() {
        if (closed) return;
        closed = true;
        if (dialog.open) dialog.close();
        onclose();
    }
    function onclick(event: MouseEvent) {
        if (event.target === dialog) finish();
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
    class="attachment-viewer viewer-{attrs.kind}"
    bind:this={dialog}
    onclose={finish}
    {onclick}
    aria-label={attrs.name}
>
    <header class="viewer-bar">
        <span class="viewer-title">{attrs.name || 'Attachment'}</span>
        <span class="small muted">{attrs.size ? sizeText(attrs.size) : ''}</span>
        <button class="btn" type="button" disabled={!url} onclick={download}>Download</button>
        {#if attrs.kind === 'file' || attrs.kind === 'pdf'}
            <button class="btn" type="button" disabled={!url} onclick={openElsewhere}>Open in a new tab</button>
        {/if}
        <button class="icon-btn" type="button" aria-label="Close" onclick={finish}><Icon name="close" /></button>
    </header>
    <div class="viewer-body">
        {#if loading}
            <p class="muted">Loading…</p>
        {:else if !url}
            <p class="muted">It isn't on this device, and the server can't be reached or doesn't have it yet.</p>
        {:else if attrs.kind === 'image'}
            <img src={url} alt={attrs.alt} />
        {:else if attrs.kind === 'video'}
            <!-- svelte-ignore a11y_media_has_caption -->
            <video src={url} controls autoplay playsinline aria-label={attrs.alt || attrs.name}></video>
        {:else if attrs.kind === 'pdf' && blob}
            <PdfPages {blob} />
        {:else}
            <div class="viewer-file">
                <p>{attrs.name}</p>
                <p class="small muted">{attrs.type || 'File'}{attrs.size ? ` · ${sizeText(attrs.size)}` : ''}</p>
            </div>
        {/if}
    </div>
</dialog>
