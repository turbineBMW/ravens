/**
 * Addresses and phone numbers in the editor (see detect.ts): underlined, and a
 * click or tap on one, or on a link, reported with where it is, so a menu can
 * offer to open, mail, call or copy it. The caret still goes where it was
 * clicked, so they can be edited like any text; Ctrl+click (⌘-click) opens one
 * straight away, and Alt+Enter opens the menu for the one at the caret.
 */
import { Extension, getMarkRange } from '@tiptap/core';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { actionsFor, detectIn, type DetectedKind } from '$lib/detect';

const key = new PluginKey<DecorationSet>('dataDetectors');

/** Text a link or code is on stands in for nothing, so nothing's detected across or inside it. */
const skipped = (marks: readonly Mark[]) => marks.some((m) => m.type.name === 'link' || m.type.name === 'code');

function decorate(doc: PMNode): DecorationSet {
    const found: Decoration[] = [];
    doc.descendants((block, pos) => {
        if (!block.isTextblock) return true;
        if (block.type.spec.code) return false;
        let text = '';
        block.forEach((child) => {
            text += child.isText && !skipped(child.marks) ? child.text! : '\ufffc'.repeat(child.nodeSize);
        });
        for (const d of detectIn(text)) {
            found.push(
                Decoration.inline(
                    pos + 1 + d.at,
                    pos + 1 + d.end,
                    { class: 'detected', 'data-kind': d.kind },
                    { kind: d.kind, href: d.href },
                ),
            );
        }
        return false;
    });
    return DecorationSet.create(doc, found);
}

/** One detected, or a link, with its range in the document. */
export interface DetectedAt {
    kind: DetectedKind | 'link';
    href: string;
    text: string;
    from: number;
    to: number;
    /** A link in the note, rather than text that was detected. */
    mark: boolean;
}

/** What's detected, or linked, at a position: the caret, or a click. */
export function detectedAt(state: EditorState, pos: number): DetectedAt | null {
    const decorations = key.getState(state);
    // A position at either end counts, so the caret just after one finds it.
    const hit = decorations?.find(pos, pos)[0];
    if (hit) {
        const { kind, href } = hit.spec as { kind: DetectedKind; href: string };
        return { kind, href, text: state.doc.textBetween(hit.from, hit.to), from: hit.from, to: hit.to, mark: false };
    }
    const linkType = state.schema.marks.link;
    const range = linkType && getMarkRange(state.doc.resolve(pos), linkType);
    if (!range) return null;
    const mark = state.doc.nodeAt(range.from)?.marks.find((m) => m.type === linkType);
    const href = String(mark?.attrs.href ?? '');
    // Only what openHref will open, so the menu never offers what does nothing.
    if (!/^(https?|mailto|tel|sms):/i.test(href)) return null;
    const kind = /^mailto:/i.test(href) ? 'email' : /^tel:/i.test(href) ? 'phone' : 'link';
    return { kind, href, text: state.doc.textBetween(range.from, range.to), ...range, mark: true };
}

export interface DetectorOptions {
    /** One was clicked, or asked for at the caret: show what can be done with it, by where it is on screen. */
    onOpen: (found: DetectedAt & { left: number; top: number; bottom: number }, byKeyboard: boolean) => void;
}

/** What Ctrl+click opens: a link's address, or the first of what the menu offers. */
function opens(found: DetectedAt): string {
    return found.kind === 'link' ? found.href : actionsFor(found.kind, found.href)[0].href;
}

export function openHref(href: string) {
    // A web page in a new tab; mail, calls and messages go to the app that handles them. Nothing
    // else: a link synced from elsewhere could say anything, `javascript:` included.
    if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
    else if (/^(mailto|tel|sms):/i.test(href)) location.assign(href);
}

export const DataDetectors = Extension.create<DetectorOptions>({
    name: 'dataDetectors',
    addOptions: () => ({ onOpen: () => {} }),
    addProseMirrorPlugins() {
        const { onOpen } = this.options;
        const report = (view: EditorView, found: DetectedAt, byKeyboard: boolean) => {
            const { left, top } = view.coordsAtPos(found.from);
            const { bottom } = view.coordsAtPos(found.to);
            onOpen({ ...found, left, top, bottom }, byKeyboard);
        };
        return [
            new Plugin({
                key,
                state: {
                    init: (_, state) => decorate(state.doc),
                    apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
                },
                props: {
                    decorations: (state) => key.getState(state),
                    handleClick: (view, pos, event) => {
                        if (event.button !== 0 || event.shiftKey || event.altKey) return false;
                        const target = event.target as HTMLElement | null;
                        if (!target?.closest('.detected, a[href]')) return false;
                        const found = detectedAt(view.state, pos);
                        if (!found) return false;
                        if (event.ctrlKey || event.metaKey) {
                            openHref(opens(found));
                            return true;
                        }
                        report(view, found, false);
                        return false;
                    },
                    handleKeyDown: (view, event) => {
                        if (event.key !== 'Enter' || !event.altKey || event.ctrlKey || event.metaKey) return false;
                        const { selection } = view.state;
                        const found = selection.empty ? detectedAt(view.state, selection.from) : null;
                        if (!found) return false;
                        report(view, found, true);
                        return true;
                    },
                },
            }),
        ];
    },
});
