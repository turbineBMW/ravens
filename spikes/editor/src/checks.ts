import { generateKeyBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import { mount, type Device, LOCAL } from './device';
import { FIXTURE_NOTE, formatOneNote, pair } from './fixture';
import { effectiveTitle, migrationSeed } from './format2';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function assert(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
const bodyNames = (doc: Y.Doc) =>
    doc
        .getXmlFragment('body')
        .toArray()
        .map((n) => (n as Y.XmlElement).nodeName);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const vector = (doc: Y.Doc) => hex(Y.encodeStateVector(doc));
const MILK = 'itemmilk0000000000a1';
const EGGS = 'itemeggs0000000000a2';

function migrated() {
    const doc = formatOneNote();
    Y.applyUpdate(doc, migrationSeed(FIXTURE_NOTE));
    return doc;
}
function merge(a: Y.Doc, b: Y.Doc) {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}
const type = (d: Device, at: number, text: string) => d.editor.commands.insertContentAt(at, text);
const endOfBody = (d: Device) => d.editor.state.doc.content.size - 1;
const text = (d: Device) => d.editor.state.doc.textContent;

export async function runChecks(sandbox: HTMLElement, report: (name: string, error?: string) => void) {
    const failures: string[] = [];
    const held: Device[] = [];
    const device = (doc: Y.Doc) => {
        const host = document.createElement('div');
        sandbox.append(host);
        const d = mount(host, doc);
        held.push(d);
        return d;
    };
    const check = async (name: string, body: () => void | Promise<void>) => {
        try {
            await body();
            report(name);
        } catch (e) {
            failures.push(name);
            report(name, e instanceof Error ? e.message : String(e));
        }
    };

    await check('Two devices migrating offline produce identical bytes and one checklist', () => {
        assert(hex(migrationSeed(FIXTURE_NOTE)) === hex(migrationSeed(FIXTURE_NOTE)), 'seed bytes differ');
        const a = migrated();
        const b = migrated();
        merge(a, b);
        assert(bodyNames(a).join() === 'checklist,paragraph', `body is ${bodyNames(a)}`);
        assert(hex(Y.encodeStateVector(a)) === hex(Y.encodeStateVector(b)), 'devices disagree');
    });

    await check('Migration leaves items, IDs, positions and the title untouched', () => {
        const before = formatOneNote();
        const after = migrated();
        assert(
            JSON.stringify(before.getMap('items').toJSON()) === JSON.stringify(after.getMap('items').toJSON()),
            'items changed',
        );
        assert(after.getMap('meta').get('title') === 'Groceries', 'title changed');
        assert(after.getMap('meta').get('format') === 2, 'format not set');
    });

    await check('Migrating again cannot bring back a deleted block or undo edits', () => {
        const a = migrated();
        const body = a.getXmlFragment('body');
        body.delete(0, 1);
        const paragraph = body.get(0) as Y.XmlElement;
        paragraph.insert(0, [new Y.XmlText('kept')]);
        Y.applyUpdate(a, migrationSeed(FIXTURE_NOTE));
        assert(bodyNames(a).join() === 'paragraph', `body is ${bodyNames(a)}`);
        assert(body.toString().includes('kept'), 'edit lost');
    });

    await check('A late edit from a format 1 device still lands', () => {
        const old = formatOneNote();
        const a = migrated();
        old.getMap<Y.Map<string>>('items').get(MILK)!.set('text', 'Oat milk');
        merge(a, old);
        assert(a.getMap<Y.Map<string>>('items').get(MILK)!.get('text') === 'Oat milk', 'edit lost');
        assert(bodyNames(a).join() === 'checklist,paragraph', 'body changed');
    });

    await check('Opening the editor writes nothing to the document', async () => {
        const doc = migrated();
        const before = vector(doc);
        const d = device(doc);
        await sleep(100);
        assert(vector(doc) === before, 'the editor wrote on mount');
        assert(d.editor.state.doc.child(0).type.name === 'checklist', 'checklist not rendered');
    });

    await check('Offline edits to prose and items on two devices both survive', async () => {
        const a = device(migrated());
        const b = device(migrated());
        await sleep(50);
        type(a, endOfBody(a), 'Written on A. ');
        b.items.get(EGGS)!.set('checked', true);
        b.editor.chain().insertContentAt(0, '<h2>Heading from B</h2>').run();
        merge(a.doc, b.doc);
        await sleep(50);
        for (const d of [a, b]) {
            assert(text(d).includes('Written on A.'), 'lost A text');
            assert(text(d).includes('Heading from B'), 'lost B heading');
            assert(d.items.get(EGGS)!.get('checked') === true, 'lost check');
        }
        assert(a.doc.getXmlFragment('body').toString() === b.doc.getXmlFragment('body').toString(), 'bodies differ');
    });

    await check('Concurrent typing in one paragraph merges by character', async () => {
        const a = device(migrated());
        const b = device(migrated());
        await sleep(50);
        type(a, endOfBody(a), 'shared');
        merge(a.doc, b.doc);
        await sleep(50);
        const at = endOfBody(a);
        type(a, at, ' from-A');
        type(b, at, ' from-B');
        merge(a.doc, b.doc);
        await sleep(50);
        for (const d of [a, b]) {
            assert(text(d).includes('from-A') && text(d).includes('from-B'), `merged: ${text(d)}`);
        }
        assert(text(a) === text(b), 'devices disagree');
    });

    await check('Moving an item while another device edits it keeps both', () => {
        const a = migrated();
        const b = migrated();
        const items = (d: Y.Doc) => d.getMap<Y.Map<string>>('items');
        items(a).get(MILK)!.set('pos', generateKeyBetween('a4', null));
        items(b).get(MILK)!.set('text', 'Oat milk');
        merge(a, b);
        assert(items(a).get(MILK)!.get('text') === 'Oat milk', 'edit lost');
        assert(items(a).get(MILK)!.get('pos')! > 'a4', 'move lost');
    });

    await check('(Why not inline) Moving an inline task node loses a concurrent edit', () => {
        const a = new Y.Doc();
        const task = new Y.XmlElement('taskItem');
        task.insert(0, [new Y.XmlText('Milk')]);
        a.getXmlFragment('body').insert(0, [task, new Y.XmlElement('paragraph')]);
        const b = new Y.Doc();
        Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
        // A move is a delete and a copy: there is no move for XML nodes.
        const body = a.getXmlFragment('body');
        const copy = new Y.XmlElement('taskItem');
        copy.insert(0, [new Y.XmlText('Milk')]);
        a.transact(() => {
            body.delete(0, 1);
            body.insert(1, [copy]);
        });
        const moved = b.getXmlFragment('body').get(0) as Y.XmlElement;
        (moved.get(0) as Y.XmlText).insert(0, 'Oat ');
        merge(a, b);
        assert(!a.getXmlFragment('body').toString().includes('Oat'), 'expected the concurrent edit to be lost');
    });

    await check("Undo removes only this device's edits, across prose and items", async () => {
        const docA = migrated();
        const docB = migrated();
        pair(docA, docB);
        const a = device(docA);
        const b = device(docB);
        await sleep(50);
        type(b, endOfBody(b), 'B stays. ');
        await sleep(50);
        a.undo.stopCapturing();
        type(a, endOfBody(a), 'A goes. ');
        await sleep(50);
        assert(text(b).includes('A goes.'), 'did not reach B');
        a.undo.stopCapturing();
        docA.transact(() => a.items.get(MILK)!.set('text', 'Changed on A'), LOCAL);
        a.editor.commands.undo();
        assert(a.items.get(MILK)!.get('text') === 'Milk', 'item edit not undone');
        a.editor.commands.undo();
        await sleep(50);
        for (const d of [a, b]) {
            assert(!text(d).includes('A goes.'), 'A text not undone');
            assert(text(d).includes('B stays.'), 'undo erased B');
        }
    });

    await check('Formatting and a table survive reload from the stored bytes', async () => {
        const doc = migrated();
        const d = device(doc);
        await sleep(50);
        d.editor.commands.insertContentAt(
            endOfBody(d),
            '<p><strong>bold</strong> <em>italic</em> <mark>marked</mark> <a href="https://example.com">link</a></p><table><tbody><tr><td><p>cell</p></td><td><p>two</p></td></tr></tbody></table><ul><li><p>bullet</p></li></ul><hr>',
        );
        await sleep(50);
        const reloaded = new Y.Doc();
        Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(doc));
        const again = device(reloaded);
        await sleep(50);
        const html = again.editor.getHTML();
        for (const piece of [
            '<strong>bold',
            '<em>italic',
            '<mark>marked',
            'href="https://example.com"',
            '<table',
            'cell',
            '<ul',
            '<hr',
        ]) {
            assert(html.includes(piece), `lost ${piece}`);
        }
    });

    await check('Pasted scripts and unknown markup are dropped', async () => {
        const d = device(migrated());
        await sleep(50);
        d.editor.commands.insertContentAt(
            endOfBody(d),
            '<p onclick="x()">safe<script>bad()</script><iframe src="https://example.com"></iframe></p><a href="javascript:bad()">link</a>',
        );
        const html = d.editor.getHTML();
        for (const piece of ['script', 'iframe', 'onclick', 'javascript:']) {
            assert(!html.includes(piece), `kept ${piece}: ${html}`);
        }
    });

    await check('The title is explicit if set, otherwise the first line', () => {
        const doc = migrated();
        assert(effectiveTitle(doc) === 'Groceries', 'explicit title ignored');
        doc.getMap('meta').set('title', '');
        assert(effectiveTitle(doc) === 'Milk', `from checklist: ${effectiveTitle(doc)}`);
        const prose = new Y.Doc();
        const first = new Y.XmlElement('paragraph');
        first.insert(0, [new Y.XmlText('First line')]);
        prose.getXmlFragment('body').insert(0, [new Y.XmlElement('paragraph'), first]);
        assert(effectiveTitle(prose) === 'First line', `from prose: ${effectiveTitle(prose)}`);
    });

    for (const d of held) d.destroy();
    sandbox.replaceChildren();
    return { failures };
}
