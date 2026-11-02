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
const { NOTE_FORMAT, migrationSeed, openIndex, openNote, sortItems } = model.exports;
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

// A store sees changes made before its first subscriber (the real yStore, not the stand-in).
const syncSource = ts.transpileModule(fs.readFileSync('shared/ui/src/sync.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const realSync = { exports: {} };
new Function('require', 'exports', syncSource)(require, realSync.exports);
const late = new Y.Doc();
const lateMap = late.getMap('meta');
const lateStore = realSync.exports.yStore(lateMap, () => lateMap.get('title') ?? '');
lateMap.set('title', 'Arrived before the first subscriber');
assert.equal(get(lateStore), 'Arrived before the first subscriber');
late.destroy();

// ---- frozen format 1 documents ----
const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/huginn-format-1.json', 'utf8'));
const load = (doc, b64) => Y.applyUpdate(doc, Buffer.from(b64, 'base64'));
const stateOf = (doc) => Buffer.from(Y.encodeStateVector(doc)).toString('base64');
docs.clear();
const fixtureIndex = openIndex();
load(fixtureIndex.doc.doc, fixture.index);
const GROCERIES = 'fixturegroceries001';
const open = (id) => {
    const n = openNote(id, fixtureIndex);
    if (fixture.notes[id]) load(n.doc.doc, fixture.notes[id]);
    return n;
};
const entry = (id) => get(fixtureIndex.notes).find((n) => n.id === id);
const groceries = open(GROCERIES);
assert.equal(NOTE_FORMAT, 2);
assert.equal(get(groceries.tooNew), false, 'a note without a format is format 1');
assert.equal(get(groceries.title), 'Groceries');
assert.deepEqual(
    get(groceries.items).map((i) => [i.id, i.checked]),
    [
        ['itemmilk0000000000a1', false],
        ['itemeggs0000000000a2', false],
        ['itemtieda000000000a4', false],
        ['itemtiedb000000000a3', false],
        ['itemolive000000000a6', true],
        ['itemcoffee00000000a5', true],
    ],
    'format 1 items keep their IDs, order and checked state',
);
assert.equal(entry(GROCERIES).deletedAt, 0, 'an index entry without deletedAt is active');

// A stale index entry is corrected from the note, without looking like an edit.
const before = entry(GROCERIES);
groceries.repairIndex();
const after = entry(GROCERIES);
assert.equal(after.preview, 'Milk\nEggs\nTied position A\nTied position B');
assert.deepEqual([after.open, after.done], [4, 2]);
assert.equal(after.updated, before.updated, 'repair does not reorder the list');
assert.equal(after.pinned, true);
const repaired = stateOf(fixtureIndex.doc.doc);
groceries.repairIndex();
assert.equal(stateOf(fixtureIndex.doc.doc), repaired, 'repair writes nothing when already correct');
// A note with no content here may just not be downloaded: its entry stands.
const absent = openNote('fixturenotdownload2', fixtureIndex);
absent.repairIndex();
assert.equal(entry('fixturenotdownload2').title, 'Not downloaded here');
assert.equal(entry('fixturenotdownload2').preview, 'Bread');

// Two offline devices edit the same format 1 note, then meet.
const deviceA = new Y.Doc();
const deviceB = new Y.Doc();
load(deviceA, fixture.notes[GROCERIES]);
load(deviceB, fixture.notes[GROCERIES]);
deviceA.getMap('items').get('itemmilk0000000000a1').set('text', 'Oat milk');
deviceB.getMap('items').get('itemeggs0000000000a2').set('checked', true);
Y.applyUpdate(deviceA, Y.encodeStateAsUpdate(deviceB));
Y.applyUpdate(deviceB, Y.encodeStateAsUpdate(deviceA));
for (const device of [deviceA, deviceB]) {
    assert.equal(device.getMap('items').get('itemmilk0000000000a1').get('text'), 'Oat milk');
    assert.equal(device.getMap('items').get('itemeggs0000000000a2').get('checked'), true);
    assert.equal(device.getMap('items').size, 6);
}

// ---- format 2 ----
// These exact bytes are what every device must keep producing, forever.
assert.equal(
    Buffer.from(migrationSeed(GROCERIES)).toString('hex'),
    '0104d4bb800c002801046d65746106666f726d6174017d02070104626f64790309636865636b6c6973742800d4bb800c01046c6973740177056974656d7387d4bb800c01030970617261677261706800',
    'the migration seed must never change',
);
const migratedFormatOne = () => {
    const d = openNote(GROCERIES, fixtureIndex);
    return d;
};
const itemsBefore = JSON.stringify(groceries.doc.doc.getMap('items').toJSON());
groceries.migrate(false);
const seededOnce = stateOf(groceries.doc.doc);
assert.equal(get(groceries.format), 2);
assert.equal(JSON.stringify(groceries.doc.doc.getMap('items').toJSON()), itemsBefore, 'migration leaves items alone');
assert.equal(get(groceries.title), 'Groceries', 'an existing title stays explicit');
assert.deepEqual(
    groceries.body.toArray().map((n) => n.nodeName),
    ['checklist', 'paragraph'],
);
assert.equal(get(groceries.hasChecklist), true);
groceries.migrate(true);
assert.equal(stateOf(groceries.doc.doc), seededOnce, 'migrating twice writes nothing');
assert.equal(migratedFormatOne().doc.doc, groceries.doc.doc);
// Two offline devices migrate on their own and agree.
const offlineA = new Y.Doc();
const offlineB = new Y.Doc();
for (const device of [offlineA, offlineB]) {
    load(device, fixture.notes[GROCERIES]);
    Y.applyUpdate(device, migrationSeed(GROCERIES));
}
Y.applyUpdate(offlineA, Y.encodeStateAsUpdate(offlineB));
assert.deepEqual(
    offlineA
        .getXmlFragment('body')
        .toArray()
        .map((n) => n.nodeName),
    ['checklist', 'paragraph'],
    'two migrations make one checklist',
);
offlineA.destroy();
offlineB.destroy();

// A note with nothing on this device isn't migrated until the server's copy proves it empty.
const emptyIndex = fixtureIndex.create('checklist');
const emptyNote = openNote(emptyIndex, fixtureIndex);
emptyNote.migrate(false);
assert.equal(get(emptyNote.format), 0, 'not downloaded yet');
emptyNote.migrate(true);
assert.equal(get(emptyNote.format), 2, 'a synced empty checklist note migrates');
// A new note whose creator hasn't uploaded it is never mistaken for format 1.
const pendingNew = fixtureIndex.create('text');
const pendingNote = openNote(pendingNew, fixtureIndex);
pendingNote.migrate(true);
assert.equal(get(pendingNote.format), 0);
assert.equal(pendingNote.body.length, 0);

// A new note, and the title rule: the first line, unless a title is set.
const freshId = fixtureIndex.create('text');
const fresh = openNote(freshId, fixtureIndex);
fresh.initialise();
assert.equal(get(fresh.format), 2);
assert.equal(get(fresh.hasChecklist), false);
const writeLines = (lines) => {
    const blocks = lines.map((text) => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(text)]);
        return paragraph;
    });
    fresh.doc.doc.transact(() => fresh.body.insert(fresh.body.length, blocks));
};
writeLines(['First line', 'Second line']);
fresh.repairIndex();
assert.equal(entry(freshId).title, 'First line');
assert.equal(entry(freshId).preview, 'Second line', 'the title is not repeated in the preview');
assert.equal(get(fresh.firstLine), 'First line');
assert.equal(get(fresh.title), '', 'the first line is not stored as a title');
fresh.setTitle('Set title');
assert.equal(entry(freshId).title, 'Set title');
assert.equal(entry(freshId).preview, 'First line\nSecond line');
fresh.setTitle('');
assert.equal(entry(freshId).title, 'First line', 'clearing the title returns to the first line');
assert.equal(entry(freshId).open, 0, 'a note without a checklist counts no items');
// Typing reaches the index when the note lets go, at the latest.
writeLines(['Third line']);
fresh.release();
assert.equal(entry(freshId).preview, 'Second line\nThird line');

