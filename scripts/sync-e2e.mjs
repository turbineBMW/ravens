// Two y-websocket clients (as two devices) against a running huginn-server:
// A writes, B must see it; then a fresh client C after both disconnect must
// load it from the server's SQLite, proving persistence.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const url = process.argv[2] ?? 'ws://127.0.0.1:8081/huginn/v1/sync';
const room = 'note:e2e' + Date.now().toString(36);
const until = (check, ms = 5000) =>
    new Promise((res, rej) => {
        const t0 = Date.now();
        const tick = () => (check() ? res() : Date.now() - t0 > ms ? rej(new Error('timeout')) : setTimeout(tick, 25));
        tick();
    });
const open = () => {
    const doc = new Y.Doc();
    const p = new WebsocketProvider(url, room, doc, { params: { v: '2' }, WebSocketPolyfill: globalThis.WebSocket, disableBc: true });
    return { doc, p, synced: until(() => p.synced) };
};

const a = open(),
    b = open();
await a.synced;
await b.synced;
console.log('A and B synced with the server');

const itemsA = a.doc.getMap('items');
a.doc.transact(() => {
    const m = new Y.Map();
    m.set('text', 'milk');
    m.set('checked', false);
    m.set('pos', 'a0');
    itemsA.set('i1', m);
});
await until(() => b.doc.getMap('items').get('i1')?.get('text') === 'milk');
console.log("B saw A's item within", 'the budget');

b.doc.getMap('items').get('i1').set('checked', true);
await until(() => itemsA.get('i1')?.get('checked') === true);
console.log("A saw B's check");

a.p.destroy();
b.p.destroy();
await new Promise((r) => setTimeout(r, 200));

const c = open();
await c.synced;
await until(() => c.doc.getMap('items').get('i1')?.get('checked') === true);
console.log('C loaded the persisted document after A and B left');
c.p.destroy();
console.log('OK');
process.exit(0);
