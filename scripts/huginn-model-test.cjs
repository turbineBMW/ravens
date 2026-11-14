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
const {
    NOTE_FORMAT,
    INK_STRIDE,
    SKETCH_MAX_BYTES,
    SKETCH_SIZE,
    decodePoints,
    decodeSketch,
    encodePoints,
    encodeSketch,
    migrationSeed,
    openIndex,
    openNote,
    sortItems,
} = model.exports;
const geometry = { exports: {} };
new Function(
    'require',
    'exports',
    ts.transpileModule(fs.readFileSync('huginn/web/src/lib/ink.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
)((name) => (name === '$lib/notes' ? model.exports : require(name)), geometry.exports);
{
    const { ERASER_RADIUS, eraseFrom, resample, touches } = geometry.exports;
    // A straight pen stroke from x 0 to 300 at y 100, with only its two ends sampled.
    const line = { points: Float32Array.from([0, 100, 0.25, 0, 300, 100, 1, 30]), width: 4 };
    const dense = resample(line.points, 10);
    assert.equal(dense.length / INK_STRIDE, 31, 'resampling fills the gap in even steps');
    assert.deepEqual(dense.slice(0, 4), [0, 100, 0.25, 0]);
    assert.deepEqual(dense.slice(-4), [300, 100, 1, 30]);
    assert.ok(Math.abs(dense[15 * INK_STRIDE + 2] - 0.625) < 1e-6, 'pressure is interpolated');
    assert.equal(eraseFrom(line, [150, 160]), null, 'an eraser that misses leaves the stroke alone');
    // Through the middle, between the two samples: the stroke splits in two.
    const halves = eraseFrom(line, [150, 100]);
    assert.equal(halves.length, 2);
    const reach = ERASER_RADIUS + line.width / 2;
    const lastX = (p) => p[p.length - INK_STRIDE];
    assert.ok(lastX(halves[0]) < 150 - reach + 5 && lastX(halves[0]) >= 150 - reach - 5, 'cut close to the eraser');
    assert.ok(halves[1][0] > 150 + reach - 5 && halves[1][0] <= 150 + reach + 5);
    assert.equal(halves[0][0], 0);
    assert.equal(lastX(halves[1]), 300, 'the ends are untouched');
    for (const half of halves) {
        for (let i = 0; i < half.length; i += INK_STRIDE) {
            assert.ok(
                !touches({ points: half.slice(i, i + INK_STRIDE), width: 4 }, 150, 100),
                'nothing left under the eraser',
            );
        }
    }
    // Over one end: one piece. Across the whole stroke: nothing, not crumbs.
    assert.equal(eraseFrom(line, [0, 100]).length, 1);
    const sweep = [];
    for (let x = 0; x <= 300; x += 5) sweep.push(x, 100);
    assert.deepEqual(eraseFrom(line, sweep), []);
}
{
    // The lasso, moving and resizing.
    const { boundsOf, inside, lassoed, moveWithin, resizeTo, transformed, MIN_SELECTION } = geometry.exports;
    const square = [0, 0, 100, 0, 100, 100, 0, 100];
    assert.ok(inside(square, 50, 50) && !inside(square, 150, 50) && !inside(square, 50, -1));
    const across = { points: Float32Array.from([20, 50, 0.5, 0, 80, 50, 0.5, 10]), width: 4 };
    const halfOut = { points: Float32Array.from([60, 50, 0.5, 0, 200, 50, 0.5, 10]), width: 4 };
    const mostlyIn = { points: Float32Array.from([10, 50, 0.5, 0, 120, 50, 0.5, 10]), width: 4 };
    assert.ok(lassoed(across, square), 'a stroke inside the loop is taken');
    assert.ok(!lassoed(halfOut, square), 'one mostly outside is not');
    assert.ok(lassoed(mostlyIn, square), 'one mostly inside is, though its samples are both near the edge');
    assert.ok(!lassoed(across, [0, 0, 100, 100]), 'a line is not a loop');
    assert.deepEqual(boundsOf([across, halfOut]), { left: 18, top: 48, right: 202, bottom: 52 });
    assert.equal(boundsOf([]), null);
    const box = { left: 100, top: 100, right: 300, bottom: 200 };
    assert.deepEqual(moveWithin(box, 50, 20, 1000), { ox: 0, oy: 0, scale: 1, dx: 50, dy: 20 });
    assert.equal(moveWithin(box, -500, 0, 1000).dx, -100, 'not off the left');
    assert.equal(moveWithin(box, 900, 0, 1000).dx, 700, 'nor off the right');
    assert.equal(moveWithin(box, 0, -500, 1000).dy, -100, 'nor above the top');
    assert.equal(moveWithin(box, 0, 5000, 1000).dy, 5000, 'but as far down as you like: the drawing grows');
    const bigger = resizeTo(box, 500, 300, 1000);
    assert.equal(bigger.scale, 2, 'the corner follows the pointer along the diagonal');
    assert.deepEqual([bigger.ox, bigger.oy], [100, 100], 'from the top-left corner');
    assert.equal(resizeTo(box, 5000, 5000, 1000).scale, 900 / 200, 'no wider than the drawing');
    assert.equal(resizeTo(box, 0, 0, 1000).scale, MIN_SELECTION / 200, 'nor too small to take hold of');
    const grown = transformed(across, { ...bigger, dx: 10 });
    // (20, 50) and (80, 50), doubled about (100, 100) and moved 10 right; pressure and time are kept.
    assert.deepEqual([...grown.points], [-50, 0, 0.5, 0, 70, 0, 0.5, 10]);
    assert.equal(grown.width, 8, 'the width scales with the stroke');
    assert.deepEqual([...across.points], [20, 50, 0.5, 0, 80, 50, 0.5, 10], 'the original is untouched');
}
{
    // The ruler.
    const { RULER_LENGTH, RULER_THICKNESS, RULER_REACH, alongRuler, rulerDegrees, rulerSide, settleAngle } =
        geometry.exports;
    const level = { x: 500, y: 300, angle: 0 };
    const edge = RULER_THICKNESS / 2;
    assert.equal(rulerSide(level, 500, 300 - edge - 10), -1, 'near the top edge');
    assert.equal(rulerSide(level, 500, 300 + edge + 10), 1, 'near the bottom edge');
    assert.equal(rulerSide(level, 500, 305), 1, 'on the ruler: the nearer edge');
    assert.equal(rulerSide(level, 500, 300 + edge + RULER_REACH + 1), 0, 'too far away');
    assert.equal(rulerSide(level, 500 + RULER_LENGTH / 2 + 1, 300), 0, 'past its end');
    const [x, y] = alongRuler(level, 1, 520, 360, 4);
    assert.ok(Math.abs(x - 520) < 1e-9 && Math.abs(y - (300 + edge + 2)) < 1e-9, 'onto the edge, just clear of it');
    const steep = { x: 0, y: 0, angle: Math.PI / 2 };
    const [sx, sy] = alongRuler(steep, -1, 7, 50, 0);
    assert.ok(Math.abs(sx - edge) < 1e-9 && Math.abs(sy - 50) < 1e-9, 'a turned ruler draws a turned line');
    const degrees = (d) => (d * Math.PI) / 180;
    assert.equal(settleAngle(degrees(44)), degrees(45), 'settles on 45 when close');
    assert.equal(settleAngle(degrees(40)), degrees(40), 'but not when it is not');
    assert.equal(settleAngle(degrees(-1)), 0);
    assert.equal(rulerDegrees(degrees(-30)), 30, 'tilted either way reads the same');
    assert.equal(rulerDegrees(degrees(150)), 30);
    assert.equal(rulerDegrees(degrees(90)), 90);
    assert.equal(rulerDegrees(degrees(180)), 0);
}

{
    // Sketches: a drawing cropped to its ink and scaled to SKETCH_SIZE, one byte per coordinate.
    const stroke = (tool, color, width, xy, created = 0) => ({
        id: `s${created}`,
        tool,
        color,
        width,
        created,
        points: Float32Array.from(xy.flatMap((v, i) => (i % 2 ? [v, 0.5, 0] : [v]))),
    });
    assert.equal(encodeSketch([]), null, 'no strokes, no sketch');
    // A 500 by 250 box of ink (widths included), drawn at x 100 to 600.
    const box = [stroke('pen', 'blue', 10, [105, 205, 595, 445]), stroke('highlighter', 'yellow', 10, [105, 445])];
    const bytes = encodeSketch(box);
    const sketch = decodeSketch(bytes);
    assert.deepEqual([sketch.width, sketch.height], [SKETCH_SIZE, 128], 'the longer side fills the sketch');
    assert.deepEqual(sketch.strokes[0], { tool: 'pen', color: 'blue', width: 5, points: [3, 3, 252, 125] });
    assert.deepEqual(sketch.strokes[1], { tool: 'highlighter', color: 'yellow', width: 5, points: [3, 125] });
    // A straight line sampled 500 times keeps only its ends.
    const straight = Array.from({ length: 500 }, (_, i) => [i, i / 2]).flat();
    assert.equal(decodeSketch(encodeSketch([stroke('pen', 'ink', 2, straight)])).strokes[0].points.length, 4);
    // A busy drawing is simplified, then cut short, to fit.
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1000;
    const busy = Array.from({ length: 200 }, (_, i) => stroke('pen', 'ink', 2, Array.from({ length: 80 }, random), i));
    const crowded = encodeSketch(busy);
    assert.ok(crowded.length <= SKETCH_MAX_BYTES, `a busy drawing fits: ${crowded.length} bytes`);
    const kept = decodeSketch(crowded).strokes;
    assert.ok(kept.length > 0 && kept.length < busy.length, 'keeping the oldest strokes that fit');
    assert.equal(decodeSketch(Uint8Array.from([2, 10, 10])), null, 'a newer sketch is not misread');
    assert.equal(decodeSketch(bytes.subarray(0, bytes.length - 1)).strokes.length, 1, 'a cut-off stroke is dropped');
}

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
assert.equal(NOTE_FORMAT, 4);
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

// Several checklists: each block has its own items, and the index counts those shown.
const multiId = fixtureIndex.create('text');
const multi = openNote(multiId, fixtureIndex);
multi.initialise();
assert.equal(get(multi.format), 2, 'a new note is format 2 until it needs more');
const addBlock = () => {
    const name = multi.newList();
    const block = new Y.XmlElement('checklist');
    block.setAttribute('list', name);
    multi.doc.doc.transact(() => multi.body.insert(multi.body.length, [block]));
    return name;
};
const listA = addBlock();
const listB = addBlock();
assert.notEqual(listA, listB);
assert.equal(get(multi.format), 3, 'more lists mark the note for clients that understand them');
const modelA = multi.list(listA);
const modelB = multi.list(listB);
assert.equal(multi.list(listA), modelA, 'one model per list');
const inA = modelA.addItem('In A');
modelB.addItem('In B one');
const secondB = modelB.addItem('In B two');
modelB.setChecked(secondB, true);
assert.deepEqual(
    get(modelA.items).map((i) => i.text),
    ['In A'],
);
assert.deepEqual(
    get(modelB.items).map((i) => i.text),
    ['In B one', 'In B two'],
);
assert.equal(entry(multiId).title, 'In A');
assert.equal(entry(multiId).preview, 'In B one');
assert.deepEqual([entry(multiId).open, entry(multiId).done], [2, 1]);
// Two devices each adding a checklist offline get two lists, not one list twice.
const elsewhere = new Y.Doc();
Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(multi.doc.doc));
const elsewhereBlock = new Y.XmlElement('checklist');
elsewhereBlock.setAttribute('list', 'items:elsewhere');
elsewhere.getXmlFragment('body').insert(0, [elsewhereBlock]);
Y.applyUpdate(multi.doc.doc, Y.encodeStateAsUpdate(elsewhere));
assert.equal(multi.body.toArray().filter((n) => n.nodeName === 'checklist').length, 3);
elsewhere.destroy();
const multiText = multi.plainText();
assert.ok(multiText.includes('[ ] In A') && multiText.includes('[x] In B two'), multiText);
multi.uncheckEverything();
assert.equal(
    get(modelB.items).every((i) => !i.checked),
    true,
    'uncheck all covers every list',
);
modelA.setChecked(inA, true);
modelB.setChecked(secondB, true);
multi.removeAllChecked();
assert.deepEqual(get(modelA.items), []);
assert.deepEqual(
    get(modelB.items).map((i) => i.text),
    ['In B one'],
);
// Removing a block leaves its items out of the note's text and counts.
const secondBlock = multi.body.toArray().findIndex((n) => n.getAttribute?.('list') === listB);
multi.doc.doc.transact(() => multi.body.delete(secondBlock, 1));
multi.repairIndex();
assert.equal(entry(multiId).preview, '');
assert.equal(entry(multiId).open, 0);
// A newer client can't start a list either.
const frozenMulti = openNote(multiId, fixtureIndex);
frozenMulti.doc.doc.getMap('meta').set('format', NOTE_FORMAT + 1);
const frozenState = stateOf(frozenMulti.doc.doc);
modelA.addItem('Refused');
frozenMulti.newList();
assert.equal(stateOf(frozenMulti.doc.doc), frozenState);

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

// Drawings: format 4, strokes in their own map, merging from two devices.
const sketchId = fixtureIndex.create('text');
const sketch = openNote(sketchId, fixtureIndex);
sketch.initialise();
const extraList = sketch.newList();
assert.equal(get(sketch.format), 3);
const strokesName = sketch.newInk();
assert.match(strokesName, /^strokes:/);
assert.notEqual(sketch.newInk(), strokesName, 'every drawing gets its own map');
assert.equal(get(sketch.format), 4, 'a drawing marks the note for clients that understand it');
sketch.newList();
assert.equal(get(sketch.format), 4, 'a later checklist does not lower the format');
const inkBlock = new Y.XmlElement('ink');
inkBlock.setAttribute('strokes', strokesName);
const listBlock = new Y.XmlElement('checklist');
listBlock.setAttribute('list', extraList);
sketch.doc.doc.transact(() => sketch.body.insert(sketch.body.length, [inkBlock, listBlock]));
const points = Float32Array.from([10.5, 20.25, 0.5, 0, 30, 40, 0.875, 8.5]);
assert.deepEqual([...decodePoints(encodePoints(points))], [...points], 'points survive encoding');
assert.equal(encodePoints(points).byteLength, points.length * 4);
assert.equal(INK_STRIDE, 4);
const drawing = sketch.ink(strokesName);
assert.equal(sketch.ink(strokesName), drawing, 'one model per drawing');
const first = drawing.add({ tool: 'pen', color: 'blue', width: 4, points });
assert.ok(first);
const otherDevice = new Y.Doc();
Y.applyUpdate(otherDevice, Y.encodeStateAsUpdate(sketch.doc.doc));
// Offline on both: this device draws again, the other erases the first stroke and draws its own.
const second = drawing.add({ tool: 'pen', color: 'ink', width: 4, points: Float32Array.from([1, 2, 0.3, 0]) });
otherDevice.transact(() => {
    const strokes = otherDevice.getMap(strokesName);
    strokes.delete(first);
    const m = new Y.Map();
    m.set('tool', 'pen');
    m.set('color', 'red');
    m.set('width', 6);
    m.set('created', 1);
    m.set('points', encodePoints(Float32Array.from([5, 5, 1, 0, 6, 6, 1, 4])));
    strokes.set('remotestroke0000000a', m);
});
Y.applyUpdate(sketch.doc.doc, Y.encodeStateAsUpdate(otherDevice));
Y.applyUpdate(otherDevice, Y.encodeStateAsUpdate(sketch.doc.doc));
const merged = get(drawing.strokes);
assert.deepEqual(
    merged.map((s) => s.id),
    ['remotestroke0000000a', second],
    "both devices keep each other's strokes and the erase, oldest first",
);
assert.equal(merged[0].color, 'red');
assert.deepEqual([...merged[0].points], [5, 5, 1, 0, 6, 6, 1, 4]);
assert.equal(otherDevice.getMap(strokesName).size, 2, 'the other device converges too');
drawing.remove([second]);
assert.deepEqual(
    get(drawing.strokes).map((s) => s.id),
    ['remotestroke0000000a'],
);
// A highlighter keeps its tool; an unknown tool or colour reads as a pen in ink.
const marker = drawing.add({ tool: 'highlighter', color: 'yellow', width: 24, points });
assert.deepEqual(
    (({ tool, color, width }) => ({ tool, color, width }))(get(drawing.strokes).find((s) => s.id === marker)),
    { tool: 'highlighter', color: 'yellow', width: 24 },
);
sketch.doc.doc.transact(() => {
    sketch.doc.doc.getMap(strokesName).get(marker).set('tool', 'chisel');
    sketch.doc.doc.getMap(strokesName).get(marker).set('color', 'mauve');
});
assert.deepEqual((({ tool, color }) => ({ tool, color }))(get(drawing.strokes).find((s) => s.id === marker)), {
    tool: 'pen',
    color: 'ink',
});
// Erasing part of a stroke replaces it with what's left, at the same depth.
const kept = get(drawing.strokes).find((s) => s.id === 'remotestroke0000000a');
const pieceA = Float32Array.from([0, 0, 0.5, 0, 1, 1, 0.5, 1]);
const pieceB = Float32Array.from([8, 8, 0.5, 2, 9, 9, 0.5, 3]);
drawing.erase(
    new Map([
        ['remotestroke0000000a', [pieceA, pieceB]],
        [marker, []],
        ['alreadygone000000000', [pieceA]],
    ]),
);
const afterErase = get(drawing.strokes);
assert.equal(afterErase.length, 2, 'two pieces left; the erased and the missing strokes add nothing');
assert.ok(!afterErase.some((s) => s.id === 'remotestroke0000000a' || s.id === marker));
for (const piece of afterErase) {
    assert.deepEqual(
        (({ tool, color, width, created }) => ({ tool, color, width, created }))(piece),
        (({ tool, color, width, created }) => ({ tool, color, width, created }))(kept),
        'pieces keep the stroke they came from',
    );
}
assert.deepEqual(
    afterErase.map((s) => [...s.points]).sort((a, b) => a[0] - b[0]),
    [[...pieceA], [...pieceB]],
);
// Moving or resizing keeps a stroke's id and depth, with new points and width.
const [movable, doomed] = get(drawing.strokes);
const moved = Float32Array.from(movable.points, (v, i) => (i % INK_STRIDE < 2 ? v + 100 : v));
Y.applyUpdate(otherDevice, Y.encodeStateAsUpdate(sketch.doc.doc));
drawing.reshape(
    new Map([
        [movable.id, { points: moved, width: movable.width * 2 }],
        ['alreadygone000000000', { points: moved, width: 1 }],
    ]),
);
const reshaped = get(drawing.strokes);
assert.equal(reshaped.length, 2, 'a move adds nothing, even for a stroke that is gone');
assert.deepEqual((({ id, created, width }) => ({ id, created, width }))(reshaped.find((s) => s.id === movable.id)), {
    id: movable.id,
    created: movable.created,
    width: movable.width * 2,
});
assert.deepEqual([...reshaped.find((s) => s.id === movable.id).points], [...moved]);
// Offline on both: the other device erases a stroke while this one moves it. The erase wins.
otherDevice.getMap(strokesName).delete(doomed.id);
drawing.reshape(new Map([[doomed.id, { points: moved, width: 3 }]]));
Y.applyUpdate(sketch.doc.doc, Y.encodeStateAsUpdate(otherDevice));
Y.applyUpdate(otherDevice, Y.encodeStateAsUpdate(sketch.doc.doc));
assert.deepEqual(
    get(drawing.strokes).map((s) => s.id),
    [movable.id],
    'a move does not bring back a stroke erased elsewhere',
);
assert.deepEqual(
    [...decodePoints(otherDevice.getMap(strokesName).get(movable.id).get('points'))],
    [...moved],
    'the other device sees the move',
);
// Paper: plain until chosen, shared, and plain again for a paper this client doesn't know.
assert.equal(get(drawing.paper), 'plain');
drawing.setPaper('grid');
assert.equal(get(drawing.paper), 'grid');
Y.applyUpdate(otherDevice, Y.encodeStateAsUpdate(sketch.doc.doc));
assert.equal(otherDevice.getMap('paper').get(strokesName), 'grid', 'paper syncs');
otherDevice.getMap('paper').set(strokesName, 'parchment');
Y.applyUpdate(sketch.doc.doc, Y.encodeStateAsUpdate(otherDevice));
assert.equal(get(drawing.paper), 'plain');
drawing.setPaper('plain');
assert.ok(!sketch.paperMap.has(strokesName), 'plain paper takes no room');
assert.equal(get(sketch.ink(sketch.newInk()).paper), 'plain', 'each drawing has its own paper');
assert.equal(get(sketch.format), 4, 'moving and paper need no new format');
// The index keeps a sketch of the first drawing for the notes list, and repair fills one in.
sketch.repairIndex();
const thumbnail = decodeSketch(entry(sketchId).sketch);
assert.equal(thumbnail.strokes.length, get(drawing.strokes).length, 'the thumbnail shows the first drawing');
fixtureIndex.doc.doc.getMap('notes').get(sketchId).delete('sketch');
sketch.repairIndex();
assert.ok(entry(sketchId).sketch, 'repair restores a missing sketch');
const withSketch = stateOf(fixtureIndex.doc.doc);
sketch.repairIndex();
assert.equal(stateOf(fixtureIndex.doc.doc), withSketch, 'and writes nothing when it is already right');
assert.ok(sketch.plainText().includes('[Drawing]'), 'export marks where a drawing was');
sketch.repairIndex();
assert.equal(entry(sketchId).preview, '', 'a drawing adds nothing to the preview');
drawing.remove(get(drawing.strokes).map((s) => s.id));
assert.equal(entry(sketchId).sketch, null, 'erasing the drawing clears its thumbnail');
assert.equal(entry(freshId).sketch, null, 'a note without a drawing has none');
otherDevice.destroy();

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
newer.newInk();
assert.equal(newer.ink('strokes:refused').add({ tool: 'pen', color: 'ink', width: 4, points }), '');
newer.ink('strokes:refused').erase(new Map([['anything', []]]));
newer.ink('strokes:refused').remove(['anything']);
newer.ink('strokes:refused').reshape(new Map([['anything', { points, width: 1 }]]));
newer.ink('strokes:refused').setPaper('grid');
assert.equal(stateOf(newer.doc.doc), frozenNote, 'no edit reaches a newer note');
assert.equal(stateOf(fixtureIndex.doc.doc), frozenIndex, 'nor its index entry');
console.log(
    'PASS: trash/restore, concurrent offline edit, stable item IDs, persistence roundtrip, deterministic ordering, legacy metadata, format 1 fixtures, index repair, seed bytes, migration guards, title rule, several checklists, drawings, highlighter and partial erase, lasso and ruler geometry, move/resize, paper, sketches for thumbnails, plain text, newer-format guard, late store subscribers',
);
for (const held of docs.values()) held.doc.destroy();
deviceA.destroy();
deviceB.destroy();
remoteIndex.destroy();
remoteNote.destroy();
reloaded.destroy();
