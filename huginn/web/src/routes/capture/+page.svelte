<script lang="ts">
    /**
     * Quick capture: something to keep, fast, into the Inbox folder. Text, a
     * link (kept as the note's source, with a preview card when there's a
     * connection) and files. What's shared to Huginn from another app (when
     * it's installed) arrives here filled in: the service worker keeps it for
     * this page (`?share=`).
     */
    import { getContext, onMount } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import { page } from '$app/state';
    import EditorBar from '$lib/EditorBar.svelte';
    import { detectIn } from '$lib/detect';
    import { sizeText } from '$lib/files';
    import { createNote, paragraph, type PMNode } from '$lib/importText';
    import { fileNodes, previewNode } from '$lib/newAttachments';
    import type { Index } from '$lib/notes';
    import { noteHref } from '$lib/scope';

    const index = getContext<Index>('index');
    const folders = index.folders;
    let text = $state('');
    let url = $state('');
    let files = $state<File[]>([]);
    let saving = $state('');
    let problem = $state('');
    let picker = $state<HTMLInputElement>();
    let field = $state<HTMLTextAreaElement>();
    const empty = $derived(!text.trim() && !url.trim() && !files.length);

    /** What another app shared, kept by the service worker until this page takes it. */
    async function takeShared(key: string) {
        const cache = await caches.open('huginn-share');
        const at = (path: string) => `${location.origin}${base}/share/${key}/${path}`;
        const data = await cache.match(at('data'));
        if (!data) return;
        const shared = (await data.json()) as {
            title: string;
            text: string;
            url: string;
            files: { name: string; type: string }[];
        };
        const got: File[] = [];
        for (const [i, f] of shared.files.entries()) {
            const res = await cache.match(at(`file/${i}`));
            if (res) got.push(new File([await res.blob()], f.name, { type: f.type }));
            await cache.delete(at(`file/${i}`));
        }
        await cache.delete(at('data'));
        // Many apps share a link inside the text, not as one.
        let sharedUrl = shared.url;
        let sharedText = [shared.title, shared.text].filter(Boolean).join('\n');
        if (!sharedUrl) {
            const found = detectIn(sharedText).find((d) => d.kind === 'url');
            if (found) {
                sharedUrl = found.href;
                sharedText = (sharedText.slice(0, found.at) + sharedText.slice(found.end)).trim();
            }
        }
        text = sharedText;
        url = sharedUrl;
        files = got;
    }

    onMount(() => {
        const key = page.url.searchParams.get('share');
        if (key) void takeShared(key).catch(() => (problem = 'What was shared couldn’t be read.'));
        field?.focus();
    });

    /** The Inbox folder at the top level, made the first time. */
    function inbox(): string {
        const found = $folders.find((f) => !f.deletedAt && !f.parent && f.name.trim().toLowerCase() === 'inbox');
        return found?.id ?? index.createFolder('Inbox', '');
    }

    async function save(event: SubmitEvent) {
        event.preventDefault();
        if (empty || saving) return;
        problem = '';
        saving = 'Saving…';
        const content: PMNode[] = [];
        const link = url.trim() ? (/^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`) : '';
        let preview: PMNode | null = null;
        if (link && /^https?:/i.test(link)) {
            saving = 'Getting a preview…';
            preview = await previewNode(link).catch(() => null);
        }
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        // The first line is the title; without text, the page's title is.
        const title = lines[0]?.trim() || String(preview?.attrs?.title ?? '') || link || files[0]?.name || 'Captured';
        content.push(paragraph([{ type: 'text', text: title }]));
        for (const line of lines.slice(1)) content.push(paragraph(line ? [{ type: 'text', text: line }] : []));
        if (link) {
            content.push(paragraph([{ type: 'text', text: link, marks: [{ type: 'link', attrs: { href: link } }] }]));
            if (preview) content.push(preview);
        }
        if (files.length) {
            const added = await fileNodes(files, (t) => (saving = t));
            content.push(...added.nodes);
            problem = added.problem;
        }
        try {
            const id = await createNote(index, content, inbox());
            void goto(noteHref(id, { kind: 'all' }));
        } catch {
            problem = 'Couldn’t save it on this device.';
        } finally {
            saving = '';
        }
    }

    function picked(input: HTMLInputElement) {
        files = [...files, ...(input.files ?? [])];
        input.value = '';
    }
</script>

<EditorBar back={`${base}/`} subtitle="Into the Inbox folder">
    <h1>Quick capture</h1>
</EditorBar>
<form class="capture" onsubmit={save}>
    <textarea
        bind:this={field}
        bind:value={text}
        rows="6"
        placeholder="What to keep. The first line is the title."
        aria-label="What to keep"
    ></textarea>
    <input
        class="capture-link"
        bind:value={url}
        type="text"
        inputmode="url"
        placeholder="A link, if there is one"
        aria-label="Link"
        autocomplete="off"
    />
    {#if files.length}
        <ul class="capture-files" aria-label="Files">
            {#each files as f, i (i)}
                <li>
                    <span>{f.name}</span>
                    <span class="small muted">{sizeText(f.size)}</span>
                    <button class="btn" type="button" onclick={() => (files = files.filter((_, j) => j !== i))}
                        >Remove</button
                    >
                </li>
            {/each}
        </ul>
    {/if}
    <div class="actions-row">
        <button class="btn" type="button" onclick={() => picker?.click()}>Add files</button>
        <button class="btn primary" type="submit" disabled={empty || !!saving}>{saving || 'Save'}</button>
    </div>
    {#if problem}<p class="small muted" role="alert">{problem}</p>{/if}
    <input bind:this={picker} type="file" multiple hidden onchange={(e) => picked(e.currentTarget)} />
</form>
