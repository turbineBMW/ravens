<script lang="ts">
    /**
     * An attachment as a note shows it: an image or a video in the column, a
     * PDF's first page, a file by its name and size, a link as a card. Under it,
     * where it stands (waiting, uploading, not here yet) and a menu: open it,
     * download it, its alt text, retry or cancel an upload, delete it.
     */
    import { readable, type Readable } from 'svelte/store';
    import { dismiss } from '$lib/dismiss';
    import Icon from '$lib/Icon.svelte';
    import {
        cancelUpload,
        fileBlob,
        fileStatus,
        fileUrl,
        isLocal,
        retryUpload,
        serverUrl,
        sizeText,
        type FileStatus,
    } from '$lib/files';
    import type { AttachmentAttrs } from '$lib/attachmentNode.svelte';

    let {
        attrs,
        selected,
        editable,
        open,
        change,
        remove,
    }: {
        attrs: AttachmentAttrs;
        selected: boolean;
        editable: () => boolean;
        open: () => void;
        change: (next: Partial<AttachmentAttrs>) => void;
        remove: () => void;
    } = $props();

    const isLink = $derived(attrs.kind === 'link');
    const none = readable<string | null>(null);
    /** What's shown in the column: the thumbnail, or a small image itself. */
    // By id, so a change to anything else (alt text, say) keeps the picture shown rather than loading it again.
    const pictureId = $derived(attrs.thumb || (attrs.kind === 'image' ? attrs.blob : ''));
    const fileId = $derived(isLink ? '' : attrs.blob);
    const isVideo = $derived(attrs.kind === 'video');
    const picture: Readable<string | null> = $derived(pictureId ? fileUrl(pictureId) : none);
    const status: Readable<FileStatus> = $derived(
        fileId ? fileStatus(fileId) : readable({ state: 'stored', progress: 1, error: '' } as FileStatus),
    );
    /** A video plays from this device when it's here, otherwise straight from the server, seeking as it goes. */
    let videoSrc = $state<string | null>(null);
    let localVideo: string | null = null;
    $effect(() => {
        const id = isVideo ? fileId : '';
        if (!id) return;
        let gone = false;
        void isLocal(id).then(async (here) => {
            if (gone) return;
            if (!here) return (videoSrc = serverUrl(id));
            const blob = await fileBlob(id);
            if (gone || !blob) return;
            localVideo = URL.createObjectURL(blob);
            videoSrc = localVideo;
        });
        return () => {
            gone = true;
            if (localVideo) URL.revokeObjectURL(localVideo);
            localVideo = null;
        };
    });

    const statusText = $derived.by(() => {
        const s = $status;
        switch (s.state) {
            case 'waiting':
                return 'Waiting to upload';
            case 'uploading':
                return `Uploading ${Math.round(s.progress * 100)}%`;
            case 'missing':
                return 'Not uploaded yet from the device it was added on';
            case 'offline':
                return 'Not on this device. Connect to see it.';
            case 'failed':
                return `Couldn’t upload: ${s.error}`;
            default:
                return '';
        }
    });
    const detail = $derived(
        [
            attrs.kind === 'pdf' && attrs.pages ? `${attrs.pages} ${attrs.pages === 1 ? 'page' : 'pages'}` : '',
            attrs.size ? sizeText(attrs.size) : '',
        ]
            .filter(Boolean)
            .join(' · '),
    );
    const extension = $derived((/\.([a-z0-9]{1,5})$/i.exec(attrs.name)?.[1] ?? 'file').toUpperCase());
    const host = $derived.by(() => {
        try {
            return new URL(attrs.url).host.replace(/^www\./, '');
        } catch {
            return '';
        }
    });
    const safeUrl = $derived(/^https?:\/\//i.test(attrs.url) ? attrs.url : '');
    /** Keeps the column from jumping as an image loads. */
    const ratio = $derived(attrs.width && attrs.height ? `${attrs.width} / ${attrs.height}` : undefined);

    let menu = $state<HTMLDetailsElement>();
    let editingAlt = $state(false);
    let alt = $state('');
    let problem = $state('');

    async function download() {
        if (menu) menu.open = false;
        problem = '';
        const blob = await fileBlob(attrs.blob);
        if (!blob) {
            problem = "It isn't on this device, and the server can't be reached.";
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = attrs.name || 'attachment';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    function startAlt() {
        if (menu) menu.open = false;
        alt = attrs.alt;
        editingAlt = true;
    }
    function saveAlt(event: SubmitEvent) {
        event.preventDefault();
        change({ alt: alt.trim() });
        editingAlt = false;
    }
    function act(run: () => void) {
        if (menu) menu.open = false;
        run();
    }
</script>

<figure class="attachment attachment-{attrs.kind}" class:selected data-state={$status.state}>
    {#if isLink}
        <a class="attachment-card link-card" href={safeUrl || undefined} target="_blank" rel="noopener noreferrer">
            {#if $picture}<img class="link-image" src={$picture} alt="" />{/if}
            <span class="card-text">
                <span class="card-title">{attrs.title || attrs.url}</span>
                {#if attrs.description}<span class="card-detail">{attrs.description}</span>{/if}
                <span class="card-detail muted">{host}</span>
            </span>
        </a>
    {:else if attrs.kind === 'image'}
        <button type="button" class="attachment-picture" onclick={open} aria-label="Open {attrs.alt || attrs.name}">
            {#if $picture}
                <img src={$picture} alt={attrs.alt} style:aspect-ratio={ratio} />
            {:else}
                <span class="picture-placeholder" style:aspect-ratio={ratio ?? '4 / 3'}></span>
            {/if}
        </button>
    {:else if attrs.kind === 'video'}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
            controls
            preload="metadata"
            playsinline
            poster={$picture ?? undefined}
            src={videoSrc ?? undefined}
            style:aspect-ratio={ratio}
            aria-label={attrs.alt || attrs.name}
        ></video>
    {:else}
        <button type="button" class="attachment-card" onclick={open}>
            {#if $picture}
                <img class="card-page" src={$picture} alt="" />
            {:else}
                <span class="file-icon" aria-hidden="true">{extension}</span>
            {/if}
            <span class="card-text">
                <span class="card-title">{attrs.name || 'Attachment'}</span>
                {#if detail}<span class="card-detail muted">{detail}</span>{/if}
            </span>
        </button>
    {/if}
    <figcaption class="attachment-bar">
        {#if editingAlt}
            <form class="alt-field" onsubmit={saveAlt}>
                <!-- svelte-ignore a11y_autofocus -->
                <input
                    bind:value={alt}
                    placeholder="Describe it for someone who can't see it"
                    aria-label="Alt text"
                    maxlength="500"
                    autofocus
                    onkeydown={(e) => e.key === 'Escape' && (editingAlt = false)}
                />
                <button class="btn" type="submit">Save</button>
            </form>
        {:else}
            <span class="small muted attachment-status" role="status">
                {problem || statusText || (attrs.alt && attrs.kind !== 'link' ? attrs.alt : '')}
            </span>
            {#if $status.state === 'failed' && editable()}
                <button class="btn" type="button" onclick={() => void retryUpload(attrs.blob)}>Retry</button>
            {/if}
            <details class="menu attachment-menu" bind:this={menu} use:dismiss>
                <summary class="icon-btn" aria-label="Actions for {attrs.name || attrs.title || 'attachment'}"
                    ><Icon name="more" /></summary
                >
                <div class="sheet actions">
                    {#if isLink}
                        {#if safeUrl}<a class="btn" href={safeUrl} target="_blank" rel="noopener noreferrer"
                                >Open link</a
                            >{/if}
                    {:else}
                        <button class="btn" type="button" onclick={() => act(open)}>Open</button>
                        <button class="btn" type="button" onclick={() => void download()}>Download</button>
                    {/if}
                    {#if editable()}
                        {#if attrs.kind === 'image' || attrs.kind === 'video'}
                            <button class="btn" type="button" onclick={startAlt}>Alt text…</button>
                        {/if}
                        {#if $status.state === 'waiting' || $status.state === 'uploading' || $status.state === 'failed'}
                            <button
                                class="btn"
                                type="button"
                                onclick={() =>
                                    act(() => {
                                        void cancelUpload(attrs.blob);
                                        if (attrs.thumb) void cancelUpload(attrs.thumb);
                                        remove();
                                    })}>Cancel upload</button
                            >
                        {/if}
                        <button class="btn danger" type="button" onclick={() => act(remove)}>Delete</button>
                    {/if}
                </div>
            </details>
        {/if}
    </figcaption>
</figure>
