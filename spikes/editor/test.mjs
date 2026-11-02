// Run the page's checks plus the ones only a driven browser can do: real keys
// and an IME composition while a remote edit arrives. Needs Node 22+ and chromium.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const PORT = 18095;
const DEBUG = 19295;
const work = mkdtempSync(join(tmpdir(), 'huginn-editor-'));
const http = createServer((req, res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    try {
        const file = readFileSync(join('dist', name));
        res.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html' });
        res.end(file);
    } catch {
        res.writeHead(404).end();
    }
}).listen(PORT, '127.0.0.1');
const chrome = spawn(
    'chromium',
    [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${DEBUG}`,
        `--user-data-dir=${join(work, 'p')}`,
        'about:blank',
    ],
    { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function finish(code) {
    chrome.kill();
    http.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.exit(code);
}
let tab;
for (let i = 0; i < 60 && !tab; i++) {
    await sleep(250);
    tab = await fetch(`http://127.0.0.1:${DEBUG}/json`)
        .then((r) => r.json())
        .then((l) => l.find((t) => t.type === 'page'))
        .catch(() => undefined);
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
const errors = [];
ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
    }
    if (m.method === 'Runtime.exceptionThrown')
        errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
};
const cmd = (method, params = {}) =>
    new Promise((resolve, reject) => {
        const n = ++id;
        const t = setTimeout(() => reject(Error(`timed out: ${method}`)), 30000);
        waiting.set(n, (m) => {
            clearTimeout(t);
            resolve(m.result ?? m.error);
        });
        ws.send(JSON.stringify({ id: n, method, params }));
    });
const js = async (expression) => {
    const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? expression);
    return r.result.value;
};
const key = async (key, code, vk) => {
    await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await sleep(60);
};
const results = [];
const check = async (name, body) => {
    try {
        await body();
        results.push(`PASS  ${name}`);
    } catch (e) {
        results.push(`FAIL  ${name}: ${e.message}`);
    }
};
const equal = (a, b, what) => {
    if (a !== b) throw Error(`${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

await cmd('Runtime.enable');
await cmd('Page.enable');
await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 60 && !(await js('!!window.spike').catch(() => false)); i++) await sleep(100);

const outcome = await js(
    `(async () => { const r = await window.spike.run(); return { failures: r.failures, lines: [...document.querySelectorAll('#results li')].map((l) => (l.className === 'pass' ? 'PASS  ' : 'FAIL  ') + l.textContent) }; })()`,
);
results.push(...outcome.lines);

const A = 'window.spike.a';
const B = 'window.spike.b';
const body = (d) => `${d}.editor.state.doc.textContent`;
// Tiptap's focus command waits for an animation frame, so wait for the focus itself.
const focusEnd = async (d) => {
    await js(`${d}.editor.commands.focus('end')`);
    for (let i = 0; i < 50 && !(await js(`${d}.editor.view.hasFocus()`)); i++) await sleep(20);
    equal(await js(`${d}.editor.view.hasFocus()`), true, 'editor focus');
};

await check('Real keystrokes type into the body and reach the other device', async () => {
    await focusEnd(A);
    await cmd('Input.insertText', { text: 'typed' });
    await sleep(100);
    equal(await js(`${body(A)}.includes('typed')`), true, 'on A');
    equal(await js(`${body(B)}.includes('typed')`), true, 'on B');
});

await check('Enter splits, Backspace joins, Ctrl+B formats', async () => {
    await key('Enter', 'Enter', 13);
    await cmd('Input.insertText', { text: 'second' });
    const count = await js(`${A}.editor.state.doc.childCount`);
    await key('Backspace', 'Backspace', 8);
    equal(await js(`${body(A)}.includes('secon') && !${body(A)}.includes('second')`), true, 'backspace');
    await cmd('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'b',
        code: 'KeyB',
        windowsVirtualKeyCode: 66,
        modifiers: 2,
        commands: [],
    });
    await cmd('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'b',
        code: 'KeyB',
        windowsVirtualKeyCode: 66,
        modifiers: 2,
    });
    await cmd('Input.insertText', { text: 'B' });
    equal(await js(`${A}.editor.getHTML().includes('<strong>B</strong>')`), true, 'bold');
    if (count < 3) throw Error(`paragraph not split: ${count}`);
});

await check('Typing in a checklist row does not enter the editor', async () => {
    await js(`document.querySelector('#a .checklist .text').focus()`);
    await cmd('Input.insertText', { text: 'Fresh ' });
    await sleep(100);
    equal(await js(`[...${B}.items.values()].some((m) => m.get('text').includes('Fresh '))`), true, 'item text on B');
    equal(await js(`${body(A)}.includes('Fresh')`), false, 'leaked into body');
    await key('Enter', 'Enter', 13);
    equal(await js(`document.activeElement.classList.contains('text')`), true, 'focus left the row');
});

await check('Arrow keys move the caret from prose back past the checklist', async () => {
    await focusEnd(A);
    for (let i = 0; i < 6; i++) await key('ArrowUp', 'ArrowUp', 38);
    const before = await js(`${A}.editor.state.selection.from`);
    equal(before < 3, true, `caret stopped at ${before}`);
});

await check('A remote edit during an IME composition does not break it', async () => {
    await focusEnd(A);
    await cmd('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await sleep(60);
    await cmd('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await sleep(60);
    await js(`${B}.editor.commands.insertContentAt(1, 'remote-text ')`);
    await sleep(120);
    await cmd('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await sleep(60);
    await cmd('Input.insertText', { text: '日本' });
    await sleep(200);
    const a = await js(body(A));
    const b = await js(body(B));
    equal(a.includes('日本'), true, `committed text on A (${a})`);
    equal(a.includes('remote-text'), true, 'remote text on A');
    equal(a, b, 'devices agree');
    equal(/[にほん]/.test(a), false, `composition left behind (${a})`);
});

for (const width of [320, 390, 640]) {
    await check(`No sideways overflow at ${width}px`, async () => {
        await cmd('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
        await sleep(100);
        equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'overflow');
    });
}
if (errors.length) results.push(`FAIL  uncaught: ${errors.join(' | ').slice(0, 300)}`);

const bundle = readFileSync('dist/main.js');
console.log(results.join('\n'));
console.log(
    `\nBundle: ${(statSync('dist/main.js').size / 1024).toFixed(0)} kB, ${(gzipSync(bundle).length / 1024).toFixed(0)} kB gzipped`,
);
finish(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
