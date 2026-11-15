/**
 * Attachment blocks for files and web pages, for the editor and quick
 * capture: each file kept on this device and queued for the server, with its
 * thumbnail made here; a page's preview fetched by the server, which keeps it
 * to public pages, with its image kept as the thumbnail.
 */
import { base } from '$app/paths';
import { newId } from '@ravens/ui/sync';
import type { AttachmentAttrs } from '$lib/attachmentNode.svelte';
import { addFile, DeviceFull, sizeText } from '$lib/files';
import { describe } from '$lib/thumbs';

export type AttachmentNode = { type: 'attachment'; attrs: Partial<AttachmentAttrs> };

/** The server's limit, as last heard; until then, its default. */
export let maxFile = 200 * 1024 * 1024;
export function setMaxFile(bytes: number) {
    maxFile = bytes;
}

/** What a file with no name of its own is called: a pasted screenshot, a photo. */
export function nameFor(file: File, kind: string) {
    if (file.name && file.name !== 'image.png') return file.name;
    const ext = (file.type.split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    return `${kind === 'image' ? 'Image' : 'File'} ${stamp}.${ext}`;
}

/** Blocks for files, and what went wrong with any that couldn't be added. */
export async function fileNodes(
    files: File[],
    progress: (text: string) => void = () => {},
): Promise<{ nodes: AttachmentNode[]; problem: string }> {
    const nodes: AttachmentNode[] = [];
    let problem = '';
    for (const file of files) {
        if (file.size > maxFile) {
            problem = `“${file.name}” is ${sizeText(file.size)}; attachments can be up to ${sizeText(maxFile)}.`;
            continue;
        }
        progress(files.length > 1 ? `Adding ${nodes.length + 1} of ${files.length}…` : 'Adding…');
        try {
            const made = await describe(file, file.name);
            const blob = await addFile(file);
            const thumb = made.thumb ? await addFile(made.thumb) : '';
            nodes.push({
                type: 'attachment',
                attrs: {
                    blob,
                    kind: made.kind,
                    name: nameFor(file, made.kind),
                    type: file.type || 'application/octet-stream',
                    size: file.size,
                    width: made.width,
                    height: made.height,
                    pages: made.pages,
                    thumb,
                },
            });
        } catch (err) {
            problem = err instanceof DeviceFull ? err.message : `Couldn’t add “${file.name}”.`;
        }
    }
    return { nodes, problem };
}

/** A card for a web page; throws, in words, when there's no preview to be had. */
export async function previewNode(url: string): Promise<AttachmentNode> {
    if (!navigator.onLine) throw new Error('Previews need a connection.');
    let res: Response;
    try {
        res = await fetch(`${base}/v1/preview?${new URLSearchParams({ url })}`);
    } catch {
        throw new Error('Previews need a connection.');
    }
    if (!res.ok) throw new Error(`Couldn’t get a preview of that page: ${(await res.text()) || 'no answer'}.`);
    const page = (await res.json()) as { url: string; title: string; description: string; image?: string };
    let thumb = '';
    if (page.image) {
        const img = await fetch(`${base}/v1/preview/image?${new URLSearchParams({ url: page.image })}`).catch(
            () => null,
        );
        if (img?.ok) thumb = await addFile(await img.blob()).catch(() => '');
    }
    return {
        type: 'attachment',
        attrs: {
            // A preview names no file; the id is its own, for the attachments list.
            blob: newId(),
            kind: 'link',
            url: page.url || url,
            title: page.title,
            description: page.description,
            thumb,
        },
    };
}
