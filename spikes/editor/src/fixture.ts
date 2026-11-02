import * as Y from 'yjs';
import fixture from '../../../scripts/fixtures/huginn-format-1.json';

export const FIXTURE_NOTE = 'fixturegroceries001';

export function formatOneNote(): Y.Doc {
    const doc = new Y.Doc();
    const bytes = Uint8Array.from(atob(fixture.notes[FIXTURE_NOTE]), (c) => c.charCodeAt(0));
    Y.applyUpdate(doc, bytes);
    return doc;
}

/** Two documents joined by a link that can drop, like a device going offline. */
export function pair(a: Y.Doc, b: Y.Doc) {
    let online = true;
    const NET = 'network';
    const exchange = () => {
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), NET);
        Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), NET);
    };
    const forward = (to: Y.Doc) => (update: Uint8Array, origin: unknown) => {
        if (online && origin !== NET) Y.applyUpdate(to, update, NET);
    };
    a.on('update', forward(b));
    b.on('update', forward(a));
    exchange();
    return {
        setOnline(value: boolean) {
            online = value;
            if (online) exchange();
        },
    };
}
