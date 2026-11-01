// Regression tests for recovery and concurrent checklist behavior, without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const Y = require('yjs');
const { get } = require('svelte/store');
const docs = new Map();
const sync = {
    newId: () => require('node:crypto').randomUUID().replaceAll('-', '').slice(0, 20),
    openDoc: (_, name) => {
        if (!docs.has(name)) docs.set(name, { doc: new Y.Doc(), release() {} });
        return docs.get(name);
    },
    yStore: (map, read) => ({
        subscribe(fn) {
            fn(read());
            const changed = () => fn(read());
            map.observeDeep(changed);
            return () => map.unobserveDeep(changed);
        },
    }),
};
const compiled = ts.transpileModule(fs.readFileSync('huginn/web/src/lib/notes.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const model = { exports: {} };
new Function('require', 'exports', compiled)((name) => {
    if (name === '$app/paths') return { base: '/huginn' };
    if (name === '@ravens/ui/sync') return sync;
    return require(name);
}, model.exports);
const { openIndex, openNote, sortItems } = model.exports;
const index = openIndex();
const id = index.create('checklist');
const note = openNote(id, index);
note.setTitle('Groceries');
const milk = note.addItem('Milk');
const eggs = note.addItem('Eggs');
note.setChecked(eggs, true);
const remoteIndex = new Y.Doc();
const remoteNote = new Y.Doc();
Y.applyUpdate(remoteIndex, Y.encodeStateAsUpdate(index.doc.doc));
Y.applyUpdate(remoteNote, Y.encodeStateAsUpdate(note.doc.doc));
// One offline client deletes the note while another edits its content/preview.
index.remove(id);
remoteNote.getMap('items').get(milk).set('text', 'Oat milk');
remoteIndex.getMap('notes').get(id).set('preview', 'Oat milk');
Y.applyUpdate(index.doc.doc, Y.encodeStateAsUpdate(remoteIndex));
Y.applyUpdate(note.doc.doc, Y.encodeStateAsUpdate(remoteNote));
assert.ok(get(index.notes)[0].deletedAt > 0, 'concurrent edits must not restore a deleted note');
assert.equal(get(note.items).find((i) => i.id === milk).text, 'Oat milk');
index.restore(id);
assert.equal(get(index.notes)[0].deletedAt, 0);
assert.deepEqual(
    get(note.items).map((i) => i.id),
    [milk, eggs],
    'restoration preserves item/link IDs and checked state',
);
assert.equal(get(note.items)[1].checked, true);
// Reload the document from its persisted update, as on another device.
const reloaded = new Y.Doc();
Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(index.doc.doc));
assert.equal(reloaded.getMap('notes').get(id).get('deletedAt'), 0);
const tied = [
    { id: 'b', checked: false, pos: 'a0' },
    { id: 'a', checked: false, pos: 'a0' },
];
assert.deepEqual(
    sortItems(tied).map((i) => i.id),
    sortItems([...tied].reverse()).map((i) => i.id),
    'equal positions sort consistently',
);
// Legacy metadata without deletedAt remains visible.
index.doc.doc.getMap('notes').get(id).delete('deletedAt');
assert.equal(get(index.notes)[0].deletedAt, 0);
console.log(
    'PASS: trash/restore, concurrent offline edit, stable item IDs, persistence roundtrip, deterministic ordering, legacy metadata',
);
for (const held of docs.values()) held.doc.destroy();
remoteIndex.destroy();
remoteNote.destroy();
reloaded.destroy();
