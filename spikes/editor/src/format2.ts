/**
 * The candidate format 2: a rich `body` fragment beside the unchanged format 1
 * `items` map. A checklist in the body is only a reference to that map, so items
 * keep their IDs and positions, and nothing about them is migrated.
 */
import * as Y from 'yjs';

function fnv1a(text: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * The migration of a format 1 note, as a Yjs update. Its author and content
 * depend only on the note ID, so every device produces the same operations, and
 * applying them twice, or after they were later edited or deleted, changes nothing.
 */
export function migrationSeed(noteId: string): Uint8Array {
    const seed = new Y.Doc();
    seed.clientID = fnv1a(`huginn-format-2:${noteId}`);
    seed.transact(() => {
        seed.getMap('meta').set('format', 2);
        const checklist = new Y.XmlElement('checklist');
        checklist.setAttribute('list', 'items');
        seed.getXmlFragment('body').insert(0, [checklist, new Y.XmlElement('paragraph')]);
    });
    const update = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    return update;
}

/** The title policy: an explicit title, else the first line with text. */
export function effectiveTitle(doc: Y.Doc): string {
    const explicit = String(doc.getMap('meta').get('title') ?? '').trim();
    if (explicit) return explicit;
    for (const node of doc.getXmlFragment('body').toArray()) {
        if (!(node instanceof Y.XmlElement)) continue;
        if (node.nodeName === 'checklist') {
            const items = [...doc.getMap<Y.Map<unknown>>('items').values()];
            const first = items
                .filter((i) => !i.get('checked'))
                .map((i) => [String(i.get('pos')), String(i.get('text') ?? '')])
                .sort((a, b) => (a[0] < b[0] ? -1 : 1))[0];
            if (first?.[1].trim()) return first[1].trim();
            continue;
        }
        const text = node
            .toString()
            .replace(/<[^>]*>/g, '')
            .trim();
        if (text) return text.split('\n')[0];
    }
    return '';
}
