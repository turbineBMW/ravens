// Put demo lists into a running muninn-server for the dev user, through the
// same sync protocol the app uses. Prints the first list id.
//   node scripts/seed-muninn.mjs [ws://127.0.0.1:8082/muninn/v1/sync]
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { generateKeyBetween } from 'fractional-indexing';

const url = process.argv[2] ?? 'ws://127.0.0.1:8082/muninn/v1/sync';
const synced = (p) => new Promise((r) => (p.synced ? r() : p.once('sync', r)));
const open = (room) => {
    const doc = new Y.Doc();
    const p = new WebsocketProvider(url, room, doc, { WebSocketPolyfill: globalThis.WebSocket, disableBc: true });
    return { doc, p };
};
const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const day = (n) => iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));

const lists = [
    {
        name: 'Home',
        color: 'blue',
        tasks: [
            ['Replace the water filter', { due: day(0), flagged: true }],
            ['Book the car in for tires', { due: day(1) }],
            ['Clean gutters', { due: day(5) }],
            ['Order birthday present', { priority: 3 }],
            ['Take out recycling', { done: true }],
        ],
    },
    {
        name: 'Ravens',
        color: 'purple',
        tasks: [
            [
                'Try the grocery list on the Fold',
                { due: day(0), source: { app: 'huginn', id: process.argv[3] ?? 'demo' } },
            ],
            ['Design Muninn notifications', {}],
            ['Ink layer spike', { due: day(9) }],
        ],
    },
];

const index = open('index');
await synced(index.p);
const ids = [];
let lpos = null;
for (const l of lists) {
    const id = 'demo' + Math.random().toString(36).slice(2, 8);
    ids.push(id);
    const list = open(`list:${id}`);
    await synced(list.p);
    const tasks = list.doc.getMap('tasks');
    let pos = null;
    list.doc.transact(() => {
        l.tasks.forEach(([title, o], i) => {
            pos = generateKeyBetween(pos, null);
            const m = new Y.Map();
            m.set('title', title);
            m.set('notes', o.notes ?? '');
            m.set('done', !!o.done);
            m.set('doneAt', o.done ? Date.now() - 60000 : 0);
            m.set('due', o.due ?? '');
            m.set('allDay', true);
            m.set('flagged', !!o.flagged);
            m.set('priority', o.priority ?? 0);
            m.set('pos', pos);
            m.set('parent', '');
            m.set('source', o.source ? JSON.stringify(o.source) : '');
            tasks.set(`t${i}`, m);
        });
    });
    lpos = generateKeyBetween(lpos, null);
    index.doc.transact(() => {
        const m = new Y.Map();
        m.set('name', l.name);
        m.set('color', l.color);
        m.set('pos', lpos);
        m.set('open', l.tasks.filter(([, o]) => !o.done).length);
        m.set('created', Date.now());
        m.set('updated', Date.now());
        index.doc.getMap('lists').set(id, m);
    });
    await new Promise((r) => setTimeout(r, 150));
    list.p.destroy();
}
await new Promise((r) => setTimeout(r, 300));
index.p.destroy();
console.log(ids[0]);
process.exit(0);
