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
        /** A key pressed and released, such as Enter (13), Escape (27) or Backspace (8); `modifiers` 2 is Ctrl, 8 Shift. */
        key: async (key, keyCode, modifiers = 0) => {
            for (const type of ['rawKeyDown', 'keyUp']) {
                await call('Input.dispatchKeyEvent', {
                    type,
                    key,
                    code: key,
                    modifiers,
                    windowsVirtualKeyCode: keyCode,
                    nativeVirtualKeyCode: keyCode,
                });
            }
        },
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
const searchFor = (page, text) =>
    page.js(`(() => {
        const box = document.querySelector('.library-search input');
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
const marks = `[...document.querySelectorAll('.note-row .note-excerpt mark')].map((m) => m.textContent).join(' ')`;

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

    // The notes list shows the drawing as a thumbnail, one path per stroke.
    const thumbPaths = `document.querySelectorAll('.note-row.selected svg.sketch path').length`;
    await until(page.js, `${thumbPaths} === 4`);

    // Search finds text in the note's body, highlights it, and opens the note
    // at its section, expanding it; then collapses it again for the checks below.
    const hidden = (text) =>
        `[...document.querySelectorAll('.tiptap p')].find((p) => p.textContent === ${JSON.stringify(text)})?.classList.contains('section-hidden')`;
    await until(page.js, hidden('Under plans'));
    await searchFor(page, 'under pla');
    await until(page.js, `${marks} === 'Under plans'`);
    const hitHref = await page.js(`document.querySelector('.note-row a').getAttribute('href')`);
    assert.ok(hitHref.endsWith(`#section-${sectionIds[0]}`), `a hit opens its section: ${hitHref}`);
    await page.js(`document.querySelector('.note-row a').click()`);
    await until(page.js, `${hidden('Under plans')} === false`);
    await searchFor(page, 'under zebra');
    await until(page.js, `document.querySelector('.library-empty')?.textContent.includes('No matching notes')`);
    await searchFor(page, '');
    await page.js(`document.querySelector('.tiptap h2 .section-toggle').click()`);
    await until(page.js, hidden('Under plans'));

    // Find in note: Ctrl+F opens it and every match is counted; going to one in a collapsed
    // section opens it; checklist items are found, a checked one shown; Escape closes it with the
    // match selected, leaving nothing highlighted; the menu opens it too, with the selected text.
    const findField = `document.querySelector('.find-bar input')`;
    const findCount = `document.querySelector('.find-count')?.textContent`;
    const findFor = (text) =>
        page.js(`(() => {
            const field = ${findField};
            field.value = ${JSON.stringify(text)};
            field.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
    const currentLine = `document.querySelector('.tiptap .find-current')?.closest('p')?.textContent`;
    await focusBody(page);
    await page.key('f', 70, 2);
    await until(page.js, `document.activeElement === ${findField}`);
    await findFor('UNDER');
    await until(page.js, `${findCount} === '1 of 2' || ${findCount} === '2 of 2'`);
    assert.equal(await page.js(`document.querySelectorAll('.tiptap .find-match').length`), 2);
    for (let i = 0; i < 2 && (await page.js(currentLine)) !== 'Under plans'; i++) await page.key('Enter', 13);
    assert.equal(await page.js(currentLine), 'Under plans');
    await until(page.js, `${hidden('Under plans')} === false`);
    const before = await page.js(findCount);
    await page.key('Enter', 13, 8);
    await until(page.js, `${findCount} !== ${JSON.stringify(before)} && ${currentLine} === 'Under later'`);
    await findFor('under zebra');
    await until(page.js, `${findCount} === 'No matches'`);
    assert.equal(await page.js(`document.querySelector('.find-bar [aria-label="Next match"]').disabled`), true);
    // A checked item, with the checked items folded away, is still found and shown.
    const secondA = `[...document.querySelectorAll('.note-checklist')[1].querySelectorAll('li[data-item]')].find((li) => li.querySelector('.text').value === 'Second A')`;
    await page.js(`${secondA}.querySelector('input[type=checkbox]').click()`);
    await until(page.js, `${secondA}?.classList.contains('done')`);
    await page.js(`document.querySelectorAll('.note-checklist')[1].querySelector('.divider-btn').click()`);
    await until(page.js, `!${secondA}`);
    await findFor('second a');
    await until(page.js, `${findCount} === '1 of 1' && ${secondA}?.classList.contains('found-current')`);
    await findFor('Second');
    await until(page.js, `${findCount}?.endsWith(' of 2')`);
    assert.equal(await page.js(`document.querySelectorAll('.checklist li.found').length`), 2);
    await page.key('Escape', 27);
    await until(page.js, `!${findField}`);
    assert.equal(await page.js(`document.querySelectorAll('.find-match, .checklist li.found').length`), 0);
    assert.deepEqual(
        await page.js(`(() => {
            const field = document.activeElement;
            return [field.value.startsWith('Second'), field.selectionEnd - field.selectionStart];
        })()`),
        [true, 6],
        'Escape selects the current match',
    );
    await page.js(`${secondA}.querySelector('input[type=checkbox]').click()`);
    await until(page.js, `!${secondA}.classList.contains('done')`);
    await page.js(`(() => {
        const ed = document.querySelector('.tiptap').editor;
        let at = 0;
        ed.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Under later') at = pos; });
        ed.chain().focus().setTextSelection({ from: at, to: at + 7 }).run();
    })()`);
    await page.js(`document.querySelector('[aria-label="Note actions"]').click()`);
    await page.js(
        `[...document.querySelectorAll('.editor-pane .menu .btn')].find((b) => b.textContent === 'Find in note').click()`,
    );
    await until(page.js, `${findField}?.value === 'Under l' && ${findCount} === '1 of 1'`);
    await page.js(`document.querySelector('.find-bar [aria-label="Close find"]').click()`);
    await until(page.js, `!${findField} && document.querySelectorAll('.find-match').length === 0`);
    await until(page.js, `${hidden('Under plans')} === false`);
    await page.js(`document.querySelector('.tiptap h2 .section-toggle').click()`);
    await until(page.js, hidden('Under plans'));

    // Folders: the notes list is a tree of them. One from the drawer, one inside it from its menu,
    // a new note in that, notes moved in from the note menu and by selecting, folders collapsed and
    // expanded, a folder deleted with everything in it and restored. Opening a note never leaves the tree.
    const press = (selector, text) =>
        page.js(`(() => {
            const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
            const found = all.find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}));
            if (!found) throw Error('no ' + ${JSON.stringify(text)} + ' in ' + all.map((b) => b.textContent.trim()).join(', '));
            found.click();
        })()`);
    const nameFolder = (scope, name) =>
        page.js(`(() => {
            const form = document.querySelector('${scope} .folder-form');
            const input = form.querySelector('input');
            input.value = ${JSON.stringify(name)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return new Promise((done) => setTimeout(() => done(form.requestSubmit()), 50));
        })()`);
    const rowTitles = `[...document.querySelectorAll('.note-rows .note-row strong')].map((r) => r.textContent)`;
    const selectedTitle = `document.querySelector('.note-row.selected strong')?.textContent`;
    const folderNodes = `[...document.querySelectorAll('.folder-node .folder-name')].map((f) => f.textContent).join()`;
    const depths = `[...document.querySelectorAll('.note-rows .note-row')].map((r) => r.dataset.depth).join()`;
    const mainMenu = () => page.js(`document.querySelector('[aria-label="Main menu"]').click()`);
    const folderMenu = (name) => page.js(`document.querySelector('[aria-label="Actions for ${name}"]').click()`);
    const notePath = new URL(noteUrl).pathname;
    await mainMenu();
    await press('.primary-menu .btn', 'New folder');
    await nameFolder('.primary-menu', 'Work');
    await until(page.js, `${folderNodes} === 'Work'`);
    assert.equal(await page.js('location.pathname + location.search'), notePath, 'the open note stays open');
    await folderMenu('Work');
    await press('.folder-menu[open] .btn', 'New folder inside');
    await nameFolder('.folder-menu[open]', 'Turbines');
    await until(page.js, `${folderNodes} === 'Work,Turbines'`);
    await folderMenu('Turbines');
    await press('.folder-menu[open] .btn', 'New note here');
    await until(
        page.js,
        `location.pathname !== ${JSON.stringify(notePath)} && !!document.querySelector('.headerbar-input')`,
    );
    await until(page.js, `document.querySelector('.note-row.selected')?.dataset.depth === '2'`); // In Work › Turbines.
    assert.deepEqual(await page.js(`${rowTitles}.sort()`), ['Groceries', 'New note'], 'the whole tree stays in view');
    // Clicking a note opens it, highlighted where it is; the list doesn't change.
    await page.js(
        `[...document.querySelectorAll('.note-rows .note-row a')].find((a) => a.querySelector('strong').textContent === 'Groceries').click()`,
    );
    await until(page.js, `location.pathname === ${JSON.stringify(notePath)} && ${selectedTitle} === 'Groceries'`);
    assert.equal(await page.js('location.search'), '');
    assert.equal(await page.js(folderNodes), 'Work,Turbines');
    // The open note moves in from its menu.
    await page.js(`document.querySelector('[aria-label="Note actions"]').click()`);
    await press('.editor-pane .menu .btn', 'Move to folder');
    await press('.editor-pane .folder-picker .btn', 'Turbines');
    await until(page.js, `${depths} === '2,2'`); // Both in Work › Turbines.
    // Selecting both and moving them to Work.
    await press('.library-search .btn', 'Select');
    await page.js(`document.querySelectorAll('.note-select input').forEach((box) => box.click())`);
    await until(page.js, `document.querySelector('.selection-bar span')?.textContent === '2 selected'`);
    await press('.selection-bar .btn', 'Move');
    await press('.selection-bar .folder-picker .btn', 'Work');
    await until(page.js, `!document.querySelector('.selection-bar')`);
    await until(page.js, `${depths} === '1,1'`); // Both in Work, under Turbines.
    // Collapsing Work hides what's in it, on this device, until it's expanded.
    await page.js(`document.querySelector('.folder-label[title="Collapse Work"]').click()`);
    await until(page.js, `${rowTitles}.length === 0 && ${folderNodes} === 'Work'`);
    await page.go(BASE);
    await until(page.js, `${folderNodes} === 'Work' && ${rowTitles}.length === 0`); // Remembered.
    // Opening a note inside a collapsed folder expands it, so the note is in view.
    await page.go(noteUrl);
    await until(page.js, `document.querySelector('.note-row.selected')?.dataset.depth === '1'`);
    assert.equal(await page.js(folderNodes), 'Work,Turbines');
    // Deleting Work takes Turbines and both notes to Recently Deleted; restoring brings them back.
    await folderMenu('Work');
    await press('.folder-menu[open] .btn', 'Delete folder');
    await until(
        page.js,
        `document.querySelector('.folder-menu[open] p')?.textContent.replace(/\\s+/g, ' ').includes('1 folder in it and 2 notes')`,
    );
    await press('.folder-menu[open] .btn.danger', 'Delete folder');
    await until(page.js, `${rowTitles}.length === 0 && ${folderNodes} === '' && !location.pathname.includes('/n/')`);
    await mainMenu();
    await press('.primary-menu .btn', 'Recently Deleted');
    await until(page.js, `document.querySelector('.folder-row strong')?.textContent === 'Work'`);
    assert.equal(await page.js(`${rowTitles}.length`), 2, 'its notes wait with it');
    await press('.folder-row .btn', 'Restore');
    await until(page.js, `!document.querySelector('.folder-row') && ${rowTitles}.length === 0`);
    await mainMenu();
    await press('.primary-menu .btn', 'All Notes');
    await until(page.js, `${rowTitles}.length === 2 && ${folderNodes} === 'Work,Turbines'`);
    // Put Groceries back at the top level and delete the extra note, for the checks below.
    await press('.library-search .btn', 'Select');
    await page.js(`(() => {
        const rows = [...document.querySelectorAll('.note-select')];
        rows.find((r) => r.querySelector('strong').textContent !== 'New note').querySelector('input').click();
    })()`);
    await press('.selection-bar .btn', 'Move');
    await press('.selection-bar .folder-picker .btn', 'No folder');
    await until(page.js, `!document.querySelector('.selection-bar')`);
    await press('.library-search .btn', 'Select');
    await page.js(`(() => {
        const rows = [...document.querySelectorAll('.note-select')];
        rows.find((r) => r.querySelector('strong').textContent === 'New note').querySelector('input').click();
    })()`);
    await press('.selection-bar .btn', 'Delete');
    await until(page.js, `${rowTitles}.length === 1`);
    await page.go(noteUrl);
    await until(page.js, `!!document.querySelector('.tiptap')`);

    // Links between notes: `[[` suggests notes and `[[#` this note's sections; a link follows its
    // note's title unless labelled, opens it, and shows in its backlinks; Copy link puts a section
    // link on the clipboard that pastes as one; links to deleted and missing notes say so.
    const linkTexts = `[...document.querySelectorAll('.tiptap .note-link')].map((a) => a.textContent + ':' + a.dataset.state).join()`;
    const linkSuggestions = `[...document.querySelectorAll('.tag-suggest[aria-label="Notes to link to"] button .folder-name')].map((b) => b.textContent).join()`;
    // Tiptap focuses on the next frame, so wait for it before typing.
    const atEnd = async () => {
        await page.js(`document.querySelector('.tiptap').editor.chain().focus('end').run()`);
        await until(page.js, `document.activeElement === document.querySelector('.tiptap')`);
    };
    const paste = (type, data) =>
        page.js(`(() => {
            const data = new DataTransfer();
            data.setData(${JSON.stringify(type)}, ${JSON.stringify(data)});
            document.querySelector('.tiptap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        })()`);
    await newNote(page);
    const tripId = (await page.js('location.pathname')).split('/').pop();
    await focusBody(page);
    await page.js(
        `document.querySelector('.tiptap').editor.chain().focus().insertContent('<p>Trip plans</p><h2>Budget</h2><p>Spend less</p>').run()`,
    );
    await until(page.js, `${rowTitle} === 'Trip plans'`);
    await until(page.js, subtitleIs('Saved'));
    await page.go(noteUrl);
    await until(page.js, `!!document.querySelector('.tiptap h2[data-section]')`);
    await atEnd();
    await page.type('See [[trip');
    await until(page.js, `${linkSuggestions} === 'Trip plans'`);
    await page.key('Enter', 13);
    await until(page.js, `${linkTexts} === 'Trip plans:live'`);
    await page.type(' and [[#pla');
    await until(page.js, `${linkSuggestions} === 'Plans'`);
    await page.key('Enter', 13);
    await until(page.js, `${linkTexts} === 'Trip plans:live,Plans:live'`);
    // A section of this note opens in place, expanded.
    await until(page.js, hidden('Under plans'));
    await page.js(`document.querySelectorAll('.tiptap .note-link')[1].click()`);
    await until(page.js, `${hidden('Under plans')} === false`);
    assert.equal(await page.js('location.href'), noteUrl, 'a link within the note stays on it');
    await page.js(`document.querySelector('.tiptap h2 .section-toggle').click()`);
    await until(page.js, hidden('Under plans'));
    // A label, set with the caret just after the link, and cleared again.
    const setLabel = async (label) => {
        await page.js(`(() => {
            const ed = document.querySelector('.tiptap').editor;
            let at = 0;
            ed.state.doc.descendants((node, pos) => { if (node.type.name === 'noteLink' && node.attrs.note === ${JSON.stringify(tripId)}) at = pos + 1; });
            ed.chain().focus().setTextSelection(at).run();
        })()`);
        await tool(page, 'Link');
        await until(page.js, `document.querySelector('.link-field input')?.placeholder === 'Trip plans'`);
        await page.js(`(() => {
            const field = document.querySelector('.link-field input');
            field.value = ${JSON.stringify(label)};
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.form.requestSubmit();
        })()`);
    };
    await setLabel('the trip');
    await until(page.js, `${linkTexts} === 'the trip:live,Plans:live'`);
    await setLabel('');
    await until(page.js, `${linkTexts} === 'Trip plans:live,Plans:live'`);
    await until(page.js, subtitleIs('Saved'));
    // Following it, the note it points at lists this one; renamed, the link follows.
    await page.js(`document.querySelector('.tiptap .note-link').click()`);
    await until(page.js, `location.pathname.endsWith(${JSON.stringify('/' + tripId)})`);
    await until(
        page.js,
        `[...document.querySelectorAll('.backlinks a')].map((a) => a.textContent).join() === 'Groceries'`,
    );
    await setTitle(page, 'Spring trip');
    await until(page.js, subtitleIs('Saved'));
    // Copy link, with the caret under Budget.
    await page.js(`(() => {
        window.__copied = null;
        navigator.clipboard.write = async (items) => {
            window.__copied = Object.fromEntries(await Promise.all(items[0].types.map(async (t) => [t, await (await items[0].getType(t)).text()])));
        };
        const ed = document.querySelector('.tiptap').editor;
        let at = 0;
        ed.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Spend less') at = pos + 2; });
        ed.chain().focus().setTextSelection(at).run();
    })()`);
    await tool(page, 'Copy link');
    const copied = await until(page.js, 'window.__copied');
    const budgetSection = await page.js(`document.querySelector('.tiptap h2').dataset.section`);
    assert.ok(copied['text/plain'].endsWith(`/huginn/n/${tripId}#section-${budgetSection}`), copied['text/plain']);
    assert.ok(copied['text/html'].includes('data-heading="Budget"'), copied['text/html']);
    await page.js(`document.querySelector('.backlinks a').click()`);
    await until(
        page.js,
        `location.pathname === new URL(${JSON.stringify(noteUrl)}).pathname && ${linkTexts} === 'Spring trip:live,Plans:live'`,
    );
    await atEnd();
    await paste('text/html', copied['text/html']);
    await until(page.js, `${linkTexts} === 'Spring trip:live,Plans:live,Spring trip › Budget:live'`);
    await atEnd();
    await paste('text/plain', new URL(`n/nosuchnote0000000001`, BASE).href);
    await until(page.js, `${linkTexts}.endsWith(',Missing note:missing')`);
    await until(page.js, subtitleIs('Saved'));
    // A section link opens the other note at that section.
    await page.js(`document.querySelectorAll('.tiptap .note-link')[2].click()`);
    await until(page.js, `location.hash === ${JSON.stringify('#section-' + budgetSection)}`);
    // Deleted, the note's links say so; it stays deleted for the checks below.
    await page.js(`document.querySelector('[aria-label="Note actions"]').click()`);
    await page.js(
        `[...document.querySelectorAll('.editor-pane .menu .btn')].find((b) => b.textContent.startsWith('Delete note')).click()`,
    );
    await page.js(
        `[...document.querySelectorAll('.editor-pane .menu .btn')].find((b) => b.textContent === 'Move to Recently Deleted').click()`,
    );
    await until(page.js, `!location.pathname.includes(${JSON.stringify(tripId)})`);
    await page.go(noteUrl);
    await until(
        page.js,
        `${linkTexts} === 'Spring trip:deleted,Plans:live,Spring trip › Budget:deleted,Missing note:missing'`,
    );

    // Tags: written in the text, shown as tags, listed in the drawer, filtering the list from a
    // click, the other way round too, and renamed and deleted in the notes written with them.
    await page.js(
        `document.querySelector('.tiptap').editor.chain().focus('end').insertContent('<p>Shopping #errands for #Home</p>').run()`,
    );
    await until(
        page.js,
        `[...document.querySelectorAll('.tiptap .hashtag')].map((t) => t.dataset.tag).join() === 'errands,Home'`,
    );
    const drawerTags = `[...document.querySelectorAll('.tag-list .btn')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).join()`;
    await until(page.js, `${drawerTags} === '#errands 1,#Home 1'`, 20_000);
    // A real click: ProseMirror handles clicks from the mouse going down and up.
    const tagAt = await page.js(`(() => {
        const tag = document.querySelector('.tiptap .hashtag[data-tag="errands"]');
        tag.scrollIntoView({ block: 'center' });
        const r = tag.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
    })()`);
    await page.stroke([tagAt]);
    const chips = `[...document.querySelectorAll('.tag-chip summary')].map((c) => c.textContent).join()`;
    await until(page.js, `${chips} === '#errands' && ${rowTitles}.join() === 'Groceries'`);
    await page.js(`document.querySelector('.tag-chip summary').click()`);
    await press('.tag-chip[open] .btn', 'Show notes without it');
    await until(
        page.js,
        `${chips} === 'not #errands' && document.querySelector('.library-empty')?.textContent.includes('No notes with these tags')`,
    );
    await page.js(`document.querySelector('.tag-chip summary').click()`);
    await press('.tag-chip[open] .btn', 'Show notes with it');
    await page.js(`document.querySelector('.tag-chip summary').click()`);
    await press('.tag-chip[open] .btn', 'Rename tag');
    await nameFolder('.tag-chip[open]', 'Chores');
    await until(page.js, `document.querySelector('.tiptap').textContent.includes('Shopping #Chores for #Home')`);
    await until(page.js, `${chips} === '#Chores' && ${rowTitles}.join() === 'Groceries'`, 20_000);
    await mainMenu();
    await press('.tag-list .btn', '#Home');
    await until(page.js, `${chips} === '#Chores,#Home'`);
    await page.js(`document.querySelectorAll('.tag-chip summary')[1].click()`);
    await press('.tag-chip[open] .btn', 'Delete tag');
    await press('.tag-chip[open] .btn.danger', 'Delete tag');
    await until(page.js, `document.querySelector('.tiptap').textContent.includes('Shopping #Chores for Home')`);
    await press('.tag-filter .btn', 'Clear');
    // Typing a tag suggests the tags already used, narrowing as it goes; Enter picks one, Escape
    // puts the suggestions away, and they don't show for a tag nobody has used.
    const suggested = `[...document.querySelectorAll('.tag-suggest [role=option]')].map((o) => o.textContent.replace(/\\s+/g, ' ').trim()).join()`;
    // The caret at the end of the line, put there as a person would: the list's buttons had the selection.
    const lineEnd = await page.js(`(() => {
        const line = [...document.querySelectorAll('.tiptap p')].find((p) => p.textContent.startsWith('Shopping'));
        line.scrollIntoView({ block: 'center' });
        const r = line.getBoundingClientRect();
        return [r.right - 4, r.y + r.height / 2];
    })()`);
    await page.stroke([lineEnd]);
    await page.type(' #ch');
    await until(page.js, `${suggested} === '#Chores 1'`);
    await page.key('Enter', 13);
    await until(
        page.js,
        `document.querySelector('.tiptap').textContent.endsWith('for Home #Chores ') && !document.querySelector('.tag-suggest')`,
    );
    await page.type('#');
    await until(page.js, `${suggested} === '#Chores 1'`);
    await page.key('Escape', 27);
    await until(page.js, `!document.querySelector('.tag-suggest')`);
    await page.type('zq');
    await sleep(200);
    assert.equal(await page.js(`!!document.querySelector('.tag-suggest')`), false, 'nothing to suggest');
    for (let i = 0; i < 3; i++) await page.key('Backspace', 8);
    await until(page.js, `document.querySelector('.tiptap').textContent.endsWith('for Home #Chores ')`);
    await until(page.js, `!document.querySelector('.tag-filter') && ${drawerTags} === '#Chores 1'`, 20_000);

    // Smart Folders: made from the main menu with a tag and an open checklist, at the top of the
    // tree and collapsed, its notes under it when expanded as well as in their own place; changed
    // until nothing matches; one saved from the tag filter; both deleted, their notes staying put.
    const smartNodes = `[...document.querySelectorAll('.smart-node')].map((n) => n.querySelector('.folder-name').textContent + ' ' + n.querySelector('.folder-label .small').textContent).join()`;
    const inDialog = (js) => page.js(`(() => { const d = document.querySelector('.smart-editor[open]'); ${js} })()`);
    const choose = (selector, value) =>
        inDialog(
            `const s = d.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true }));`,
        );
    const nameIt = (name) =>
        inDialog(
            `const i = d.querySelector('.smart-field input'); i.value = ${JSON.stringify(name)}; i.dispatchEvent(new Event('input', { bubbles: true }));`,
        );
    const saveIt = () =>
        inDialog(`return new Promise((done) => setTimeout(() => done(d.querySelector('form').requestSubmit()), 50));`);
    await mainMenu();
    await press('.primary-menu .btn', 'New Smart Folder');
    await until(page.js, `document.querySelector('.smart-editor[open] select[aria-label="Tag"]')?.value === 'chores'`);
    await nameIt('Chores to do');
    await press('.smart-editor[open] .btn', 'Add condition');
    await choose('.smart-conditions li:nth-child(2) select[aria-label="Condition"]', 'checklist');
    await until(
        page.js,
        `document.querySelector('.smart-editor[open] select[aria-label="Checklist state"]')?.value === 'open'`,
    );
    await saveIt();
    await until(page.js, `!document.querySelector('.smart-editor[open]') && ${smartNodes} === 'Chores to do 1'`);
    assert.equal(await page.js(`${rowTitles}.join()`), 'Groceries', 'collapsed to begin with');
    await page.js(`document.querySelector('.smart-node .folder-label').click()`);
    await until(page.js, `${rowTitles}.join() === 'Groceries,Groceries' && ${depths} === '1,0'`);
    await page.js(`document.querySelector('[aria-label="Actions for Chores to do"]').click()`);
    await press('.folder-menu[open] .btn', 'Edit Smart Folder');
    await until(page.js, `document.querySelector('.smart-editor[open] .smart-field input')?.value === 'Chores to do'`);
    await choose('select[aria-label="Checklist state"]', 'done');
    await saveIt();
    await until(page.js, `${smartNodes} === 'Chores to do 0' && ${rowTitles}.join() === 'Groceries'`);
    await mainMenu();
    await press('.tag-list .btn', '#Chores');
    await press('.tag-filter .btn', 'Save as Smart Folder');
    await until(page.js, `document.querySelector('.smart-editor[open] select[aria-label="Tag"]')?.value === 'chores'`);
    await nameIt('Chores');
    await saveIt();
    await press('.tag-filter .btn', 'Clear');
    await until(page.js, `${smartNodes} === 'Chores 1,Chores to do 0'`);
    for (const name of ['Chores', 'Chores to do']) {
        await page.js(`document.querySelector('[aria-label="Actions for ${name}"]').click()`);
        await press('.folder-menu[open] .btn', 'Delete Smart Folder');
        await press('.folder-menu[open] .btn.danger', 'Delete Smart Folder');
    }
    await until(page.js, `${smartNodes} === '' && ${rowTitles}.join() === 'Groceries'`);

    await until(page.js, subtitleIs('Saved'));
    stopServer();
    await until(page.js, `${subtitle}?.startsWith('Offline') || ${subtitle} === 'Connecting…'`);
    // Offline, search says it's matching titles only.
    await searchFor(page, 'groceries');
    await until(page.js, `document.querySelector('.library-hint[role=status]')?.textContent.includes('titles only')`);
    assert.equal(await page.js(`document.querySelectorAll('.note-row').length`), 1, 'titles still match');
    await searchFor(page, '');
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
    await until(other.js, `document.querySelectorAll('.note-row.selected svg.sketch path').length === 4`);
    await until(other.js, `document.querySelectorAll('.folder-node').length === 2`); // Folders sync.
    await until(other.js, `document.querySelector('.tiptap .hashtag')?.dataset.tag === 'Chores'`); // And renamed tags.
    await until(other.js, `document.querySelectorAll('.tiptap .note-link').length === 4`); // And links.
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
    // Search covers notes this device has never opened: the seventh item is in no preview.
    await searchFor(other, 'towels');
    await until(other.js, `${marks} === 'towels'`);
    assert.ok(
        (await other.js(`document.querySelector('.note-row a').getAttribute('href')`)).includes(seeded),
        'the note found is the one never opened here',
    );
    await searchFor(other, '');
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
    // Find in note fits at the narrowest.
    await page.size(320);
    await page.js(`dispatchEvent(new CustomEvent('huginn:find'))`);
    await until(page.js, `!!document.querySelector('.find-bar input')`);
    await page.js(`(() => {
        const field = document.querySelector('.find-bar input');
        field.value = 'First';
        field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until(page.js, `document.querySelector('.find-count')?.textContent === '1 of 1'`);
    assert.equal(await overflows(page), false, 'find in note overflows at 320');
    await page.js(`document.querySelector('.find-bar [aria-label="Close find"]').click()`);

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
        'PASS: rich text and undo, title rule, several checklists, sections and reminders, drawings with pen, mouse, highlighter, both erasers, lasso move/delete/undo, paper and ruler, list thumbnails, full-text search (sections, offline, unopened notes), folders (the list as a collapsible tree, nesting, new notes in them, moving one or several, delete and restore), tags (highlighted, listed, suggested while typed, filtering both ways, rename, delete), Smart Folders (made, in the tree, changed, saved from a filter, deleted), find in note (Ctrl+F, counting, stepping into a collapsed section, checked items, Escape, the menu, 320), note links (typed with suggestions, sections, labels, following titles, backlinks, copy and paste, deleted and missing), format 1 note on two devices, save states through an outage, offline open, second device, resize keeps focus, 320/390/640 without overflow, list position, Back/Forward/deep link, outdated client',
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
