// Put a demo grocery list into a running huginn-server for the dev user,
// through the same sync protocol the app uses. Prints the note id.
//   node scripts/seed-demo.mjs [ws://127.0.0.1:8081/huginn/v1/sync]
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { generateKeyBetween } from 'fractional-indexing';

const url = process.argv[2] ?? 'ws://127.0.0.1:8081/huginn/v1/sync';
const id = 'demo' + Date.now().toString(36);
const synced = (p) => new Promise((r) => (p.synced ? r() : p.once('sync', r)));
const open = (room) => {
    const doc = new Y.Doc();
    const p = new WebsocketProvider(url, room, doc, { params: { v: '4' }, WebSocketPolyfill: globalThis.WebSocket, disableBc: true });
    return { doc, p };
};

const note = open(`note:${id}`);
await synced(note.p);
const items = note.doc.getMap('items');
const texts = ['Milk', 'Eggs', 'Sourdough', 'Coffee beans', 'Apples', 'Olive oil', 'Paper towels'];
let pos = null;
const now = Date.now();
note.doc.transact(() => {
    note.doc.getMap('meta').set('title', 'Groceries');
    texts.forEach((text, i) => {
        pos = generateKeyBetween(pos, null);
        const m = new Y.Map();
        m.set('text', text);
        m.set('checked', i >= 5);
        m.set('checkedAt', i >= 5 ? now - (7 - i) * 60_000 : 0);
        m.set('pos', pos);
        items.set(`i${i}`, m);
    });
});

const index = open('index');
await synced(index.p);
index.doc.transact(() => {
    const m = new Y.Map();
    m.set('title', 'Groceries');
    m.set('kind', 'checklist');
    m.set('created', now);
    m.set('updated', now);
    m.set('pinned', false);
    m.set('preview', texts.slice(0, 4).join('\n'));
    m.set('open', 5);
    m.set('done', 2);
    index.doc.getMap('notes').set(id, m);
});
await new Promise((r) => setTimeout(r, 300));
note.p.destroy();
index.p.destroy();
console.log(id);
process.exit(0);
