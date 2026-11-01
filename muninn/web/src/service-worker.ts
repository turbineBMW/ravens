/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Muninn's service worker: it caches nothing (the app is local-first through
 * IndexedDB already); it is here to receive web push and show the reminder
 * as a system notification, and to bring the right list forward on a tap.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

interface Pushed {
    title: string;
    body?: string;
    url?: string;
    tag?: string;
}

sw.addEventListener('install', () => {
    void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
    event.waitUntil(sw.clients.claim());
});

sw.addEventListener('push', (event) => {
    let data: Pushed = { title: 'Reminder' };
    try {
        data = { ...data, ...(event.data?.json() as Pushed) };
    } catch {
        data.body = event.data?.text();
    }
    event.waitUntil(
        sw.registration.showNotification(data.title, {
            body: data.body,
            tag: data.tag,
            icon: new URL('icon-192.png', sw.registration.scope).href,
            badge: new URL('icon-192.png', sw.registration.scope).href,
            data: { url: data.url ?? sw.registration.scope },
        }),
    );
});

sw.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL(
        (event.notification.data?.url as string | undefined) ?? sw.registration.scope,
        sw.location.origin,
    );
    event.waitUntil(
        (async () => {
            const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
            const open = windows.find((w) =>
                new URL(w.url).pathname.startsWith(new URL(sw.registration.scope).pathname),
            );
            if (open) {
                await open.focus();
                if (open.url !== target.href) await open.navigate(target.href).catch(() => undefined);
            } else {
                await sw.clients.openWindow(target.href);
            }
        })(),
    );
});

// A subscription can be rotated by the browser; hand the new one to the server.
sw.addEventListener('pushsubscriptionchange', (event) => {
    const e = event as Event & { newSubscription?: PushSubscription | null };
    const sub = e.newSubscription;
    if (!sub) return;
    const base = new URL(sw.registration.scope).pathname.replace(/\/$/, '');
    void fetch(`${base}/v1/push/subscriptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
    });
});
