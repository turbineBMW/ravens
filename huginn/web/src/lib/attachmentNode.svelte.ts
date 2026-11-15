/**
 * An attachment in a note (format 6): a block naming a file by its id
 * (files.ts), with what's needed to show it before the file itself arrives:
 * its kind, name, media type, size, dimensions, a PDF's pages, its
 * thumbnail's own file, and alt text. A link preview is one too, with the
 * page's address, title and description, its image as the thumbnail, and an
 * id of its own that names no file. Copying the block copies the reference:
 * both copies show the same file.
 */
import { Node } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { mount, unmount } from 'svelte';
import AttachmentBlock from '$lib/AttachmentBlock.svelte';

export const ATTACHMENT_DEFAULTS = {
    blob: '',
    kind: 'file',
    name: '',
    type: '',
    size: 0,
    width: 0,
    height: 0,
    pages: 0,
    thumb: '',
    alt: '',
    url: '',
    title: '',
    description: '',
};
export type AttachmentAttrs = typeof ATTACHMENT_DEFAULTS;
const NUMBERS = new Set(['size', 'width', 'height', 'pages']);

export function attachmentAttrs(node: PMNode): AttachmentAttrs {
    const out = { ...ATTACHMENT_DEFAULTS } as Record<string, string | number>;
    for (const key of Object.keys(ATTACHMENT_DEFAULTS)) {
        const v = node.attrs[key];
        out[key] = NUMBERS.has(key) ? Number(v) || 0 : String(v ?? '');
    }
    return out as AttachmentAttrs;
}

export interface AttachmentOptions {
    /** Show it whole: an image full size, a video, a PDF's pages, a file opened. */
    open: (attrs: AttachmentAttrs) => void;
    /** The note can't hold attachments yet: raise its format. */
    onAttach: () => void;
    needsFormat: () => boolean;
}

function hasAttachment(doc: PMNode) {
    let found = false;
    doc.descendants((n) => {
        if (n.type.name === 'attachment') found = true;
        return !found;
    });
    return found;
}

export const Attachment = Node.create<AttachmentOptions>({
    name: 'attachment',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    addOptions: () => ({ open: () => {}, onAttach: () => {}, needsFormat: () => false }),
    addAttributes: () =>
        Object.fromEntries(
            Object.entries(ATTACHMENT_DEFAULTS).map(([name, fallback]) => [
                name,
                {
                    default: fallback,
                    parseHTML: (el: HTMLElement) => {
                        const v = el.getAttribute(`data-${name}`) ?? '';
                        return NUMBERS.has(name) ? Number(v) || 0 : v;
                    },
                    renderHTML: (attrs: Record<string, unknown>) =>
                        attrs[name] ? { [`data-${name}`]: String(attrs[name]) } : {},
                },
            ]),
        ),
    // Copied within Huginn, it pastes as itself.
    parseHTML: () => [{ tag: 'div[data-attachment]' }],
    renderHTML({ node, HTMLAttributes }) {
        const a = attachmentAttrs(node);
        return ['div', { ...HTMLAttributes, 'data-attachment': '' }, a.kind === 'link' ? a.title || a.url : a.name];
    },
    renderText({ node }) {
        const a = attachmentAttrs(node);
        return a.kind === 'link' ? a.url : `[${a.name || 'Attachment'}]`;
    },
    addNodeView() {
        const { open } = this.options;
        return ({ node, getPos, editor }) => {
            const props = $state({ attrs: attachmentAttrs(node), selected: false });
            const dom = document.createElement('div');
            dom.className = 'note-attachment';
            dom.contentEditable = 'false';
            dom.dataset.blob = props.attrs.blob;
            const change = (next: Partial<AttachmentAttrs>) => {
                const pos = getPos();
                if (typeof pos !== 'number') return;
                editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...props.attrs, ...next }));
            };
            const remove = () => {
                const pos = getPos();
                if (typeof pos !== 'number') return;
                const at = editor.state.doc.nodeAt(pos);
                if (at) editor.view.dispatch(editor.state.tr.delete(pos, pos + at.nodeSize));
            };
            const block = mount(AttachmentBlock, {
                target: dom,
                props: {
                    get attrs() {
                        return props.attrs;
                    },
                    get selected() {
                        return props.selected;
                    },
                    editable: () => editor.isEditable,
                    open: () => open(props.attrs),
                    change,
                    remove,
                },
            });
            return {
                dom,
                update: (next) => {
                    if (next.type !== node.type) return false;
                    props.attrs = attachmentAttrs(next);
                    dom.dataset.blob = props.attrs.blob;
                    return true;
                },
                selectNode: () => {
                    props.selected = true;
                    dom.classList.add('ProseMirror-selectednode');
                },
                deselectNode: () => {
                    props.selected = false;
                    dom.classList.remove('ProseMirror-selectednode');
                },
                // Its buttons and fields handle their own events; a drag from its frame moves it.
                stopEvent: (event) => {
                    const target = event.target as HTMLElement | null;
                    if (event.type.startsWith('drag')) return !!target?.closest('button, input, textarea, video');
                    return !!target?.closest('button, input, textarea, video, a, .attachment-menu');
                },
                ignoreMutation: () => true,
                destroy: () => void unmount(block),
            };
        };
    },
    addProseMirrorPlugins() {
        const { onAttach, needsFormat } = this.options;
        return [
            new Plugin({
                key: new PluginKey('attachment-format'),
                // However an attachment arrived on this device, the note needs the format with them.
                appendTransaction(transactions, _old, state) {
                    const local = transactions.some((t) => t.docChanged && !t.getMeta(ySyncPluginKey)?.isChangeOrigin);
                    if (local && needsFormat() && hasAttachment(state.doc)) onAttach();
                    return null;
                },
            }),
        ];
    },
});
