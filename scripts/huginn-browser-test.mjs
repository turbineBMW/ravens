// Drive the built client in headless Chromium against a throwaway server: rich
// text, drawings, a format 1 note written by the old code, save confirmation through a
// server outage, a second device, an old client being turned away, opening a
// note offline, resizing, narrow widths and navigation.
//
//   npm run build -w huginn/web && cargo build -p huginn-server
//   node scripts/huginn-browser-test.mjs
//
// Needs Node 22+ and `chromium` on the PATH. Touches no real data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 18091;
const OLD_CLIENT_PORT = 18092;
const DEBUG_PORT = 19291;
const BASE = `http://127.0.0.1:${API_PORT}/huginn/`;
const work = mkdtempSync(join(tmpdir(), 'huginn-browser-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server;
function startServer() {
    server = spawn('target/debug/huginn-server', {
        stdio: 'ignore',
        env: {
            ...process.env,
            RAVEN_DB_PATH: join(work, 'test.db'),
            RAVEN_LISTEN_ADDR: `127.0.0.1:${API_PORT}`,
            RAVEN_DEV_USER: 'browser-test',
            RAVEN_WEB_DIR: 'huginn/web/build',
        },
    });
}
function stopServer() {
    server.kill();
}

const browser = spawn(
    'chromium',
    [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${join(work, 'profile')}`,
        'about:blank',
    ],
    { stdio: 'ignore' },
);

// Any old-style client connecting here is closed the way raven-server turns one away.
let oldClientConnections = 0;
const oldClientProxy = createServer(async (req, res) => {
    const upstream = await fetch(`http://127.0.0.1:${API_PORT}${req.url}`);
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
});
oldClientProxy.on('upgrade', (req, socket) => {
    oldClientConnections++;
    const accept = createHash('sha1')
        .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
    socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(Buffer.from([0x88, 0x02, 4426 >> 8, 4426 & 0xff]));
});

function cleanup() {
    server?.kill();
    browser.kill();
    oldClientProxy.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

let browserSocket;
let nextId = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => reject(Error(`timed out: ${method}`)), 20_000);
        pending.set(id, (message) => {
            clearTimeout(timer);
            if (message.error) reject(Error(`${method}: ${message.error.message}`));
            else resolve(message.result);
        });
        browserSocket.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

/** A page in its own storage: another browser context is another device. */
async function device() {
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    await call('Page.enable');
    const errors = [];
    await call('Runtime.enable');
    pageErrors.set(sessionId, errors);
    const js = async (expression) => {
        const { result, exceptionDetails } = await call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (exceptionDetails) throw Error(`${expression}: ${exceptionDetails.exception?.description}`);
        return result.value;
    };
    return {
        js,
        errors,
        type: (text) => call('Input.insertText', { text }),
        drag: async (from, to) => {
            const mouse = (type, [x, y], buttons) =>
                call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
            await mouse('mousePressed', from, 1);
            for (let i = 1; i <= 6; i++) {
                await mouse(
                    'mouseMoved',
                    [from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6],
                    1,
                );
                await sleep(30);
            }
            await sleep(100);
            await mouse('mouseReleased', to, 0);
        },
        /** A stroke through `points`, from a pen pressing at `force` or the mouse. */
        stroke: async (points, pointerType = 'mouse', force = 0.5) => {
            const at = (type, [x, y], buttons) =>
                call('Input.dispatchMouseEvent', {
                    type,
                    x,
                    y,
                    button: 'left',
                    buttons,
                    clickCount: 1,
                    pointerType,
                    force: buttons ? force : 0,
                });
            await at('mousePressed', points[0], 1);
            for (const point of points.slice(1)) {
                await at('mouseMoved', point, 1);
                await sleep(16);
            }
            await at('mouseReleased', points[points.length - 1], 0);
        },
        go: async (url) => {
            await call('Page.navigate', { url });
            await until(js, `document.querySelector('.headerbar') !== null`);
        },
        size: (width, height = 800) =>
            call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
    };
}
const pageErrors = new Map();

async function until(js, expression, timeout = 15_000) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        last = await js(expression).catch(() => undefined);
        if (last) return last;
        await sleep(100);
    }
    throw Error(`never became true: ${expression} (last: ${last})`);
}
const subtitle = `document.querySelector('.editor-pane .headerbar-subtitle')?.textContent`;
const subtitleIs = (text) => `${subtitle} === ${JSON.stringify(text)}`;
const noteTitle = `document.querySelector('.headerbar-input')?.value`;
const setTitle = (page, text) =>
    page.js(`(() => {
        const input = document.querySelector('.headerbar-input');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
const newNote = async (page) => {
    const from = await page.js('location.pathname');
    const add = `document.querySelector('.notes-pane .headerbar-start button')`;
    await until(page.js, `${add} && !${add}.disabled`);
    await page.js(`${add}.click()`);
    await until(
        page.js,
        `location.pathname !== ${JSON.stringify(from)} && !!document.querySelector('.headerbar-input')`,
    );
};
const focusBody = async (page) => {
    await until(page.js, `!!document.querySelector('.tiptap')`);
    await page.js(`document.querySelector('.tiptap').focus()`);
    await until(page.js, `document.activeElement === document.querySelector('.tiptap')`);
};
const tool = (page, label) => page.js(`document.querySelector('.editor-toolbar [aria-label="${label}"]').click()`);
const bodyHtml = `document.querySelector('.tiptap').innerHTML`;
const rowTitle = `document.querySelector('.note-row.selected strong')?.textContent`;
const overflows = (page) => page.js('document.documentElement.scrollWidth > innerWidth');

async function main() {
    startServer();
    let version;
    for (let i = 0; i < 80 && !version; i++) {
        await sleep(250);
        version = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version')
            .then((r) => r.json())
            .catch(() => undefined);
    }
    assert.ok(version, 'chromium did not start');
    browserSocket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve) => (browserSocket.onopen = resolve));
    browserSocket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.id) {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
        } else if (message.method === 'Runtime.exceptionThrown') {
            pageErrors.get(message.sessionId)?.push(message.params.exceptionDetails.exception?.description);
        }
    };

    const page = await device();
    await page.size(1280);
    await page.go(BASE);

    // Saved only once the server has it, through an outage.
    await newNote(page);
    assert.equal(await page.js(`document.querySelectorAll('.note-checklist').length`), 0, 'a new note starts as text');
    await focusBody(page);
    await page.type('First line of the note');
    await until(page.js, subtitleIs('Saved'));
    // The title rule, in the list and the header.
    await until(page.js, `${rowTitle} === 'First line of the note'`);
    assert.equal(await page.js(`document.querySelector('.headerbar-input').placeholder`), 'First line of the note');
    assert.equal(await page.js(noteTitle), '', 'the first line is not stored as a title');
    await setTitle(page, 'Groceries');
    await until(page.js, `${rowTitle} === 'Groceries'`);
    await setTitle(page, '');
    await until(page.js, `${rowTitle} === 'First line of the note'`);
    await setTitle(page, 'Groceries');
    const noteUrl = await page.js('location.href');
    // Formatting from the toolbar, a table, and undo.
    await page.js(`(() => {
        const add = [...document.querySelectorAll('.editor-toolbar button')].find((b) => b.textContent === 'Checklist');
        add.click();
    })()`);
    await until(page.js, `document.querySelectorAll('.note-checklist').length === 1`);
    await page.js(`window.__editorEnd = document.querySelector('.tiptap'); window.__editorEnd.focus()`);
    await tool(page, 'Add table');
    await until(page.js, `${bodyHtml}.includes('<table')`);
    assert.equal(
        await page.js(`document.querySelectorAll('.note-checklist').length`),
        1,
        'the table replaced the checklist',
    );
    await sleep(500); // Undo groups edits made close together.
    await tool(page, 'Add row');
    await until(page.js, `document.querySelectorAll('.tiptap tr').length === 3`);
    await tool(page, 'Undo');
    await until(page.js, `document.querySelectorAll('.tiptap tr').length === 2`);
    await page.js(`(() => {
        const add = document.querySelector('.checklist input[placeholder="Add item"]');
        add.value = 'Milk';
        add.dispatchEvent(new Event('input', { bubbles: true }));
        add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await until(page.js, `[...document.querySelectorAll('.checklist .text')].some((i) => i.value === 'Milk')`);
    await until(page.js, subtitleIs('Saved'));

    // A second checklist is its own list: adding, Alt+arrow and dragging stay inside it.
    await tool(page, 'Add checklist');
    await until(page.js, `document.querySelectorAll('.note-checklist').length === 2`);
    const addTo = (list, text) =>
        page.js(`(() => {
            const add = document.querySelectorAll('.note-checklist')[${list}].querySelector('input[placeholder="Add item"]');
            add.value = ${JSON.stringify(text)};
            add.dispatchEvent(new Event('input', { bubbles: true }));
            add.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        })()`);
    const listTexts = (list) =>
        page.js(
            `[...document.querySelectorAll('.note-checklist')[${list}].querySelectorAll('li[data-item] .text')].map((i) => i.value)`,
        );
    await addTo(1, 'Second A');
    await addTo(1, 'Second B');
    await until(
        page.js,
        `document.querySelectorAll('.note-checklist')[1].querySelectorAll('li[data-item]').length === 2`,
    );
    assert.deepEqual(await listTexts(0), ['Milk'], 'the first list is unchanged');
    const dragRow = async (from, to) => {
        await sleep(400); // Rows slide into place after a change.
        const at = await page.js(`(() => {
            const rows = document.querySelectorAll('.note-checklist')[1].querySelectorAll('li[data-item]');
            const middle = (el) => { const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };
            return { from: middle(rows[${from}].querySelector('.handle')), to: middle(rows[${to}]) };
        })()`);
        await page.drag(at.from, [at.to[0], at.to[1] + (to > from ? 20 : -20)]);
    };
    const firstRow = (text) =>
        `document.querySelectorAll('.note-checklist')[1].querySelector('li[data-item] .text').value === '${text}'`;
    // Each way: the browser moves a different row in the DOM depending on direction.
    await dragRow(0, 1);
    await until(page.js, firstRow('Second B'));
    await dragRow(1, 0);
    await until(page.js, firstRow('Second A'));
    await dragRow(0, 1);
    await until(page.js, firstRow('Second B'));
    assert.deepEqual(await listTexts(1), ['Second B', 'Second A'], 'drag reorders within the list');
    assert.deepEqual(await listTexts(0), ['Milk'], 'dragging leaves the other list alone');

    // Sections: headings get IDs, collapse on this device only, and selected text
    // makes a reminder linking back to its section.
    await page.js(`document.querySelector('.tiptap').focus()`);
    await page.js(`(() => {
        const ed = document.querySelector('.tiptap').editor;
        ed.chain().focus('end').insertContent('<h2>Plans</h2><p>Under plans</p><h2>Later</h2><p>Under later</p>').run();
    })()`);
    await until(page.js, `document.querySelectorAll('.tiptap h2[data-section]').length === 2`);
    const sectionIds = await page.js(`[...document.querySelectorAll('.tiptap h2')].map((h) => h.dataset.section)`);
    assert.notEqual(sectionIds[0], sectionIds[1]);
    await page.js(`document.querySelector('.tiptap h2 .section-toggle').click()`);
    await until(
        page.js,
        `[...document.querySelectorAll('.tiptap p')].find((p) => p.textContent === 'Under plans')?.classList.contains('section-hidden')`,
    );
    assert.equal(
        await page.js(
            `[...document.querySelectorAll('.tiptap p')].find((p) => p.textContent === 'Under later').classList.contains('section-hidden')`,
        ),
        false,
        'collapsing one section hides only it',
    );
    await page.js(`(() => {
        const ed = document.querySelector('.tiptap').editor;
        let at = 0;
        ed.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Under later') at = pos; });
        ed.chain().focus().setTextSelection({ from: at, to: at + 5 }).run();
    })()`);
    await until(page.js, `!!document.querySelector('.editor-toolbar a.tool-link')`);
    const remindHref = await page.js(`document.querySelector('.editor-toolbar a.tool-link').getAttribute('href')`);
    const remindParams = new URL(remindHref, BASE).searchParams;
    assert.equal(remindParams.get('title'), 'Under');
    assert.equal(JSON.parse(remindParams.get('source')).fragment, `section-${sectionIds[1]}`);

    // Drawings: the pen and the mouse draw, the eraser cuts, the stroke eraser
    // removes, undo brings both back, and the highlighter shows what's under it.
    await page.js(`document.querySelector('.tiptap').editor.commands.focus('end')`);
    await tool(page, 'Add drawing');
    await until(page.js, `document.querySelector('.note-ink canvas')?.dataset.strokes === '0'`);
    const inkStrokes = `document.querySelector('.note-ink canvas').dataset.strokes`;
    const inkBox = async () => {
        await page.js(`document.querySelector('.note-ink').scrollIntoView({ block: 'center' })`);
        await sleep(100);
        return page.js(
            `(() => { const r = document.querySelector('.note-ink canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`,
        );
    };
    let [ix, iy, iw, ih] = await inkBox();
    assert.ok(iw > 100 && ih > 50, `drawing is laid out: ${iw}x${ih}`);
    const across = (y) => [0.1, 0.2, 0.3, 0.4, 0.5].map((f) => [ix + iw * f, iy + y]);
    await page.stroke(across(40), 'pen', 0.8);
    await until(page.js, `${inkStrokes} === '1'`);
    await sleep(500); // Past undo's grouping window.
    await page.stroke(across(90), 'mouse');
    await until(page.js, `${inkStrokes} === '2'`);
    assert.ok(
        await page.js(`(() => {
            const c = document.querySelector('.note-ink canvas');
            const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < data.length; i += 4) if (data[i]) return true;
            return false;
        })()`),
        'strokes are painted',
    );
    const inkTool = (label) =>
        page.js(
            `[...document.querySelectorAll('.ink-tools button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`,
        );
    const eraseDown = async () => {
        [ix, iy, iw, ih] = await inkBox();
        await page.stroke([
            [ix + iw * 0.25, iy + 20],
            [ix + iw * 0.25, iy + 60],
        ]);
    };
    await sleep(500);
    await inkTool('Eraser');
    await eraseDown();
    await until(page.js, `${inkStrokes} === '3'`); // The first stroke, cut in two.
    await sleep(500);
    await tool(page, 'Undo');
    await until(page.js, `${inkStrokes} === '2'`);
    await inkTool('Stroke eraser');
    await eraseDown();
    await until(page.js, `${inkStrokes} === '1'`);
    await sleep(500);
    await tool(page, 'Undo');
    await until(page.js, `${inkStrokes} === '2'`);
    await inkTool('Highlighter');
    [ix, iy, iw, ih] = await inkBox();
    await page.stroke(across(140));
    await until(page.js, `${inkStrokes} === '3'`);
    const highlightAlpha = await page.js(`(() => {
        const c = document.querySelector('.note-ink canvas');
        const ratio = c.width / c.getBoundingClientRect().width;
        return c.getContext('2d').getImageData(Math.round(${iw * 0.3} * ratio), Math.round(140 * ratio), 1, 1).data[3];
    })()`);
    assert.ok(highlightAlpha > 40 && highlightAlpha < 150, `the highlighter is see-through: alpha ${highlightAlpha}`);

    // The lasso takes one stroke, which moves, comes back with undo, and is deleted and restored.
    const inked = (x, y) =>
        page.js(`(() => {
            const c = document.querySelector('.note-ink canvas');
            const ratio = c.width / c.getBoundingClientRect().width;
            return c.getContext('2d').getImageData(Math.round(${x} * ratio), Math.round(${y} * ratio), 1, 1).data[3] > 0;
        })()`);
    const selected = `document.querySelector('.note-ink canvas').dataset.selected`;
    await inkTool('Lasso');
    [ix, iy, iw, ih] = await inkBox();
    await page.stroke([
        [ix + iw * 0.05, iy + 70],
        [ix + iw * 0.55, iy + 70],
        [ix + iw * 0.55, iy + 110],
        [ix + iw * 0.05, iy + 110],
        [ix + iw * 0.05, iy + 72],
    ]);
    await until(page.js, `${selected} === '1'`);
    assert.ok(await inked(iw * 0.3, 90), 'the lassoed stroke is where it was drawn');
    await sleep(500);
    await page.drag([ix + iw * 0.3, iy + 90], [ix + iw * 0.3, iy + 250]);
    await sleep(100);
    assert.ok(!(await inked(iw * 0.3, 90)) && (await inked(iw * 0.3, 250)), 'dragging the selection moves it');
    assert.equal(await page.js(inkStrokes), '3', 'a move adds and removes nothing');
    await sleep(500);
    await tool(page, 'Undo');
    await sleep(100);
    assert.ok((await inked(iw * 0.3, 90)) && !(await inked(iw * 0.3, 250)), 'undo puts it back');
    await inkTool('Delete selection');
    await until(page.js, `${inkStrokes} === '2'`);
    await sleep(500);
    await tool(page, 'Undo');
    await until(page.js, `${inkStrokes} === '3'`);

    // Paper is shared with the note's other devices.
    await page.js(`(() => {
        const paper = document.querySelector('.ink-tools select[aria-label="Paper"]');
        paper.value = 'lines';
        paper.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(page.js, `document.querySelector('.ink-frame').classList.contains('paper-lines')`);

    // A wobbly stroke started near the ruler's edge draws straight along it; the mouse moves the ruler.
    await inkTool('Pen');
    await inkTool('Ruler');
    await until(page.js, `document.querySelector('.ink-ruler')?.dataset.angle === '0'`);
    [ix, iy, iw, ih] = await inkBox();
    const rulerTop = () => page.js(`document.querySelector('.ink-ruler').getBoundingClientRect().top`);
    const top = await rulerTop();
    await page.stroke([0.6, 0.65, 0.7, 0.75, 0.8, 0.85].map((f, i) => [ix + iw * f, top - (i % 2 ? 22 : 6)]));
    await until(page.js, `${inkStrokes} === '4'`);
    const rows = await page.js(`(() => {
        const c = document.querySelector('.note-ink canvas');
        const ratio = c.width / c.getBoundingClientRect().width;
        // The rows with any ink, across the stroke's span, which is clear of the earlier strokes.
        const x = Math.round(${iw * 0.62} * ratio);
        const w = Math.round(${iw * 0.21} * ratio);
        const from = Math.round(${top - iy - 40} * ratio);
        const h = Math.round(40 * ratio);
        const data = c.getContext('2d').getImageData(x, from, w, h).data;
        let n = 0;
        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
                if (data[(row * w + col) * 4 + 3]) {
                    n++;
                    break;
                }
            }
        }
        return n / ratio;
    })()`);
    assert.ok(rows > 0 && rows <= 6, `the stroke follows the ruler's edge: ${rows}px tall`);
    await page.drag([ix + iw * 0.5, top + 10], [ix + iw * 0.5, top + 60]);
    assert.ok(Math.abs((await rulerTop()) - top - 50) < 2, 'the mouse drags the ruler');
    await inkTool('Ruler');
    await until(page.js, `!document.querySelector('.ink-ruler')`);
    await until(page.js, subtitleIs('Saved'));
    stopServer();
    await until(page.js, `${subtitle}?.startsWith('Offline') || ${subtitle} === 'Connecting…'`);
    await setTitle(page, 'Groceries, edited offline');
    await until(page.js, subtitleIs('Offline · changes waiting to sync'));
    startServer();
    await until(page.js, subtitleIs('Saved'), 30_000);

    // A second device gets it from the server alone.
    const other = await device();
    await other.size(1280);
    await other.go(noteUrl);
    await until(other.js, `${noteTitle} === 'Groceries, edited offline'`);
    await until(other.js, `[...document.querySelectorAll('.checklist .text')].some((i) => i.value === 'Milk')`);
    await until(other.js, `${bodyHtml}.includes('<table') && ${bodyHtml}.includes('First line of the note')`);
    await until(other.js, `document.querySelectorAll('.note-checklist').length === 2`);
    await until(other.js, `document.querySelectorAll('.tiptap h2[data-section]').length === 2`);
    await until(other.js, `document.querySelector('.note-ink canvas')?.dataset.strokes === '4'`);
    await until(other.js, `document.querySelector('.ink-frame').classList.contains('paper-lines')`);
    assert.deepEqual(
        await other.js(`[...document.querySelectorAll('.tiptap h2')].map((h) => h.dataset.section)`),
        sectionIds,
        'section IDs sync',
    );
    assert.equal(
        await other.js(`document.querySelectorAll('.tiptap .section-hidden').length`),
        0,
        'collapsing is per device',
    );
    // A reminder's link opens the note at its section, expanded.
    await page.go(BASE); // A fresh load, not a jump within the page.
    await page.go(`${noteUrl}#section-${sectionIds[0]}`);
    await until(page.js, `!!document.querySelector('.tiptap h2[data-section]')`);
    await until(page.js, `document.querySelectorAll('.tiptap .section-hidden').length === 0`);
    await until(
        other.js,
        `document.querySelectorAll('.note-checklist')[1].querySelector('li[data-item] .text')?.value === 'Second B'`,
    );

    // A note the old code wrote opens with every item, once, on two devices.
    const seeded = await new Promise((resolve, reject) => {
        const seed = spawn(process.execPath, ['scripts/seed-demo.mjs', `ws://127.0.0.1:${API_PORT}/huginn/v1/sync`], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        seed.stdout.on('data', (chunk) => (out += chunk));
        seed.on('exit', (code) =>
            code === 0 ? resolve(out.trim().split('\n').pop()) : reject(Error('seeding failed')),
        );
    });
    for (const reader of [page, other]) {
        await reader.go(`${BASE}n/${seeded}`);
        await until(reader.js, `document.querySelectorAll('.note-checklist').length === 1`);
        await until(reader.js, `document.querySelectorAll('.checklist li[data-item]').length === 7`);
        assert.equal(await reader.js(noteTitle), 'Groceries');
    }
    await until(page.js, subtitleIs('Saved'));
    await until(other.js, subtitleIs('Saved'));
    assert.equal(
        await page.js(`document.querySelectorAll('.note-checklist').length`),
        1,
        'one checklist after both migrate',
    );
    await page.js(`document.querySelector('.tiptap').focus()`);
    await page.go(noteUrl);
    await until(page.js, `${noteTitle} === 'Groceries, edited offline'`);
    await focusBody(page);

    // The open note and its focus survive resizing.
    await page.js(`window.__title = document.querySelector('.headerbar-input'); window.__title.focus()`);
    for (const width of [390, 900, 1280, 390, 1280]) {
        await page.size(width);
        await sleep(150);
        assert.equal(
            await page.js(`document.activeElement === window.__title && window.__title.isConnected`),
            true,
            `focus at ${width}`,
        );
        assert.equal(await page.js(noteTitle), 'Groceries, edited offline');
    }

    // Narrow widths; 640 is 1280 at 200% zoom.
    for (const width of [320, 390, 640]) {
        await page.size(width);
        await sleep(150);
        assert.equal(await overflows(page), false, `note overflows at ${width}`);
    }

    // A long list keeps its place through a note and back on a narrow screen.
    await page.size(1280);
    for (let i = 0; i < 14; i++) await newNote(page);
    await page.size(390);
    await page.go(BASE);
    await until(page.js, `document.querySelectorAll('.note-row a').length === 16`);
    assert.equal(await overflows(page), false, 'list overflows at 390');
    await page.size(320);
    await sleep(150);
    assert.equal(await overflows(page), false, 'list overflows at 320');
    await page.size(390);
    await page.js(`document.querySelector('.library-scroll').scrollTop = 300`);
    await sleep(150);
    const listUrl = await page.js('location.href');
    await page.js(`document.querySelectorAll('.note-row a')[6].click()`);
    await until(page.js, `location.pathname.includes('/n/') && !!document.querySelector('.editor-back')`);
    await until(page.js, `getComputedStyle(document.querySelector('.notes-pane')).display === 'none'`);
    await page.js(`document.querySelector('.editor-back').click()`);
    await until(page.js, `location.href === ${JSON.stringify(listUrl)}`);
    await until(page.js, `document.querySelector('.library-scroll').scrollTop === 300`);

    // Back, Forward and a reload on a deep link.
    await page.js('history.back()');
    await until(page.js, `location.pathname.includes('/n/') && !!document.querySelector('.headerbar-input')`);
    await page.js('history.forward()');
    await until(page.js, `location.href === ${JSON.stringify(listUrl)}`);
    await page.go(noteUrl);
    await until(page.js, `${noteTitle} === 'Groceries, edited offline'`);

    // With the server down, a note still opens, editor and all, from the offline shell.
    await page.js(`navigator.serviceWorker.ready.then(() => true)`);
    await page.go(noteUrl);
    await until(page.js, `navigator.serviceWorker.controller !== null`);
    await until(page.js, `!!document.querySelector('.tiptap')`);
    await sleep(500);
    stopServer();
    await page.go(noteUrl);
    await until(page.js, `${noteTitle} === 'Groceries, edited offline'`);
    await until(page.js, `${bodyHtml}.includes('<table')`);
    await until(
        page.js,
        subtitleIs('Offline') + ` || ${subtitle} === 'Connecting…' || ${subtitle}?.startsWith('Offline')`,
    );
    startServer();
    await sleep(1000);

    // An old client says so, and stops trying.
    await new Promise((resolve) => oldClientProxy.listen(OLD_CLIENT_PORT, '127.0.0.1', resolve));
    const old = await device();
    await old.size(1280);
    await old.go(`http://127.0.0.1:${OLD_CLIENT_PORT}/huginn/`);
    await newNote(old);
    await until(old.js, subtitleIs('Update required · close and reopen Huginn'));
    const connections = oldClientConnections;
    await sleep(4000);
    assert.equal(oldClientConnections, connections, 'an outdated client must not keep reconnecting');

    assert.deepEqual([...pageErrors.values()].flat(), [], 'no uncaught errors');
    console.log(
        'PASS: rich text and undo, title rule, several checklists, sections and reminders, drawings with pen, mouse, highlighter, both erasers, lasso move/delete/undo, paper and ruler, format 1 note on two devices, save states through an outage, offline open, second device, resize keeps focus, 320/390/640 without overflow, list position, Back/Forward/deep link, outdated client',
    );
}

main().then(
    () => {
        cleanup();
        process.exit(0);
    },
    (err) => {
        console.error(err);
        cleanup();
        process.exit(1);
    },
);
