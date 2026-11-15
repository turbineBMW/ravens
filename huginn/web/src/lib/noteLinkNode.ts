/**
 * The editor's side of links between notes (see noteLinks.ts): the inline
 * `noteLink` node, the link being typed after `[[` (reported with where it is
 * on screen, so notes can be suggested beneath it), and pasting a Huginn
 * note's URL as a link. A note gets the format with links the moment one is
 * added here, typed, pasted or dropped.
 */
import { Node } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { partialLink, type LinkAttrs } from '$lib/noteLinks';

/** The link being typed: what's after its `[[`, and the range to replace, a closing `]]` included. */
export interface TypedLink {
    typed: string;
    from: number;
    to: number;
}

export function typedLink(state: EditorState): TypedLink | null {
    const { selection } = state;
    if (!selection.empty || !selection.$from.parent.isTextblock || selection.$from.parent.type.spec.code) return null;
    const $at = selection.$from;
    const block = $at.parent;
    const typed = partialLink(block.textBetween(0, $at.parentOffset, undefined, '￼'));
    if (typed === null || typed.includes('￼')) return null;
    const after = block.textBetween($at.parentOffset, block.content.size, undefined, '￼');
    return { typed, from: $at.pos - typed.length - 2, to: $at.pos + (after.startsWith(']]') ? 2 : 0) };
}

export const attrsOf = (node: PMNode): LinkAttrs => ({
    note: String(node.attrs.note ?? ''),
    section: String(node.attrs.section ?? ''),
    heading: String(node.attrs.heading ?? ''),
    label: String(node.attrs.label ?? ''),
});

function hasLink(doc: PMNode): boolean {
    let found = false;
    doc.descendants((node) => {
        if (node.type.name === 'noteLink') found = true;
        return !found;
    });
    return found;
}

export interface NoteLinkOptions {
    /** What a link says now, for the clipboard and plain text. */
    textOf: (attrs: LinkAttrs) => string;
    /** Show what a link says, and keep it current; returns a function that stops. */
    watch: (attrs: LinkAttrs, show: (text: string, state: 'live' | 'deleted' | 'missing') => void) => () => void;
    href: (attrs: LinkAttrs) => string;
    open: (attrs: LinkAttrs) => void;
    /** A link is in the note: raise its format, if it isn't already. */
    onLink: () => void;
    /** Whether the note still lacks the format with links. */
    needsFormat: () => boolean;
    /** A URL pasted on its own, as a link, if it's a Huginn note's. */
    parseUrl: (text: string) => { note: string; section: string } | null;
    onTyping: (link: (TypedLink & { left: number; top: number; bottom: number }) | null) => void;
    /** A key pressed while a link is being typed: whether the suggestions took it. */
    onKey: (event: KeyboardEvent) => boolean;
}

const typingKey = new PluginKey('note-link-typing');

export const NoteLink = Node.create<NoteLinkOptions>({
    name: 'noteLink',
    group: 'inline',
    inline: true,
    atom: true,
    selectable: true,
    draggable: false,
    // Ahead of the tag suggestions: `[[#` is a section, not a tag.
    priority: 1001,
    addOptions: () => ({
        textOf: () => '',
        watch: () => () => {},
        href: () => '#',
        open: () => {},
        onLink: () => {},
        needsFormat: () => false,
        parseUrl: () => null,
        onTyping: () => {},
        onKey: () => false,
    }),
    addAttributes: () =>
        Object.fromEntries(
            (['note', 'section', 'heading', 'label'] as const).map((name) => [
                name,
                {
                    default: '',
                    renderHTML: (attrs: Record<string, string>) =>
                        attrs[name] ? { [`data-${name}`]: attrs[name] } : {},
                },
            ]),
        ),
    // Copied links paste as links, in this note or another, as does any HTML link to a note.
    parseHTML() {
        const { parseUrl } = this.options;
        return [
            {
                tag: 'a[href]',
                priority: 100,
                getAttrs: (el) => {
                    const target = parseUrl(el.getAttribute('href') ?? '');
                    if (!target) return false;
                    const data = (name: string) => el.getAttribute(`data-${name}`) ?? '';
                    return { ...target, heading: data('heading'), label: data('label') };
                },
            },
        ];
    },
    renderHTML({ node, HTMLAttributes }) {
        const attrs = attrsOf(node);
        return [
            'a',
            { ...HTMLAttributes, 'data-note-link': '', href: new URL(this.options.href(attrs), location.origin).href },
            this.options.textOf(attrs),
        ];
    },
    renderText({ node }) {
        return this.options.textOf(attrsOf(node));
    },
    addNodeView() {
        const { watch, href, open } = this.options;
        return ({ node }) => {
            const attrs = attrsOf(node);
            const dom = document.createElement('a');
            dom.className = 'note-link';
            dom.contentEditable = 'false';
            dom.href = href(attrs);
            const stop = watch(attrs, (text, state) => {
                dom.textContent = text;
                dom.dataset.state = state;
                dom.title =
                    state === 'deleted'
                        ? 'This note is in Recently Deleted'
                        : state === 'missing'
                          ? "This note isn't in your library"
                          : '';
            });
            // A plain click follows the link; with a modifier, the browser does what it does.
            dom.addEventListener('click', (event) => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                open(attrs);
            });
            return {
                dom,
                update: (next) => next.type === node.type && JSON.stringify(attrsOf(next)) === JSON.stringify(attrs),
                ignoreMutation: () => true,
                destroy: stop,
            };
        };
    },
    addProseMirrorPlugins() {
        const { onLink, needsFormat, parseUrl, onTyping, onKey } = this.options;
        const type = this.type;
        const report = (view: EditorView) => {
            const link = view.hasFocus() ? typedLink(view.state) : null;
            if (!link) return onTyping(null);
            const { left, top, bottom } = view.coordsAtPos(link.from);
            onTyping({ ...link, left, top, bottom });
        };
        return [
            new Plugin({
                key: typingKey,
                // However a link arrived on this device, the note needs the format with links.
                appendTransaction(transactions, _old, state) {
                    const local = transactions.some((t) => t.docChanged && !t.getMeta(ySyncPluginKey)?.isChangeOrigin);
                    if (local && needsFormat() && hasLink(state.doc)) onLink();
                    return null;
                },
                view: () => ({
                    update: (view, previous) => {
                        if (!previous.doc.eq(view.state.doc) || !previous.selection.eq(view.state.selection))
                            report(view);
                    },
                    destroy: () => onTyping(null),
                }),
                props: {
                    handleKeyDown: (view, event) => (typedLink(view.state) ? onKey(event) : false),
                    handlePaste(view, event) {
                        // HTML is parsed as usual, a link to a note included.
                        if (event.clipboardData?.getData('text/html')) return false;
                        const target = parseUrl(event.clipboardData?.getData('text/plain') ?? '');
                        if (!target || view.state.selection.$from.parent.type.spec.code) return false;
                        view.dispatch(
                            view.state.tr.replaceSelectionWith(
                                type.create({ ...target, heading: '', label: '' }),
                                false,
                            ),
                        );
                        return true;
                    },
                    handleDOMEvents: {
                        blur: () => {
                            onTyping(null);
                            return false;
                        },
                        focus: (view) => {
                            report(view);
                            return false;
                        },
                    },
                },
            }),
        ];
    },
});
