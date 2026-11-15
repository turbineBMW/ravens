/**
 * Find in note: every match of what's being looked for, in the order they're
 * shown, with one of them current. Text in the body is highlighted here.
 * Checklist items aren't in the body (each block shows the list it names), so
 * they're read through `itemsOf` and their blocks highlight them. Finding
 * never edits the note or moves the caret.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findIn } from '$lib/find';
import type { Item } from '$lib/notes';

export type Match =
    | { kind: 'text'; from: number; to: number }
    /** `from` and `to` are the checklist block's; `at` and `end` are in the item's text. */
    | { kind: 'item'; from: number; to: number; list: string; item: string; at: number; end: number };

export interface FindState {
    query: string;
    matches: Match[];
    /** Which match is current, or -1 when there are none. */
    current: number;
    decorations: DecorationSet;
}

/** Look for something new, step to the next or previous match, or read the checklists again. */
export type FindAction = { query: string } | { step: 1 | -1 } | { refresh: true };

export const findKey = new PluginKey<FindState>('find-in-note');

export function findState(state: EditorState): FindState | undefined {
    return findKey.getState(state);
}

function collect(doc: PMNode, query: string, itemsOf: (list: string) => Item[]): Match[] {
    const found: Match[] = [];
    if (!query) return found;
    doc.descendants((node, pos) => {
        if (node.type.name === 'checklist') {
            const list = String(node.attrs.list);
            for (const item of itemsOf(list)) {
                for (const [at, end] of findIn(item.text, query)) {
                    found.push({ kind: 'item', from: pos, to: pos + node.nodeSize, list, item: item.id, at, end });
                }
            }
            return false;
        }
        if (!node.isTextblock) return true;
        // One character per position, so an offset in this text is an offset into the block.
        let text = '';
        node.forEach((child) => (text += child.isText ? child.text! : '￼'.repeat(child.nodeSize)));
        for (const [at, end] of findIn(text, query))
            found.push({ kind: 'text', from: pos + 1 + at, to: pos + 1 + end });
        return false;
    });
    return found;
}

function withDecorations(doc: PMNode, query: string, matches: Match[], current: number): FindState {
    const shown: Decoration[] = [];
    matches.forEach((m, i) => {
        if (m.kind === 'text') {
            shown.push(
                Decoration.inline(m.from, m.to, { class: i === current ? 'find-match find-current' : 'find-match' }),
            );
        }
    });
    return { query, matches, current, decorations: DecorationSet.create(doc, shown) };
}

export const FindInNote = Extension.create<{ itemsOf: (list: string) => Item[] }>({
    name: 'findInNote',
    addOptions: () => ({ itemsOf: () => [] }),
    addProseMirrorPlugins() {
        const { itemsOf } = this.options;
        return [
            new Plugin<FindState>({
                key: findKey,
                state: {
                    init: (_, state) => withDecorations(state.doc, '', [], -1),
                    apply(tr, value, _old, state) {
                        const action = tr.getMeta(findKey) as FindAction | undefined;
                        if (action && 'query' in action) {
                            // Start from the first match at or after the caret.
                            const matches = collect(state.doc, action.query, itemsOf);
                            const next = matches.findIndex((m) => m.from >= state.selection.from);
                            return withDecorations(
                                state.doc,
                                action.query,
                                matches,
                                matches.length ? Math.max(next, 0) : -1,
                            );
                        }
                        let { matches, current } = value;
                        const reread = tr.docChanged || (!!action && 'refresh' in action);
                        if (value.query && reread) {
                            // Stay on the same match when it's still there, or the next one after where it was.
                            const was = value.matches[value.current];
                            matches = collect(state.doc, value.query, itemsOf);
                            current = -1;
                            if (was?.kind === 'item') {
                                current = matches.findIndex(
                                    (m) => m.kind === 'item' && m.item === was.item && m.at === was.at,
                                );
                            }
                            if (was && current < 0) {
                                const at = tr.mapping.map(was.from);
                                current = matches.findIndex((m) => m.from >= at);
                            }
                            if (current < 0 && matches.length) current = 0;
                        }
                        if (action && 'step' in action && matches.length) {
                            current = (current + action.step + matches.length) % matches.length;
                        }
                        if (matches === value.matches && current === value.current) {
                            return tr.docChanged
                                ? { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) }
                                : value;
                        }
                        return withDecorations(state.doc, value.query, matches, current);
                    },
                },
                props: {
                    decorations: (state) => findKey.getState(state)?.decorations,
                },
            }),
        ];
    },
});
