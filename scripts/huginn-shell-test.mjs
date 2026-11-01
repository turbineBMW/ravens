// Validate the built offline shell and request boundaries without browser/network access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const origin = 'https://huginn.test';
const handlers = new Map();
const storage = new Map();
const cache = {
    async addAll(requests) {
        for (const request of requests) {
            assert.ok(request.url.startsWith(`${origin}/huginn/`));
            const path = new URL(request.url).pathname.slice('/huginn/'.length);
            const body = await readFile(`huginn/web/build/${path}`);
            storage.set(request.url, new Response(body));
        }
    },
    async match(request) {
        return storage.get(typeof request === 'string' ? request : request.url);
    },
};
vm.runInNewContext(await readFile('huginn/web/build/service-worker.js', 'utf8'), {
    self: {
        registration: { scope: `${origin}/huginn/` },
        location: { origin },
        clients: { claim: async () => {} },
        addEventListener: (name, fn) => handlers.set(name, fn),
    },
    location: new URL(`${origin}/huginn/service-worker.js`),
    URL,
    Request,
    caches: {
        open: async () => cache,
        keys: async () => ['muninn-cache'],
        delete: async () => assert.fail('must not delete another app cache'),
    },
    fetch: async () => {
        throw Error('Offline');
    },
});
let pending;
handlers.get('install')({ waitUntil: (p) => (pending = p) });
await pending;
handlers.get('activate')({ waitUntil: (p) => (pending = p) });
await pending;
let response;
handlers.get('fetch')({
    request: { method: 'GET', url: `${origin}/huginn/n/example`, mode: 'navigate' },
    respondWith: (p) => (response = p),
});
assert.match(await (await response).text(), /sveltekit/);
for (const url of [`${origin}/huginn/v1/me`, `${origin}/muninn/`, 'https://other.test/huginn/']) {
    handlers.get('fetch')({
        request: { method: 'GET', url, mode: 'navigate' },
        respondWith: () => assert.fail(`intercepted ${url}`),
    });
}
console.log(`PASS: ${storage.size} shell/assets exist, offline deep-link fallback, API and other app isolation`);