// Plain text keeps structure.
groceries.setTitle('Groceries');
const bold = new Y.XmlText();
bold.insert(0, 'Plain ');
bold.insert(6, 'bold', { bold: {} });
const prose = new Y.XmlElement('paragraph');
prose.insert(0, [bold]);
const listItem = new Y.XmlElement('listItem');
const inList = new Y.XmlElement('paragraph');
inList.insert(0, [new Y.XmlText('In a list')]);
listItem.insert(0, [inList]);
const list = new Y.XmlElement('bulletList');
list.insert(0, [listItem]);
groceries.doc.doc.transact(() => groceries.body.insert(groceries.body.length, [prose, list]));
const exported = groceries.plainText();
for (const line of ['Groceries', '[ ] Milk', '[x] Coffee', 'Plain bold', '- In a list']) {
    assert.ok(exported.split('\n').includes(line), `export lacks "${line}": ${exported}`);
}

// A note from a newer client can't be changed by this one, in any way.
const newer = open('fixtureuntitled0003');
load(newer.doc.doc, fixture.notes[GROCERIES]);
newer.doc.doc.getMap('meta').set('format', NOTE_FORMAT + 1);
newer.migrate(true);
assert.equal(get(newer.tooNew), true);
const frozenNote = stateOf(newer.doc.doc);
const frozenIndex = stateOf(fixtureIndex.doc.doc);
newer.setTitle('Overwritten');
assert.equal(newer.addItem('New'), '');
newer.setText('itemmilk0000000000a1', 'Overwritten');
newer.setChecked('itemmilk0000000000a1', true);
newer.move('itemmilk0000000000a1', 'itemeggs0000000000a2', null);
newer.remove('itemmilk0000000000a1');
newer.uncheckAll();
newer.removeChecked();
newer.repairIndex();
assert.equal(stateOf(newer.doc.doc), frozenNote, 'no edit reaches a newer note');
assert.equal(stateOf(fixtureIndex.doc.doc), frozenIndex, 'nor its index entry');
console.log(
    'PASS: trash/restore, concurrent offline edit, stable item IDs, persistence roundtrip, deterministic ordering, legacy metadata, format 1 fixtures, index repair, seed bytes, migration guards, title rule, plain text, newer-format guard, late store subscribers',
);
for (const held of docs.values()) held.doc.destroy();
deviceA.destroy();
deviceB.destroy();
remoteIndex.destroy();
remoteNote.destroy();
reloaded.destroy();
