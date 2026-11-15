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
// The client's modules, compiled as they're needed, each once.
const libs = new Map();
function lib(name) {
    if (!libs.has(name)) {
        const module = { exports: {} };
        libs.set(name, module);
        const source = fs.readFileSync(`huginn/web/src/lib/${name}.ts`, 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        new Function('require', 'exports', compiled)(resolve, module.exports);
    }
    return libs.get(name).exports;
}
function resolve(name) {
    if (name === '$app/paths') return { base: '/huginn' };
    if (name === '@ravens/ui/sync') return sync;
    if (name === '@ravens/ui/api') return { createApi: () => ({ request: async () => [] }) };
    if (name.startsWith('$lib/')) return lib(name.slice('$lib/'.length));
    return require(name);
}
const model = { exports: lib('notes') };
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
const geometry = { exports: lib('ink') };
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
assert.equal(NOTE_FORMAT, 6);
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

{
    // Folders as shown: by name, subfolders under their folder, nothing lost when changes cross.
    const { folderPath, folderTree, shownFolder, within } = lib('folders');
    const f = (id, parent = '', extra = {}) => ({
        id,
        name: id.toUpperCase(),
        parent,
        created: 0,
        deletedAt: 0,
        deletedWith: '',
        ...extra,
    });
    const rows = (all) => folderTree(all).map((r) => [r.folder.id, r.depth]);
    const all = [f('b'), f('a'), f('a2', 'a'), f('a1', 'a'), f('x', 'gone'), f('gone', '', { deletedAt: 1 })];
    assert.deepEqual(rows(all), [
        ['a', 0],
        ['a1', 1],
        ['a2', 1],
        ['b', 0],
        ['x', 0],
    ]);
    assert.deepEqual([...within(all, 'a')].sort(), ['a', 'a1', 'a2'], 'a folder and the folders in it');
    assert.equal(within(all, 'gone').size, 0, 'a deleted folder holds nothing');
    assert.equal(folderPath(all, 'a2'), 'A › A2');
    assert.equal(folderPath(all, 'x'), 'X', 'a folder whose parent is gone is at the top level');
    // Two devices moving folders into each other: the lowest id goes to the top, everywhere.
    assert.deepEqual(rows([f('d', 'c'), f('c', 'd')]), [
        ['c', 0],
        ['d', 1],
    ]);
    assert.deepEqual(rows([f('e', 'c'), f('d', 'c'), f('c', 'd')]), [
        ['c', 0],
        ['d', 1],
        ['e', 1],
    ]);
    assert.deepEqual(rows([f('s', 's')]), [['s', 0]], 'nor in itself');
    const numbered = [f('n10', '', { name: 'Item 10' }), f('n9', '', { name: 'item 9' })];
    assert.deepEqual(rows(numbered), [
        ['n9', 0],
        ['n10', 0],
    ]);
    const live = new Set(['a']);
    assert.equal(shownFolder('a', live), 'a');
    assert.equal(shownFolder('gone', live), '', 'a note whose folder is gone shows at the top level');
}
{
    // Folders in the index: notes in them, moving, deleting with everything in it, and restoring.
    const meta = (id) => get(index.notes).find((n) => n.id === id);
    const folder = (id) => get(index.folders).find((f) => f.id === id);
    const work = index.createFolder('Work', '');
    const turbines = index.createFolder('Turbines', work);
    assert.equal(folder(turbines).parent, work);
    const inside = index.create('text', turbines);
    const loose = index.create('text');
    const elsewhere = index.create('text');
    index.remove(elsewhere);
    assert.equal(meta(inside).folder, turbines, 'a new note goes in the folder being viewed');
    assert.equal(meta(loose).folder, '');
    const updated = meta(loose).updated;
    index.moveNotes([loose, elsewhere], work);
    assert.equal(meta(loose).folder, work);
    assert.equal(meta(loose).updated, updated, 'moving a note does not reorder the list');
    index.moveFolder(work, turbines);
    assert.equal(folder(work).parent, '', 'a folder never moves into a folder inside it');
    index.renameFolder(turbines, 'Blades');
    assert.equal(folder(turbines).name, 'Blades');

    index.deleteFolder(work);
    for (const id of [work, turbines]) {
        assert.ok(folder(id).deletedAt > 0 && folder(id).deletedWith === work, 'the folder and the one in it go');
    }
    for (const id of [inside, loose]) {
        assert.ok(meta(id).deletedAt > 0 && meta(id).deletedWith === work, 'and so do their notes');
    }
    assert.equal(meta(elsewhere).deletedWith, '', 'a note already deleted keeps how it was deleted');
    index.restore(loose);
    assert.equal(meta(loose).deletedAt, 0);
    assert.equal(meta(loose).deletedWith, '');
    index.restoreFolder(work);
    assert.ok(!folder(work).deletedAt && !folder(turbines).deletedAt && folder(turbines).parent === work);
    assert.equal(meta(inside).deletedAt, 0, 'restoring the folder brings back its notes');
    assert.equal(meta(loose).folder, work, 'a note restored on its own is back in its folder too');
    assert.ok(meta(elsewhere).deletedAt > 0, 'but not one deleted before the folder was');

    // Offline on both: this device moves a note into a folder the other deletes. It stays visible.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(index.doc.doc));
    other.getMap('folders').get(turbines).set('deletedAt', 1);
    index.moveNotes([loose], turbines);
    Y.applyUpdate(index.doc.doc, Y.encodeStateAsUpdate(other));
    const liveIds = new Set(
        get(index.folders)
            .filter((f) => !f.deletedAt)
            .map((f) => f.id),
    );
    assert.equal(meta(loose).deletedAt, 0);
    assert.equal(lib('folders').shownFolder(meta(loose).folder, liveIds), '', 'it shows at the top level');
    other.destroy();
}

{
    // Addresses and phone numbers found in text, and nothing that only looks like one.
    const { actionsFor, copyText, detectIn } = lib('detect');
    const found = (text) => detectIn(text).map((d) => [d.kind, d.text, d.href]);
    assert.deepEqual(found('Call 555-123-4567, (555) 123-4567 or 1 555 123 4567.'), [
        ['phone', '555-123-4567', 'tel:5551234567'],
        ['phone', '(555) 123-4567', 'tel:5551234567'],
        ['phone', '1 555 123 4567', 'tel:15551234567'],
    ]);
    assert.deepEqual(found('UK +44 20 7946 0958; US +1 (555) 123-4567.'), [
        ['phone', '+44 20 7946 0958', 'tel:+442079460958'],
        ['phone', '+1 (555) 123-4567', 'tel:+15551234567'],
    ]);
    assert.deepEqual(
        found(
            'On 2026-11-15 at 12:30, v1.2.3, 192.168.100.1000, part ABC-555-123-4567, 555-123-45678, ' +
                '12555-123-4567, 555.123.4567.8, +1 23, +1 (555 123 4567',
        ),
        [],
        'dates, times, versions, addresses, part numbers and longer runs of digits are not phone numbers',
    );
    assert.deepEqual(found('See example.com/a?b=1, https://x.org/(a). www.foo.co.uk/p#x'), [
        ['url', 'example.com/a?b=1', 'https://example.com/a?b=1'],
        ['url', 'https://x.org/(a)', 'https://x.org/(a)'],
        ['url', 'www.foo.co.uk/p#x', 'https://www.foo.co.uk/p#x'],
    ]);
    assert.deepEqual(found('Mail me@host.com. Not fixme@localhost, README.md, javascript:alert(1)'), [
        ['email', 'me@host.com', 'mailto:me@host.com'],
    ]);
    assert.deepEqual(
        found('https://x.org/call/555-123-4567'),
        [['url', 'https://x.org/call/555-123-4567', 'https://x.org/call/555-123-4567']],
        'a number in an address is part of it',
    );
    assert.deepEqual(
        detectIn('a\ufffcme@host.com').map((d) => d.at),
        [2],
        'positions count as JavaScript does, past what stands in for a link',
    );
    assert.deepEqual(
        actionsFor('phone', 'tel:+15551234567').map((a) => a.href),
        ['tel:+15551234567', 'sms:+15551234567'],
    );
    assert.equal(copyText('email', 'mailto:me@host.com', 'me@host.com'), 'me@host.com');
    assert.equal(copyText('phone', 'tel:5551234567', '(555) 123-4567'), '(555) 123-4567', 'as written');
}

{
    // Tags: the same cases as the server's tags.rs, which must agree.
    const { cleanTag, retag, tagMatches } = lib('tags');
    const names = (text) => tagMatches(text).map((m) => m.name);
    const cases = [
        ['#work', ['work']],
        ['Plan for #Turbines and #blade-inspection.', ['Turbines', 'blade-inspection']],
        ['(#q3) [#café] {#x_y}', ['q3', 'café', 'x_y']],
        ['#trailing- #under_', ['trailing', 'under']],
        ['issue #1, year #2026, rev #2b', ['2b']],
        ['mail me@host#tag, url example.com/#anchor, C#', []],
        ['##double #', []],
        ['#a#b', ['a']],
        [`#${'a'.repeat(65)}`, []],
        [`#${'a'.repeat(64)}`, ['a'.repeat(64)]],
    ];
    for (const [text, want] of cases) assert.deepEqual(names(text), want, text);
    assert.deepEqual(
        tagMatches('x #😀a #b').map((m) => m.at),
        [7],
        'positions count as JavaScript does; an emoji is not a word character',
    );
    assert.equal(retag('#Work and #work, not #workshop', 'work', 'Job'), '#Job and #Job, not #workshop');
    assert.equal(retag('a #draft- here', 'draft', ''), 'a draft- here', 'deleting keeps the word');
    assert.equal(cleanTag(' ##New tag! '), 'New');
    assert.equal(cleanTag('2026'), '', 'not a tag');
    // Suggesting tags while one is typed.
    const { partialTag, suggestTags } = lib('tags');
    assert.equal(partialTag('Plan #wo'), 'wo');
    assert.equal(partialTag('#'), '', 'just typed the #');
    assert.equal(partialTag('(#blade-in'), 'blade-in');
    assert.equal(partialTag('Plan #work '), null, 'a space ends it');
    assert.equal(partialTag('C#'), null, 'not where a tag can start');
    assert.equal(partialTag('example.com/#an'), null);
    const library = [
        { tag: 'work', name: 'Work', notes: ['a', 'b', 'c'] },
        { tag: 'workshop', name: 'workshop', notes: ['a'] },
        { tag: 'homework', name: 'homework', notes: ['a', 'b'] },
        { tag: 'gone', name: 'gone', notes: ['x'] },
        { tag: 'wool', name: 'wool', notes: ['a', 'b', 'c', 'd'] },
    ];
    const live = (t) => t.notes.filter((id) => id !== 'x').length;
    const suggested = (typed) => suggestTags(library, typed, live).map((t) => t.tag);
    assert.deepEqual(suggested('Wor'), ['work', 'workshop', 'homework'], 'starting with it first, then containing it');
    assert.deepEqual(
        suggested(''),
        ['wool', 'work', 'homework', 'workshop'],
        'the most used, none only in deleted notes',
    );
    assert.deepEqual(suggested('zzz'), []);

    // Renaming in a note: its title, checklist and formatted text, outside undo.
    const tagged = openNote(index.create('text'), index);
    tagged.initialise();
    const listName = tagged.newList();
    tagged.doc.doc.transact(() => {
        tagged.setTitle('Trip #Work');
        const para = new Y.XmlElement('paragraph');
        const text = new Y.XmlText();
        para.insert(0, [text]);
        const list = new Y.XmlElement('checklist');
        list.setAttribute('list', listName);
        tagged.body.insert(tagged.body.length, [para, list]);
        text.insert(0, 'Plan ');
        text.insert(5, '#', { italic: true });
        text.insert(6, 'work', { bold: true });
        text.insert(10, ' and #home', { bold: null });
    });
    const itemId = tagged.list(listName).addItem('Pack for #work');
    const item = () => tagged.doc.doc.getMap(listName).get(itemId);
    const undo = new Y.UndoManager([tagged.body], { trackedOrigins: new Set([null]) });
    assert.equal(tagged.renameTag('work', 'Job'), true);
    const body = tagged.body.toArray()[1].toArray()[0];
    assert.deepEqual(body.toDelta(), [
        { insert: 'Plan ' },
        { insert: '#', attributes: { italic: true } },
        { insert: 'Job', attributes: { bold: true } },
        { insert: ' and #home' },
    ]);
    assert.equal(get(tagged.title), 'Trip #Job');
    assert.equal(item().get('text'), 'Pack for #Job');
    assert.equal(undo.undoStack.length, 0, 'a rename is not an edit to undo');
    assert.equal(tagged.renameTag('home', ''), true);
    assert.equal(body.toString(), 'Plan <italic>#</italic><bold>Job</bold> and home');
    assert.equal(tagged.renameTag('absent', 'x'), false, 'a note without the tag is left alone');
    undo.destroy();
    tagged.release();
}

{
    // Smart Folders: saved filters, worked out from the index and the tag list.
    const { describe, holds, matches, readConditions, retagConditions } = lib('smartFolders');
    assert.deepEqual(
        readConditions(
            JSON.stringify([
                { kind: 'tag', tag: 'work' },
                { kind: 'tag', tag: '' },
                { kind: 'folder', folder: 'f1', within: false },
                { kind: 'edited', days: 7.4 },
                { kind: 'created', days: 0 },
                { kind: 'checklist', state: 'open' },
                { kind: 'checklist', state: 'bogus' },
                { kind: 'pinned' },
                { kind: 'from-the-future', x: 1 },
                null,
            ]),
        ),
        [
            { kind: 'tag', has: true, tag: 'work' },
            { kind: 'folder', within: false, folder: 'f1' },
            { kind: 'edited', within: true, days: 7 },
            { kind: 'checklist', state: 'open' },
            { kind: 'pinned', pinned: true },
        ],
        "what can't be read is dropped, so a newer client's conditions never break this one",
    );
    assert.deepEqual(readConditions('not json'), []);
    const DAY = 86_400_000;
    const now = 100 * DAY;
    const note = (id, extra = {}) => ({
        id,
        title: id,
        kind: 'text',
        created: now - 30 * DAY,
        updated: now - 2 * DAY,
        pinned: false,
        deletedAt: 0,
        deletedWith: '',
        folder: '',
        preview: '',
        open: 0,
        done: 0,
        sketch: null,
        ...extra,
    });
    const ctx = {
        now,
        tagNotes: new Map([['work', new Set(['a', 'b'])]]),
        placeOf: (n) => n.folder,
        within: (f) => (f === 'outer' ? new Set(['outer', 'inner']) : new Set()),
    };
    const a = note('a', { folder: 'inner', open: 2, pinned: true });
    const b = note('b', { open: 0, done: 3, updated: now - 10 * DAY });
    const c = note('c');
    const check = (cond, n) => holds(cond, n, ctx);
    assert.ok(check({ kind: 'tag', has: true, tag: 'work' }, a) && !check({ kind: 'tag', has: true, tag: 'work' }, c));
    assert.ok(check({ kind: 'tag', has: false, tag: 'work' }, c));
    assert.ok(check({ kind: 'folder', within: true, folder: 'outer' }, a), 'a folder includes the folders inside it');
    assert.ok(check({ kind: 'folder', within: true, folder: '' }, b), "'' is the top level");
    assert.ok(!check({ kind: 'folder', within: true, folder: 'gone' }, a), 'a deleted folder holds nothing');
    assert.ok(
        check({ kind: 'edited', within: true, days: 7 }, a) && !check({ kind: 'edited', within: true, days: 7 }, b),
    );
    assert.ok(check({ kind: 'created', within: false, days: 7 }, a));
    assert.deepEqual(
        ['open', 'done', 'none'].map((state) =>
            [a, b, c].filter((n) => check({ kind: 'checklist', state }, n)).map((n) => n.id),
        ),
        [['a'], ['b'], ['c']],
    );
    assert.ok(check({ kind: 'pinned', pinned: true }, a) && check({ kind: 'pinned', pinned: false }, b));
    const folder = (match, conditions) => ({ id: 's', name: 'S', match, conditions, created: 0 });
    const both = [
        { kind: 'tag', has: true, tag: 'work' },
        { kind: 'checklist', state: 'open' },
    ];
    const ids = (f) => [a, b, c].filter((n) => matches(f, n, ctx)).map((n) => n.id);
    assert.deepEqual(ids(folder('all', both)), ['a']);
    assert.deepEqual(ids(folder('any', both)), ['a', 'b']);
    assert.deepEqual(ids(folder('all', [])), [], 'no conditions, no notes');
    assert.ok(!matches(folder('any', both), { ...a, deletedAt: 1 }, ctx), 'never a deleted note');
    // Renaming a tag carries its conditions along; deleting it drops them.
    const tagged = [
        { kind: 'tag', has: false, tag: 'work' },
        { kind: 'pinned', pinned: true },
    ];
    assert.deepEqual(retagConditions(tagged, 'work', 'job'), [
        { kind: 'tag', has: false, tag: 'job' },
        { kind: 'pinned', pinned: true },
    ]);
    assert.deepEqual(retagConditions(tagged, 'work', ''), [{ kind: 'pinned', pinned: true }]);
    assert.equal(retagConditions(tagged, 'home', 'x'), null, 'nothing to change');
    assert.equal(describe({ kind: 'edited', within: false, days: 7 }, String, String), 'Not edited in the last 7 days');
    assert.equal(
        describe({ kind: 'tag', has: true, tag: 'work' }, () => 'Work', String),
        'Tagged #Work',
    );

    // In the index: made, changed, following a tag's rename, and deleted.
    const smart = () => get(index.smartFolders);
    const sid = index.createSmartFolder('Open work', 'all', both);
    assert.deepEqual(
        smart().find((f) => f.id === sid),
        {
            id: sid,
            name: 'Open work',
            match: 'all',
            conditions: both,
            created: smart().find((f) => f.id === sid).created,
        },
    );
    index.updateSmartFolder(sid, { name: 'Busy', match: 'any' });
    assert.equal(smart().find((f) => f.id === sid).match, 'any');
    index.retagSmartFolders('work', 'job');
    assert.equal(smart().find((f) => f.id === sid).conditions[0].tag, 'job', 'a renamed tag keeps its Smart Folders');
    index.retagSmartFolders('job', '');
    assert.deepEqual(smart().find((f) => f.id === sid).conditions, [{ kind: 'checklist', state: 'open' }]);
    index.deleteSmartFolder(sid);
    assert.ok(!smart().some((f) => f.id === sid));
}

// Find in note: case and accents don't matter, offsets are the original text's, and
// matches in the body and in checklist items come in the order they're shown.
{
    const { findIn, fold, matchCount } = lib('find');
    assert.deepEqual(findIn('Café au lait, CAFE noir', 'cafe'), [
        [0, 4],
        [14, 18],
    ]);
    assert.deepEqual(
        findIn('aaaa', 'aa'),
        [
            [0, 2],
            [2, 4],
        ],
        'matches never overlap',
    );
    assert.deepEqual(findIn('Cafe\u0301 time', 'cafe '), [[0, 6]], 'a combining accent stays with its letter');
    assert.deepEqual(findIn('a.b a+b (x)', '(x)'), [[8, 11]], 'nothing is a pattern');
    assert.deepEqual(findIn('İstanbul', 'ist'), [[0, 3]]);
    assert.deepEqual(findIn('two\u00a0words', 'two words'), [[0, 9]], 'a no-break space is a space');
    assert.deepEqual(findIn('😀 smile', 'smile'), [[3, 8]], 'offsets count UTF-16 units');
    assert.deepEqual(findIn('anything', ''), []);
    assert.deepEqual(findIn('', 'x'), []);
    assert.equal(fold('ÉCOLE').folded, 'ecole');
    assert.equal(matchCount(0, 0), 'No matches');
    assert.equal(matchCount(2, 5), '3 of 5');

    const { Schema } = require('@tiptap/pm/model');
    const { EditorState } = require('@tiptap/pm/state');
    const { FindInNote, findKey, findState } = lib('findInNote');
    const schema = new Schema({
        nodes: {
            doc: { content: 'block+' },
            paragraph: { group: 'block', content: 'inline*' },
            checklist: { group: 'block', atom: true, attrs: { list: { default: 'items' } } },
            hard_break: { group: 'inline', inline: true },
            text: { group: 'inline' },
        },
        marks: { bold: {} },
    });
    const lists = {
        items: [
            { id: 'i1', text: 'Buy coffee' },
            { id: 'i2', text: 'Coffee filters, coffee beans' },
        ],
    };
    const itemsOf = (list) => lists[list] ?? [];
    const plugins = FindInNote.configure({ itemsOf }).config.addProseMirrorPlugins.call({ options: { itemsOf } });
    const p = (...content) => schema.node('paragraph', null, content);
    const doc = schema.node('doc', null, [
        p(schema.text('Morning '), schema.text('cof', [schema.mark('bold')]), schema.text('fee')),
        schema.node('checklist', { list: 'items' }),
        p(schema.text('a'), schema.node('hard_break'), schema.text('café later')),
    ]);
    let state = EditorState.create({ doc, plugins });
    const act = (action) => (state = state.apply(state.tr.setMeta(findKey, action)));
    act({ query: 'COFFEE' });
    const shown = () =>
        findState(state).matches.map((m) =>
            m.kind === 'text' ? state.doc.textBetween(m.from, m.to) : `${m.item}:${m.at}-${m.end}`,
        );
    assert.deepEqual(shown(), ['coffee', 'i1:4-10', 'i2:0-6', 'i2:16-22'], 'across marks, and item by item');
    assert.equal(findState(state).current, 0);
    assert.equal(findState(state).decorations.find().length, 1, 'only body text is decorated here');
    act({ step: -1 });
    assert.equal(findState(state).current, 3, 'stepping back from the first wraps to the last');
    act({ step: 1 });
    assert.equal(findState(state).current, 0);
    act({ step: 1 });
    // An item edited elsewhere: reading the lists again keeps the current match.
    lists.items = [{ id: 'i0', text: 'coffee first' }, ...lists.items];
    act({ refresh: true });
    assert.equal(findState(state).matches.length, 5);
    assert.equal(findState(state).matches[findState(state).current].item, 'i1', 'still on the same item');
    // Typing before a match keeps it current, and its highlight moves with it.
    act({ query: 'cafe' });
    assert.deepEqual(shown(), ['café'], 'after a hard break, accents folded');
    state = state.apply(state.tr.insertText('Very ', 1));
    assert.deepEqual(shown(), ['café']);
    const [deco] = findState(state).decorations.find();
    assert.equal(state.doc.textBetween(deco.from, deco.to), 'café');
    // The query starts at the caret: the first match at or after it is current.
    state = state.apply(state.tr.setSelection(require('@tiptap/pm/state').TextSelection.create(state.doc, 20)));
    act({ query: 'coffee' });
    assert.equal(findState(state).current, 1, 'the checklist after the caret');
    act({ query: '' });
    assert.equal(findState(state).matches.length, 0);
    assert.equal(findState(state).current, -1);
}

// Links between notes: what they say, URLs read back, what's typed after `[[`, the
// suggestions, backlinks, and a note with one being format 5 with its links as text.
{
    const { backlinksOf, linkText, parseNoteUrl, partialLink, suggestHeadings, suggestNotes } = lib('noteLinks');
    const none = { section: '', heading: '', label: '' };
    const plans = { title: 'Plans', deletedAt: 0 };
    assert.deepEqual(linkText(none, plans), { text: 'Plans', state: 'live' }, 'it follows the title');
    assert.equal(linkText({ ...none, label: ' The plan ' }, plans).text, 'The plan', 'unless it has a label');
    assert.equal(linkText({ section: 's1', heading: 'Budget', label: '' }, plans).text, 'Plans › Budget');
    assert.equal(linkText({ section: 's1', heading: 'Budget', label: '' }, plans, true).text, 'Budget', 'here');
    assert.equal(linkText({ section: 's1', heading: '', label: '' }, plans).text, 'Plans › Section');
    assert.equal(linkText(none, { title: ' ', deletedAt: 0 }).text, 'Untitled note');
    assert.deepEqual(linkText(none, { title: 'Old', deletedAt: 5 }), { text: 'Old', state: 'deleted' });
    assert.deepEqual(linkText(none, undefined), { text: 'Missing note', state: 'missing' });

    const origin = 'https://mini.example';
    assert.deepEqual(parseNoteUrl(`${origin}/huginn/n/abc_12-x`, origin, '/huginn'), { note: 'abc_12-x', section: '' });
    assert.deepEqual(parseNoteUrl(` ${origin}/huginn/n/abc?view=trash#section-s9 `, origin, '/huginn'), {
        note: 'abc',
        section: 's9',
    });
    assert.equal(parseNoteUrl(`https://elsewhere.example/huginn/n/abc`, origin, '/huginn'), null, 'only this origin');
    assert.equal(parseNoteUrl(`${origin}/muninn/n/abc`, origin, '/huginn'), null, 'only Huginn');
    assert.equal(parseNoteUrl(`${origin}/huginn/n/abc/edit`, origin, '/huginn'), null);
    assert.equal(parseNoteUrl('/huginn/n/abc', origin, '/huginn'), null, 'a whole URL, not a path');
    assert.equal(parseNoteUrl('two words', origin, '/huginn'), null);

    assert.equal(partialLink('See [['), '');
    assert.equal(partialLink('See [[Pla'), 'Pla');
    assert.equal(partialLink('[[#Bud'), '#Bud');
    assert.equal(partialLink('[[Plans]] then'), null, 'a closed one is done');
    assert.equal(partialLink('[Plans'), null);
    assert.equal(partialLink(`[[${'x'.repeat(101)}`), null, 'not a whole paragraph');

    const meta = (id, title, updated, extra = {}) => ({ id, title, updated, deletedAt: 0, ...extra });
    const library = [
        meta('a', 'Café plans', 3),
        meta('b', 'Weekend plans', 5),
        meta('c', 'Plans for spring', 1),
        meta('d', 'Plans, deleted', 9, { deletedAt: 1 }),
        meta('e', 'Plans here', 9),
        meta('f', '', 2),
    ];
    assert.deepEqual(
        suggestNotes(library, 'plans', 'e').map((n) => n.id),
        ['c', 'b', 'a'],
        'starting with it, then containing it, each newest first, not deleted or this note',
    );
    assert.deepEqual(
        suggestNotes(library, 'cafe', 'e').map((n) => n.id),
        ['a'],
        'accents folded',
    );
    assert.deepEqual(
        suggestNotes(library, 'untitled', 'e').map((n) => n.id),
        ['f'],
    );
    assert.deepEqual(
        suggestNotes(library, '', 'e').map((n) => n.id),
        ['b', 'a', 'f', 'c'],
        'newest first',
    );
    assert.deepEqual(
        suggestHeadings([{ text: 'Budget' }, { text: 'Trip budget' }, { text: '' }, { text: 'Other' }], 'bud').map(
            (h) => h.text,
        ),
        ['Budget', 'Trip budget'],
    );

    const all = [
        { note: 'x', section: 's1', target: 'plans' },
        { note: 'x', target: 'plans', target_section: 's2' },
        { note: 'plans', target: 'plans' },
        { note: 'y', target: 'other' },
        { note: 'z', target: 'plans' },
    ];
    assert.deepEqual(
        backlinksOf(all, 'plans'),
        [
            { note: 'x', section: 's1' },
            { note: 'z', section: '' },
        ],
        'each note once, at its first link, never the note itself',
    );

    // A link raises the note to format 5, never lowers it, and exports as what it says.
    const linkIndex = openIndex();
    const targetId = linkIndex.create('text');
    const target = openNote(targetId, linkIndex);
    target.initialise();
    linkIndex.touch(targetId, { title: 'Trip plans' });
    const sourceId = linkIndex.create('text');
    const source = openNote(sourceId, linkIndex);
    source.initialise();
    assert.equal(get(source.format), 2);
    source.allowLinks();
    assert.equal(get(source.format), 5);
    source.doc.doc.transact(() => {
        const p = source.body.get(0);
        p.insert(0, [new Y.XmlText('See ')]);
        const plain = new Y.XmlElement('noteLink');
        plain.setAttribute('note', targetId);
        const labelled = new Y.XmlElement('noteLink');
        labelled.setAttribute('note', targetId);
        labelled.setAttribute('section', 's1');
        labelled.setAttribute('heading', 'Budget');
        labelled.setAttribute('label', 'the money');
        const missing = new Y.XmlElement('noteLink');
        missing.setAttribute('note', 'gone');
        p.insert(1, [plain, new Y.XmlText(' and '), labelled, new Y.XmlText(', '), missing]);
    });
    assert.equal(source.plainText(), 'See Trip plans and the money, Missing note\n');
    source.repairIndex();
    assert.equal(
        get(linkIndex.notes).find((n) => n.id === sourceId).title,
        'See Trip plans and the money, Missing note',
    );
    source.newInk();
    assert.equal(get(source.format), 5, 'a drawing after a link keeps format 5');
    const later = openNote(linkIndex.create('text'), linkIndex);
    later.initialise();
    later.doc.doc.getMap('meta').set('format', NOTE_FORMAT + 1);
    later.allowLinks();
    assert.equal(get(later.format), NOTE_FORMAT + 1, 'a newer note is left alone');
}

{
    // Attachments (format 6): raising the format, what they say as text, the list's picture.
    const attachIndex = openIndex();
    const id = attachIndex.create('text');
    const note = openNote(id, attachIndex);
    note.initialise();
    note.allowLinks();
    note.allowAttachments();
    assert.equal(get(note.format), 6);
    note.allowLinks();
    assert.equal(get(note.format), 6, 'a link after an attachment keeps format 6');
    const block = (attrs) => {
        const el = new Y.XmlElement('attachment');
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        return el;
    };
    note.doc.doc.transact(() => {
        note.body.get(0).insert(0, [new Y.XmlText('Site visit')]);
        const list = new Y.XmlElement('bulletList');
        const item = new Y.XmlElement('listItem');
        // An image inside a list still counts as the note's first.
        item.insert(0, [block({ blob: 'img1', kind: 'image', name: 'blade.jpg', thumb: 'th1' })]);
        list.insert(0, [item]);
        note.body.insert(1, [
            block({ blob: 'doc1', kind: 'pdf', name: 'manual.pdf' }),
            list,
            block({ blob: 'img2', kind: 'image', name: 'small.png' }),
            block({ blob: 'lnk1', kind: 'link', url: 'https://example.com/', title: 'Example' }),
            block({ blob: 'f1', kind: 'file', name: 'data.csv' }),
        ]);
    });
    assert.equal(
        note.plainText(),
        'Site visit\n[PDF: manual.pdf]\n- [Image: blade.jpg]\n[Image: small.png]\n[Link: Example https://example.com/]\n[File: data.csv]\n',
    );
    note.repairIndex();
    const entry = get(attachIndex.notes).find((n) => n.id === id);
    assert.equal(entry.title, 'Site visit', 'an attachment is never the title');
    assert.equal(entry.preview, '', 'nor the preview');
    assert.equal(entry.picture, 'th1', "the first image's thumbnail");
    note.doc.doc.transact(() => note.body.delete(1, 2));
    note.repairIndex();
    assert.equal(get(attachIndex.notes).find((n) => n.id === id).picture, 'img2', 'a small image is its own');
    note.doc.doc.transact(() => note.body.delete(1, 1));
    note.repairIndex();
    assert.equal(get(attachIndex.notes).find((n) => n.id === id).picture, '', 'none left');
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
newer.newInk();
newer.allowLinks();
assert.equal(newer.ink('strokes:refused').add({ tool: 'pen', color: 'ink', width: 4, points }), '');
newer.ink('strokes:refused').erase(new Map([['anything', []]]));
newer.ink('strokes:refused').remove(['anything']);
newer.ink('strokes:refused').reshape(new Map([['anything', { points, width: 1 }]]));
newer.ink('strokes:refused').setPaper('grid');
assert.equal(newer.renameTag('anything', 'else'), false);
assert.equal(stateOf(newer.doc.doc), frozenNote, 'no edit reaches a newer note');
assert.equal(stateOf(fixtureIndex.doc.doc), frozenIndex, 'nor its index entry');
console.log(
    'PASS: trash/restore, concurrent offline edit, stable item IDs, persistence roundtrip, deterministic ordering, legacy metadata, format 1 fixtures, index repair, seed bytes, migration guards, title rule, several checklists, drawings, highlighter and partial erase, lasso and ruler geometry, move/resize, paper, sketches for thumbnails, folders (tree, loops, move, delete and restore, crossing changes), tags (the rule, renaming in text, lists and titles, suggestions while typing), Smart Folders (conditions, matching, following tags), find in note (folding, offsets, order, keeping its place), note links (what they say, URLs, typing, suggestions, backlinks, format 5, as text), attachments (format 6, as text, the notes list picture), addresses and phone numbers detected, plain text, newer-format guard, late store subscribers',
);
for (const held of docs.values()) held.doc.destroy();
deviceA.destroy();
deviceB.destroy();
remoteIndex.destroy();
remoteNote.destroy();
reloaded.destroy();
