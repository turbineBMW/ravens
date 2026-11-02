/**
 * Sections: every heading gets a stable `section` ID, synced with the note, so
 * links (reminders, later note links) can point at it. Collapsing a section is
 * this device's view only, kept per note in local storage.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { newId } from '@ravens/ui/sync';

const ids = new PluginKey('section-ids');
const collapse = new PluginKey<Set<string>>('section-collapse');

/** The heading a position is under, if any: what a link to that spot should name. */
export function sectionAt(state: EditorState, pos: number): string | null {
    let found: string | null = null;
    state.doc.forEach((node, offset) => {
        if (offset <= pos && node.type.name === 'heading' && node.attrs.section) found = node.attrs.section;
    });
    return found;
}

/** Expand a section if it's collapsed, and bring it into view. */
export function revealSection(view: import('@tiptap/pm/view').EditorView, section: string) {
    const hidden = collapse.getState(view.state);
    if (hidden?.has(section)) view.dispatch(view.state.tr.setMeta(collapse, section));
    view.dom.querySelector(`[data-section="${CSS.escape(section)}"]`)?.scrollIntoView({ block: 'start' });
}

function load(key: string): Set<string> {
    try {
        return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'));
    } catch {
        return new Set();
    }
}
function save(key: string, value: Set<string>) {
    try {
        if (value.size) localStorage.setItem(key, JSON.stringify([...value]));
        else localStorage.removeItem(key);
    } catch {
        /* Collapsing still works for this visit. */
    }
}

/** Top-level nodes a collapsed heading hides: everything up to the next heading at its level or above. */
function hiddenRanges(doc: PMNode, collapsed: Set<string>) {
    const ranges: [number, number][] = [];
    let hidingUnder: number | null = null;
    doc.forEach((node, offset) => {
        const level = node.type.name === 'heading' ? Number(node.attrs.level) : null;
        if (level !== null && hidingUnder !== null && level <= hidingUnder) hidingUnder = null;
        if (hidingUnder !== null) {
            ranges.push([offset, offset + node.nodeSize]);
            return;
        }
        if (level !== null && collapsed.has(node.attrs.section)) hidingUnder = level;
    });
    return ranges;
}

export const Sections = Extension.create<{ noteId: string }>({
    name: 'sections',
    addOptions: () => ({ noteId: '' }),
    addGlobalAttributes: () => [
        {
            types: ['heading'],
            attributes: {
                section: {
                    default: null,
                    parseHTML: (el) => el.getAttribute('data-section'),
                    renderHTML: (attrs) => (attrs.section ? { 'data-section': attrs.section } : {}),
                },
            },
        },
    ],
    addProseMirrorPlugins() {
        const storageKey = `huginn-collapsed:${this.options.noteId}`;
        return [
            // Give new, split or pasted headings their own ID. Only the device making
            // the change does this, so two devices never race to name one heading.
            new Plugin({
                key: ids,
                appendTransaction(transactions, _old, state) {
                    if (!transactions.some((t) => t.docChanged && !t.getMeta(ySyncPluginKey)?.isChangeOrigin)) {
                        return null;
                    }
                    const seen = new Set<string>();
                    const tr = state.tr;
                    state.doc.forEach((node, offset) => {
                        if (node.type.name !== 'heading') return;
                        const section = node.attrs.section as string | null;
                        if (section && !seen.has(section)) {
                            seen.add(section);
                            return;
                        }
                        const fresh = newId();
                        seen.add(fresh);
                        tr.setNodeMarkup(offset, undefined, { ...node.attrs, section: fresh });
                    });
                    return tr.docChanged ? tr : null;
                },
            }),
            new Plugin<Set<string>>({
                key: collapse,
                state: {
                    init: () => load(storageKey),
                    apply(tr, value) {
                        const toggled = tr.getMeta(collapse) as string | undefined;
                        if (!toggled) return value;
                        const next = new Set(value);
                        if (!next.delete(toggled)) next.add(toggled);
                        save(storageKey, next);
                        return next;
                    },
                },
                props: {
                    decorations(state) {
                        const collapsed = collapse.getState(state)!;
                        const decorations: Decoration[] = [];
                        state.doc.forEach((node, offset) => {
                            const section = node.attrs.section as string | undefined;
                            if (node.type.name !== 'heading' || !section) return;
                            const closed = collapsed.has(section);
                            decorations.push(
                                Decoration.widget(
                                    offset + 1,
                                    (view) => {
                                        const button = document.createElement('button');
                                        button.type = 'button';
                                        button.className = 'section-toggle';
                                        button.contentEditable = 'false';
                                        button.textContent = closed ? '▸' : '▾';
                                        button.setAttribute(
                                            'aria-label',
                                            closed ? 'Expand section' : 'Collapse section',
                                        );
                                        button.setAttribute('aria-expanded', String(!closed));
                                        button.onmousedown = (e) => e.preventDefault();
                                        button.onclick = () => {
                                            const tr = view.state.tr.setMeta(collapse, section);
                                            // Keep the caret out of what's about to be hidden.
                                            const heading = view.state.doc.resolve(offset + 1);
                                            if (!closed && view.state.selection.from > offset + node.nodeSize) {
                                                tr.setSelection(TextSelection.create(tr.doc, heading.end()));
                                            }
                                            view.dispatch(tr);
                                        };
                                        return button;
                                    },
                                    { side: -1, ignoreSelection: true, key: `toggle-${section}-${closed}` },
                                ),
                            );
                        });
                        for (const [from, to] of hiddenRanges(state.doc, collapsed)) {
                            decorations.push(Decoration.node(from, to, { class: 'section-hidden' }));
                        }
                        return DecorationSet.create(state.doc, decorations);
                    },
                },
            }),
        ];
    },
});
