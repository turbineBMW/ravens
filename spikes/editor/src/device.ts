import { Editor, Node } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { generateKeyBetween } from 'fractional-indexing';
import * as Y from 'yjs';

export type Items = Y.Map<Y.Map<string | number | boolean>>;
export const LOCAL = 'local-item-edit';

function sorted(items: Items) {
    const all = [...items.entries()].map(([id, m]) => ({
        id,
        text: String(m.get('text') ?? ''),
        checked: Boolean(m.get('checked')),
        checkedAt: Number(m.get('checkedAt') ?? 0),
        pos: String(m.get('pos') ?? 'a0'),
    }));
    const open = all
        .filter((i) => !i.checked)
        .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id.localeCompare(b.id)));
    const done = all.filter((i) => i.checked).sort((a, b) => a.checkedAt - b.checkedAt || a.id.localeCompare(b.id));
    return [...open, ...done];
}

/** A block that shows one items map. Its text lives there, not in the body. */
const Checklist = Node.create<{ items: Items; doc: Y.Doc }>({
    name: 'checklist',
    group: 'block',
    atom: true,
    selectable: true,
    addAttributes: () => ({ list: { default: 'items' } }),
    parseHTML: () => [{ tag: 'div[data-checklist]' }],
    renderHTML: () => ['div', { 'data-checklist': '' }],
    addNodeView() {
        const { items, doc } = this.options;
        return () => {
            const dom = document.createElement('ul');
            dom.className = 'checklist';
            dom.contentEditable = 'false';
            const render = () => {
                const rows = new Map(
                    [...dom.querySelectorAll<HTMLLIElement>('li[data-id]')].map((li) => [li.dataset.id!, li]),
                );
                const list = sorted(items);
                list.forEach((item, at) => {
                    let li = rows.get(item.id);
                    if (!li) {
                        li = document.createElement('li');
                        li.dataset.id = item.id;
                        const box = document.createElement('input');
                        box.type = 'checkbox';
                        box.setAttribute('aria-label', 'Done');
                        box.onchange = () =>
                            doc.transact(() => {
                                const m = items.get(item.id)!;
                                m.set('checked', box.checked);
                                m.set('checkedAt', box.checked ? Date.now() : 0);
                            }, LOCAL);
                        const text = document.createElement('input');
                        text.className = 'text';
                        text.setAttribute('aria-label', 'Item');
                        text.oninput = () => doc.transact(() => items.get(item.id)!.set('text', text.value), LOCAL);
                        li.append(box, text);
                    }
                    rows.delete(item.id);
                    const [box, text] = li.children as unknown as [HTMLInputElement, HTMLInputElement];
                    box.checked = item.checked;
                    if (text.value !== item.text) text.value = item.text;
                    li.classList.toggle('done', item.checked);
                    if (dom.children[at] !== li) dom.insertBefore(li, dom.children[at] ?? add);
                });
                for (const li of rows.values()) li.remove();
            };
            const add = document.createElement('li');
            add.className = 'add';
            const input = document.createElement('input');
            input.className = 'text';
            input.placeholder = 'Add item';
            input.setAttribute('aria-label', 'Add item');
            input.onkeydown = (e) => {
                if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
                const open = sorted(items).filter((i) => !i.checked);
                const m = new Y.Map<string | number | boolean>();
                m.set('text', input.value);
                m.set('checked', false);
                m.set('checkedAt', 0);
                m.set('pos', generateKeyBetween(open[open.length - 1]?.pos ?? null, null));
                doc.transact(() => items.set(crypto.randomUUID().replaceAll('-', '').slice(0, 20), m), LOCAL);
                input.value = '';
            };
            add.append(input);
            dom.append(add);
            render();
            items.observeDeep(render);
            return {
                dom,
                // The rows handle their own typing and clicks; the editor stays out of them.
                stopEvent: () => true,
                ignoreMutation: () => true,
                destroy: () => items.unobserveDeep(render),
            };
        };
    },
});

export interface Device {
    doc: Y.Doc;
    items: Items;
    undo: Y.UndoManager;
    editor: Editor;
    destroy(): void;
}

/** One editor over one document. Every call to this is a separate device. */
export function mount(element: HTMLElement, doc: Y.Doc): Device {
    const fragment = doc.getXmlFragment('body');
    const items = doc.getMap('items') as Items;
    const undo = new Y.UndoManager([fragment, items], {
        trackedOrigins: new Set([ySyncPluginKey, LOCAL]),
        captureTimeout: 300,
    });
    const editor = new Editor({
        element,
        extensions: [
            StarterKit.configure({ undoRedo: false }),
            Highlight,
            TableKit,
            Checklist.configure({ items, doc }),
            Collaboration.configure({ fragment, yUndoOptions: { undoManager: undo } }),
        ],
    });
    return {
        doc,
        items,
        undo,
        editor,
        destroy() {
            editor.destroy();
            undo.destroy();
        },
    };
}
