/**
 * #tags in the editor: shown as tags, a click on one reported (the notes list
 * filters by it), and the tag being typed reported, with where it is on
 * screen, so the tags already used can be suggested beneath it. See tags.ts
 * for the rule.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { partialTag, tagMatches } from '$lib/tags';

const key = new PluginKey<DecorationSet>('hashtags');

function decorate(doc: PMNode): DecorationSet {
    const found: Decoration[] = [];
    doc.descendants((node, pos) => {
        if (!node.isText || !node.text) return;
        for (const m of tagMatches(node.text)) {
            found.push(
                Decoration.inline(pos + m.at, pos + m.at + 1 + m.name.length, { class: 'hashtag', 'data-tag': m.name }),
            );
        }
    });
    return DecorationSet.create(doc, found);
}

/** The tag being typed at the caret: what's typed after its `#`, and the whole word's range, `#` included. */
export interface TypedTag {
    typed: string;
    from: number;
    to: number;
}

export function typedTag(state: EditorState): TypedTag | null {
    const { selection } = state;
    if (!selection.empty || !selection.$from.parent.isTextblock) return null;
    const $at = selection.$from;
    const block = $at.parent;
    const typed = partialTag(block.textBetween(0, $at.parentOffset, undefined, '￼'));
    if (typed === null) return null;
    // A tag edited in the middle is replaced whole.
    const after = block.textBetween($at.parentOffset, block.content.size, undefined, '￼');
    const rest = /^[\p{Alphabetic}\p{N}_-]*/u.exec(after)![0];
    return { typed, from: $at.pos - typed.length - 1, to: $at.pos + rest.length };
}

export interface HashtagOptions {
    onTag: (name: string) => void;
    /** The tag being typed, and where its `#` is on screen; null when none is. */
    onTyping: (tag: (TypedTag & { left: number; top: number; bottom: number }) | null) => void;
    /** A key pressed while a tag is being typed: whether the suggestions took it. */
    onKey: (event: KeyboardEvent) => boolean;
}

export const Hashtags = Extension.create<HashtagOptions>({
    name: 'hashtags',
    // Ahead of the editor's own keys, so Enter and Tab pick a suggestion when one's showing.
    priority: 1000,
    addOptions: () => ({ onTag: () => {}, onTyping: () => {}, onKey: () => false }),
    addProseMirrorPlugins() {
        const { onTag, onTyping, onKey } = this.options;
        const report = (view: EditorView) => {
            const tag = view.hasFocus() ? typedTag(view.state) : null;
            if (!tag) return onTyping(null);
            const { left, top, bottom } = view.coordsAtPos(tag.from);
            onTyping({ ...tag, left, top, bottom });
        };
        return [
            new Plugin({
                key,
                state: {
                    init: (_, state) => decorate(state.doc),
                    apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
                },
                view: () => ({
                    update: (view, previous) => {
                        if (!previous.doc.eq(view.state.doc) || !previous.selection.eq(view.state.selection))
                            report(view);
                    },
                    destroy: () => onTyping(null),
                }),
                props: {
                    decorations: (state) => key.getState(state),
                    // The caret still goes where it was clicked, so a tag can be edited too.
                    handleClick: (_view, _pos, event) => {
                        const tag = (event.target as HTMLElement | null)?.closest<HTMLElement>('.hashtag')?.dataset.tag;
                        if (tag) onTag(tag);
                        return false;
                    },
                    handleKeyDown: (view, event) => (typedTag(view.state) ? onKey(event) : false),
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
