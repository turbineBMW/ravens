/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;
const prefix = 'huginn-shell-';
const cacheName = `${prefix}${version}`;
const shell = new URL('index.html', sw.registration.scope).href;
const assets = new Set([...build, ...files].map((path) => new URL(path, sw.location.origin).href));

// Install the entire build together. Do not take over an older open editor:
// the new worker activates after its existing tabs close.
sw.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(cacheName);
            await cache.addAll([...assets, shell].map((url) => new Request(url, { cache: 'reload' })));
        })(),
    );
});
sw.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            for (const key of await caches.keys()) {
                if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
            }
            await sw.clients.claim();
        })(),
    );
});
sw.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    const scope = new URL(sw.registration.scope);
    // Shared from another app (the manifest's share_target): kept for the capture page, which takes it.
    if (request.method === 'POST' && url.origin === scope.origin && url.pathname === `${scope.pathname}share`) {
        event.respondWith(keepShared(request, scope));
        return;
    }
    if (request.method !== 'GET' || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    // Never cache identities, API responses, or sync endpoints.
    if (url.pathname.startsWith(`${scope.pathname}v1/`)) return;
    if (request.mode === 'navigate' || assets.has(url.href)) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(cacheName);
                const cached = await cache.match(request.mode === 'navigate' ? shell : request);
                return cached ?? fetch(request);
            })(),
        );
    }
});

async function keepShared(request: Request, scope: URL): Promise<Response> {
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const at = (path: string) => new URL(`share/${key}/${path}`, scope).href;
    try {
        const form = await request.formData();
        const files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);
        const cache = await caches.open('huginn-share');
        for (const [i, f] of files.entries()) await cache.put(at(`file/${i}`), new Response(f));
        const field = (name: string) => String(form.get(name) ?? '');
        await cache.put(
            at('data'),
            new Response(
                JSON.stringify({
                    title: field('title'),
                    text: field('text'),
                    url: field('url'),
                    files: files.map((f) => ({ name: f.name, type: f.type })),
                }),
            ),
        );
        return Response.redirect(new URL(`capture?share=${key}`, scope).href, 303);
    } catch {
        return Response.redirect(new URL('capture', scope).href, 303);
    }
}
