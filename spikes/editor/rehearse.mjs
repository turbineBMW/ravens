// Rehearse the format 2 migration against a server's real documents, in memory.
//
//   node rehearse.mjs wss://<host>/huginn/v1/sync
//
// Read-only: it asks for each document's state and sends nothing else, no edits
// and no presence. It saves nothing to disk, and prints only shapes and counts,
// never titles or item text. Run on Node 22.18+ (it imports a TypeScript file).
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { migrationSeed } from './src/format2.ts';

const base = process.argv[2];
if (!base?.match(/^wss?:\/\//)) {
    console.error('Usage: node rehearse.mjs wss://<host>/huginn/v1/sync');
    process.exit(2);
}

function read(name) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base}/${name}?v=2`);
        ws.binaryType = 'arraybuffer';
        const timer = setTimeout(() => {
            ws.close();
            reject(Error(`timed out reading a document`));
        }, 15_000);
        ws.onerror = () => {
            clearTimeout(timer);
            reject(Error(`could not connect to ${base}`));
        };
        ws.onopen = () => {
            const request = encoding.createEncoder();
            encoding.writeVarUint(request, 0); // sync
            encoding.writeVarUint(request, 0); // step 1: "send me everything"
            encoding.writeVarUint8Array(request, Y.encodeStateVector(new Y.Doc()));
            ws.send(encoding.toUint8Array(request));
        };
        ws.onmessage = ({ data }) => {
            const reply = decoding.createDecoder(new Uint8Array(data));
            if (decoding.readVarUint(reply) !== 0 || decoding.readVarUint(reply) !== 1) return;
            const update = decoding.readVarUint8Array(reply);
            clearTimeout(timer);
            ws.close();
            resolve(update);
        };
    });
}
const docFrom = (update) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    return doc;
};
const same = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const KNOWN_ITEM_KEYS = new Set(['text', 'checked', 'checkedAt', 'pos']);

const index = docFrom(await read('index'));
const entries = [...index.getMap('notes').entries()];
const totals = { notes: entries.length, deleted: 0, items: 0, largestNoteBytes: 0, empty: 0, failed: 0 };
const shapes = new Set();
const problems = [];
for (const [id, entry] of entries) {
    if (entry.get('deletedAt')) totals.deleted++;
    const label = `note ${id.slice(0, 6)}…`;
    const update = await read(`note:${id}`);
    totals.largestNoteBytes = Math.max(totals.largestNoteBytes, update.length);
    const original = docFrom(update);
    const items = original.getMap('items');
    const meta = original.getMap('meta');
    totals.items += items.size;
    shapes.add(`top level: ${[...original.share.keys()].sort().join(', ') || '(empty)'}`);
    shapes.add(`meta: ${[...meta.keys()].sort().join(', ') || '(none)'}`);
    if (!meta.size && !items.size) totals.empty++;
    if (meta.has('format')) problems.push(`${label} already has a format`);
    if (original.share.has('body')) problems.push(`${label} already has a body`);
    for (const item of items.values()) {
        if (!(item instanceof Y.Map)) {
            problems.push(`${label} has an item that is not a map`);
            continue;
        }
        for (const key of item.keys()) if (!KNOWN_ITEM_KEYS.has(key)) shapes.add(`unexpected item key: ${key}`);
        if (typeof item.get('pos') !== 'string') problems.push(`${label} has an item without a position`);
    }

    // Two devices migrate on their own, then meet, and one migrates again.
    const a = docFrom(update);
    const b = docFrom(update);
    Y.applyUpdate(a, migrationSeed(id));
    Y.applyUpdate(b, migrationSeed(id));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, migrationSeed(id));
    const before = totals.failed;
    const fail = (what) => {
        if (totals.failed === before) totals.failed++;
        problems.push(`${label}: ${what}`);
    };
    const body = a
        .getXmlFragment('body')
        .toArray()
        .map((n) => n.nodeName)
        .join();
    if (body !== 'checklist,paragraph') fail(`body is ${body}`);
    if (JSON.stringify(a.getMap('items').toJSON()) !== JSON.stringify(items.toJSON())) fail('items changed');
    if (a.getMap('meta').get('title') !== meta.get('title')) fail('title changed');
    if (a.getMap('meta').get('format') !== 2) fail('format not set');
    if (!same(Y.encodeStateVector(a), Y.encodeStateVector(b))) fail('devices disagree');
    original.destroy();
    a.destroy();
    b.destroy();
}
console.log(JSON.stringify({ totals, shapes: [...shapes].sort(), problems }, null, 2));
process.exit(problems.length ? 1 : 0);
