/**
 * Follow the Omarchy desktop theme, when the browser runs on Omarchy.
 *
 * A web page cannot read ~/.local/state/omarchy, so a small helper on the
 * workstation (the omarchy-theme-bridge from fieldhook-monitor) serves the
 * active theme's colors.toml as JSON on 127.0.0.1. This is opt-in: asking a
 * loopback address makes Chrome ask the user for local-network access. Once
 * on, the page re-reads the palette every few seconds while it is visible,
 * so a theme switch follows within moments, and falls back to its own
 * light/dark palette whenever the helper is not answering.
 *
 * Both ravens share one origin and one storage key, so the toggle is one
 * decision for both apps.
 */
import { writable } from 'svelte/store';

export const BRIDGE_URL = 'http://127.0.0.1:47190/theme.json';
const ENABLED_KEY = 'ravens.omarchy';
const POLL_MS = 4_000;
/** While the helper is not answering, ask less often (each miss logs a console error). */
const RETRY_MS = 30_000;

export type OmarchyState = 'off' | 'connecting' | 'on' | 'unreachable';
export const omarchyState = writable<OmarchyState>('off');
export const omarchyThemeName = writable<string>('');

interface Bridge {
    name?: string;
    mode?: string;
    colors: Record<string, string>;
}

const HEX = /^#[0-9a-f]{6}$/i;

function enabled(): boolean {
    try {
        return localStorage.getItem(ENABLED_KEY) === '1';
    } catch {
        return false;
    }
}

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
function onColor(hex: string): string {
    const channel = (i: number) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const l = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/** The page's tokens (tokens.css) from an Omarchy palette. */
function tokens(colors: Record<string, string>): Record<string, string> {
    const c = (name: string, fallback?: string) => (HEX.test(colors[name] ?? '') ? colors[name] : fallback);
    const bg = c('background')!;
    const fg = c('foreground')!;
    const accent = c('accent', c('blue', fg))!;
    const set: Record<string, string | undefined> = {
        '--bg': bg,
        '--panel': c('lighter_background', bg),
        // Chrome sits one step off the content, as libadwaita apps spend the same palette.
        '--sidebar': c('dark_background', `color-mix(in srgb, ${bg} 75%, #000000)`),
        '--panel-2': 'color-mix(in srgb, var(--panel) 93%, var(--text))',
        '--text': fg,
        '--muted': `color-mix(in srgb, ${fg} 68%, ${bg})`,
        '--line': `color-mix(in srgb, ${fg} 14%, ${bg})`,
        '--accent': accent,
        '--on-accent': onColor(accent),
        '--accent-2': c('blue', accent),
        '--danger': c('red'),
        '--warn': c('yellow', c('orange')),
        '--ok': c('green'),
        '--ink': fg,
    };
    return Object.fromEntries(Object.entries(set).filter((e): e is [string, string] => !!e[1]));
}

let applied: string[] = [];

function apply(theme: Bridge) {
    const root = document.documentElement;
    const next = tokens(theme.colors);
    for (const name of applied) if (!(name in next)) root.style.removeProperty(name);
    for (const [name, value] of Object.entries(next)) root.style.setProperty(name, value);
    applied = Object.keys(next);
    root.style.colorScheme = theme.mode === 'light' ? 'light' : 'dark';
    setThemeColor(theme.colors.background);
}

function clear() {
    const root = document.documentElement;
    for (const name of applied) root.style.removeProperty(name);
    applied = [];
    root.style.removeProperty('color-scheme');
    setThemeColor(null);
}

function setThemeColor(color: string | null) {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    meta.dataset.default ??= meta.content;
    meta.content = color && HEX.test(color) ? color : meta.dataset.default;
}

let last = '';
let retryAt = 0;

async function poll() {
    if (Date.now() < retryAt) return;
    try {
        const res = await fetch(BRIDGE_URL, {
            cache: 'no-store',
            credentials: 'omit',
            signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) throw new Error(String(res.status));
        const text = await res.text();
        if (text !== last) {
            const theme = JSON.parse(text) as Bridge;
            if (!HEX.test(theme.colors?.background ?? '') || !HEX.test(theme.colors?.foreground ?? ''))
                throw new Error('no palette');
            apply(theme);
            last = text;
            omarchyThemeName.set(theme.name ?? '');
        }
        omarchyState.set('on');
        retryAt = 0;
    } catch {
        retryAt = Date.now() + RETRY_MS;
        if (applied.length) clear();
        last = '';
        omarchyState.set('unreachable');
    }
}

let stopPolling: (() => void) | null = null;

function startPolling() {
    if (stopPolling) return;
    omarchyState.set('connecting');
    const controller = new AbortController();
    retryAt = 0;
    const tick = () => {
        if (document.visibilityState === 'visible') void poll();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick, { signal: controller.signal });
    window.addEventListener('focus', tick, { signal: controller.signal });
    tick();
    stopPolling = () => {
        clearInterval(timer);
        controller.abort();
        stopPolling = null;
    };
}

/** Turn following the desktop theme on or off; remembered per browser. */
export function setFollowOmarchy(on: boolean) {
    try {
        if (on) localStorage.setItem(ENABLED_KEY, '1');
        else localStorage.removeItem(ENABLED_KEY);
    } catch {
        /* still applies for this visit */
    }
    if (on) startPolling();
    else {
        stopPolling?.();
        clear();
        last = '';
        omarchyState.set('off');
    }
}

/** Call once from the layout. */
export function startOmarchy(): () => void {
    if (enabled()) startPolling();
    return () => stopPolling?.();
}

/** What the settings menu says next to the toggle. */
export const omarchyHint: Record<OmarchyState, string> = {
    off: 'Use the desktop palette (needs the omarchy-theme-bridge on this computer).',
    connecting: 'Looking for the theme bridge…',
    on: 'Following the desktop theme.',
    unreachable: 'The theme bridge is not answering on 127.0.0.1:47190; using the default palette.',
};
