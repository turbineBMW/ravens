// Attachments end to end, in headless Chromium against a throwaway server:
// pasting images (with and without thumbnails) and a PDF, uploading, the
// server's listing and range requests, the notes list's picture, the viewer,
// alt text and search, adding a file offline and reconnecting, a second
// device, deleting; and the upload protocol itself (resuming, conflicts,
// damaged bytes, limits, headers).
//
//   npm run build -w huginn/web && cargo build -p huginn-server
//   node scripts/huginn-attachments-test.mjs
//
// Needs Node 22+ and `chromium` on the PATH. Touches no real data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API_PORT = 18191;
const OLD_CLIENT_PORT = 18192;
const DEBUG_PORT = 19391;
const BASE = `http://127.0.0.1:${API_PORT}/huginn/`;
const work = mkdtempSync(join(tmpdir(), 'huginn-attachments-'));
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

const API = `http://127.0.0.1:${API_PORT}/huginn/v1`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** The note's attachments as the editor has them. */
const attachments = `JSON.stringify((() => {
    const out = [];
    document.querySelector('.tiptap').editor.state.doc.descendants((n) => { if (n.type.name === 'attachment') out.push(n.attrs); });
    return out;
})())`;
const statuses = `[...document.querySelectorAll('.note-attachment .attachment-status')].map((s) => s.textContent.trim())`;
/** A one-page PDF, its offsets worked out so any reader takes it. */
function tinyPdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        null,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const text = 'BT /F1 24 Tf 40 100 Td (Turbine manual) Tj ET';
    objects[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
    let out = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((o, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
}

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

    // ---------- the upload protocol, as any client would use it ----------
    await until(async () => (await fetch(`${API}/health`).catch(() => null))?.ok, 'true');
    const post = (id, body) =>
        fetch(`${API}/blobs/${id}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    const patch = (id, offset, bytes) =>
        fetch(`${API}/blobs/${id}`, { method: 'PATCH', headers: { 'upload-offset': String(offset) }, body: bytes });
    const ten = Buffer.from('0123456789');
    let res = await post('proto1', { size: 10, sha256: sha(ten), type: 'text/plain' });
    assert.deepEqual(await res.json(), { size: 10, received: 0, complete: false });
    assert.equal((await (await patch('proto1', 0, ten.subarray(0, 4))).json()).received, 4);
    assert.equal(
        (await (await post('proto1', { size: 10, sha256: sha(ten), type: 'text/plain' })).json()).received,
        4,
        'declaring again resumes',
    );
    res = await patch('proto1', 0, ten.subarray(0, 4));
    assert.equal(res.status, 409, 'an offset out of step is refused');
    assert.equal((await res.json()).received, 4, 'and says where it is');
    assert.equal((await (await patch('proto1', 4, ten.subarray(4))).json()).complete, true);
    assert.equal(
        (await post('proto1', { size: 10, sha256: sha(Buffer.from('x')), type: 'text/plain' })).status,
        409,
        'another file under the same id',
    );
    res = await fetch(`${API}/blobs/proto1`);
    assert.equal(await res.text(), '0123456789');
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    res = await fetch(`${API}/blobs/proto1`, { headers: { range: 'bytes=2-5' } });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), '2345');
    res = await fetch(`${API}/blobs/proto1?download=${encodeURIComponent('Café notes.txt')}`);
    assert.match(res.headers.get('content-disposition'), /^attachment; .*filename\*=UTF-8''Caf%C3%A9%20notes\.txt/);
    assert.equal(
        (await fetch(`${API}/blobs/proto1`, { method: 'DELETE' })).status,
        409,
        'a stored file goes when no note uses it',
    );
    await post('proto2', { size: 3, sha256: sha(Buffer.from('abc')), type: 'text/plain' });
    assert.equal((await patch('proto2', 0, Buffer.from('abd'))).status, 422, 'damaged bytes are refused');
    assert.equal(
        (await (await post('proto2', { size: 3, sha256: sha(Buffer.from('abc')) })).json()).received,
        0,
        'and start again',
    );
    assert.equal((await fetch(`${API}/blobs/proto2`)).status, 404, 'an unfinished file is not served');
    assert.equal((await fetch(`${API}/blobs/proto2`, { method: 'DELETE' })).status, 204, 'an upload can be given up');
    assert.equal((await post('huge', { size: 300 * 1024 * 1024, sha256: sha(ten) })).status, 413);
    assert.equal((await post('a.b', { size: 1, sha256: sha(ten) })).status, 400, 'ids are letters, digits, - and _');
    const usage = await (await fetch(`${API}/blobs`)).json();
    assert.equal(usage.used, 10);
    assert.equal(usage.max_file, 200 * 1024 * 1024);

    // ---------- pasting images ----------
    const page = await device();
    await page.size(1280);
    await page.go(BASE);
    await newNote(page);
    await focusBody(page);
    await page.type('Inspection photos');
    await until(page.js, subtitleIs('Saved'));
    const noteUrl = await page.js('location.href');
    const helpers = `(() => {
        window.__png = (w, h, color, name) => new Promise((done) => {
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const x = c.getContext('2d');
            x.fillStyle = color; x.fillRect(0, 0, w, h);
            // Noise, so the image is too large to be its own thumbnail.
            for (let i = 0; i < 4000; i++) { x.fillStyle = 'hsl(' + (i * 37 % 360) + ',80%,50%)'; x.fillRect((i * 7919) % w, (i * 104729) % h, 9, 9); }
            c.toBlob((b) => done(new File([b], name, { type: 'image/png' })), 'image/png');
        });
        window.__paste = (files) => {
            const dt = new DataTransfer();
            for (const f of files) dt.items.add(f);
            document.querySelector('.tiptap').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        };
    })()`;
    await page.js(helpers);
    await page.js(
        `(async () => __paste([await __png(1600, 1200, 'teal', 'big.png'), await __png(200, 100, 'navy', 'small.png')]))()`,
    );
    await until(
        page.js,
        `document.querySelectorAll('.note-attachment').length === 2 && [...document.querySelectorAll('.note-attachment img')].filter((i) => i.complete && i.naturalWidth > 0).length === 2`,
    );
    let [big, small] = JSON.parse(await page.js(attachments));
    assert.equal(big.kind, 'image');
    assert.equal(big.name, 'big.png');
    assert.equal(big.width, 1600);
    assert.ok(big.thumb, 'a large image gets a thumbnail');
    assert.equal(small.thumb, '', 'a small one shows itself');
    assert.equal(
        await page.js(`document.querySelector('.note-attachment img').naturalWidth`),
        960,
        'the column shows the thumbnail',
    );
    await until(page.js, `${statuses}.every((s) => s === '')`, 30_000);
    // On the server: the image, its thumbnail, listed with the note.
    res = await fetch(`${API}/blobs/${big.blob}`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, big.size);
    assert.equal((await fetch(`${API}/blobs/${big.thumb}`)).status, 200);
    const noteId = new URL(noteUrl).pathname.split('/').pop();
    await until(async () => {
        const all = await (await fetch(`${API}/attachments`)).json();
        return all.filter((a) => a.note === noteId && a.stored).length === 2;
    }, 'true');
    // The notes list shows the first image.
    await until(page.js, `!!document.querySelector('.note-row.selected img.picture')?.naturalWidth`);
    assert.equal(await page.js(`document.querySelector('.note-row.selected img.picture').naturalWidth`), 960);

    // ---------- the viewer, alt text and search ----------
    await page.js(`document.querySelector('.attachment-picture').click()`);
    await until(page.js, `document.querySelector('.attachment-viewer[open] img')?.naturalWidth === 1600`);
    await page.key('Escape', 27);
    await until(page.js, `!document.querySelector('.attachment-viewer')`);
    await page.js(`document.querySelector('.note-attachment summary').click()`);
    await page.js(
        `[...document.querySelectorAll('.note-attachment .attachment-menu[open] .btn')].find((b) => b.textContent.startsWith('Alt text')).click()`,
    );
    await until(page.js, `!!document.querySelector('.alt-field input')`);
    await page.js(`(() => {
        const input = document.querySelector('.alt-field input');
        input.value = 'Blade root, teal';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.form.requestSubmit();
    })()`);
    await until(page.js, `JSON.parse(${attachments})[0].alt === 'Blade root, teal'`);
    assert.equal(await page.js(`document.querySelector('.note-attachment img').alt`), 'Blade root, teal');
    await until(async () => {
        const hits = await (await fetch(`${API}/search?q=blade`)).json();
        return hits.some((h) => h.note === noteId);
    }, 'true');

    // ---------- a PDF ----------
    await page.js(`__paste([new File([${JSON.stringify(tinyPdf())}], 'manual.pdf', { type: 'application/pdf' })])`);
    await until(
        page.js,
        `[...document.querySelectorAll('.attachment-pdf .card-detail')].some((d) => d.textContent.startsWith('1 page'))`,
        20_000,
    );
    assert.ok(
        await page.js(`!!document.querySelector('.attachment-pdf img.card-page')`),
        'its first page is its thumbnail',
    );
    await page.js(`document.querySelector('.attachment-pdf .attachment-card').click()`);
    await until(
        page.js,
        `(() => { const c = document.querySelector('.attachment-viewer[open] canvas.pdf-page'); return c && c.width > 0; })()`,
        20_000,
    );
    assert.equal(await page.js(`document.querySelector('.pdf-tools [role=status]').textContent`), 'Page 1 of 1');
    await page.key('Escape', 27);
    await until(page.js, `!document.querySelector('.attachment-viewer')`);
    await until(page.js, `${statuses}.every((s) => s === '' || s === 'Blade root, teal')`, 30_000);

    // ---------- added offline, kept through a restart, uploaded on reconnecting ----------
    stopServer();
    await until(page.js, `${subtitle}?.startsWith('Offline') || ${subtitle} === 'Connecting…'`);
    await page.js(`(async () => __paste([await __png(1200, 900, 'maroon', 'offline.png')]))()`);
    await until(page.js, `document.querySelectorAll('.note-attachment').length === 4`);
    await until(page.js, `${statuses}.includes('Waiting to upload')`);
    await sleep(500);
    await page.go(noteUrl); // Offline: the app and the note come from this device.
    await page.js(helpers);
    await until(
        page.js,
        `document.querySelectorAll('.note-attachment').length === 4 && [...document.querySelectorAll('.attachment-image img')].filter((i) => i.naturalWidth > 0).length === 3`,
        20_000,
    );
    await until(page.js, `${statuses}.includes('Waiting to upload')`);
    startServer();
    await until(page.js, `!${statuses}.some((s) => s.startsWith('Waiting') || s.startsWith('Uploading'))`, 40_000);
    const offline = JSON.parse(await page.js(attachments)).find((a) => a.name === 'offline.png');
    await until(async () => (await fetch(`${API}/blobs/${offline.blob}`).catch(() => null))?.ok, 'true', 20_000);

    // ---------- another device ----------
    const other = await device();
    await other.size(1280);
    await other.go(noteUrl);
    await until(
        other.js,
        `[...document.querySelectorAll('.attachment-image img')].filter((i) => i.complete && i.naturalWidth > 0).length === 3 && !!document.querySelector('.attachment-pdf img.card-page')`,
        30_000,
    );
    assert.equal(await other.js(`document.querySelector('.note-attachment img').alt`), 'Blade root, teal');

    // ---------- deleting one ----------
    await page.js(`document.querySelectorAll('.note-attachment summary')[1].click()`);
    await page.js(
        `[...document.querySelectorAll('.attachment-menu[open] .btn')].find((b) => b.textContent === 'Delete').click()`,
    );
    await until(page.js, `document.querySelectorAll('.note-attachment').length === 3`);
    await until(other.js, `document.querySelectorAll('.note-attachment').length === 3`);
    await until(async () => {
        const all = await (await fetch(`${API}/attachments`)).json();
        return all.filter((a) => a.note === noteId).length === 3 && !all.some((a) => a.blob === small.blob);
    }, 'true');

    for (const [sessionId, errors] of pageErrors) assert.deepEqual(errors, [], `page errors in ${sessionId}`);
    console.log(
        'PASS: attachments (upload protocol, pasting images, thumbnails, server listing, notes list picture, viewer, alt text and search, PDF, offline and reconnecting, second device, deleting)',
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
