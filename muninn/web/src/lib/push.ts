/**
 * Notifications on this device, through web push. The server holds a VAPID
 * key pair and one subscription per browser; Chrome on the Fold delivers
 * through its push service even when the app is closed. The Surface gets
 * its reminders through the desktop agent instead (muninn-agent), so this
 * is mostly for phones, but any browser that supports push works.
 */
import { base } from '$app/paths';
import { writable } from 'svelte/store';

export type PushState = 'unsupported' | 'denied' | 'off' | 'on' | 'working';
export const pushState = writable<PushState>('off');

function supported(): boolean {
    return (
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
}

async function registration(): Promise<ServiceWorkerRegistration> {
    return navigator.serviceWorker.ready;
}

/** What this browser is currently doing; call once on mount. */
export async function refreshPushState(): Promise<void> {
    if (!supported()) return pushState.set('unsupported');
    if (Notification.permission === 'denied') return pushState.set('denied');
    try {
        const sub = await (await registration()).pushManager.getSubscription();
        pushState.set(sub ? 'on' : 'off');
    } catch {
        pushState.set('off');
    }
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
    const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
    const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

export async function enablePush(): Promise<void> {
    if (!supported()) return;
    pushState.set('working');
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return pushState.set(permission === 'denied' ? 'denied' : 'off');
        const key = await (await fetch(`${base}/v1/push/key`)).text();
        const reg = await registration();
        const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(key.trim()),
        });
        const res = await fetch(`${base}/v1/push/subscriptions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(sub.toJSON()),
        });
        if (!res.ok) throw new Error(`server said ${res.status}`);
        pushState.set('on');
    } catch (e) {
        console.error('push', e);
        pushState.set('off');
    }
}

export async function disablePush(): Promise<void> {
    if (!supported()) return;
    pushState.set('working');
    try {
        const sub = await (await registration()).pushManager.getSubscription();
        if (sub) {
            await fetch(`${base}/v1/push/subscriptions`, {
                method: 'DELETE',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ endpoint: sub.endpoint }),
            });
            await sub.unsubscribe();
        }
    } finally {
        pushState.set('off');
    }
}

/** Ask the server to push a test notification to this browser. */
export async function testPush(): Promise<boolean> {
    const res = await fetch(`${base}/v1/push/test`, { method: 'POST' });
    return res.ok;
}
