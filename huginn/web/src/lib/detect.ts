/**
 * Web addresses, email addresses and phone numbers in a note's text, as Apple
 * Notes underlines them. They're found where the note is shown, never stored,
 * so a note written before this, or on another device, is detected the same
 * way. Addresses are linkify's, the same as the editor's own links; phone
 * numbers are this file's, kept strict so dates, times, versions and part
 * numbers aren't taken for one.
 */
import { find } from 'linkifyjs';

export type DetectedKind = 'url' | 'email' | 'phone';

export interface Detected {
    kind: DetectedKind;
    /** Where it is in the text, as JavaScript counts. */
    at: number;
    end: number;
    text: string;
    /** https:, mailto: or tel:. */
    href: string;
}

const SCHEMES = new Set(['http:', 'https:', 'mailto:']);
/** Top-level domains that are more often a file's extension: `README.md` is a file, not a site. */
const FILE_LIKE = new Set(['md', 'py', 'rs', 'sh', 'pl', 'zip', 'mov']);

function address(value: string, href: string, type: string): DetectedKind | null {
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    if (!SCHEMES.has(url.protocol)) return null;
    if (url.protocol === 'mailto:' || type === 'email') {
        // An address at a host with no dot (me@localhost) is a username, not mail.
        const host = value.split('@').pop() ?? '';
        return host.includes('.') ? 'email' : null;
    }
    const bare = !/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^www\./i.test(value);
    if (bare) {
        if (/^\d{1,3}(\.\d{1,3}){3}/.test(value)) return null;
        const host = value.split(/[/?#:]/)[0];
        const tld = host.split('.').pop()!.toLowerCase();
        if (FILE_LIKE.has(tld) && host === value) return null;
    }
    return 'url';
}

/**
 * Phone numbers: one written with a `+` and a country code, or a North
 * American one in three parts (555-123-4567, (555) 123-4567, 555.123.4567,
 * 1 555 123 4567). Not one inside a longer run of digits, letters or dashes.
 */
const PHONE = new RegExp(
    [
        String.raw`(?<![\p{L}\p{N}_./+-])`,
        '(?:',
        String.raw`\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}`,
        '|',
        String.raw`(?:1[ .-])?(?:\(\d{3}\) ?|\d{3}[ .-])\d{3}[ .-]\d{4}`,
        ')',
        String.raw`(?![\p{L}\p{N}_]|[.-]\d)`,
    ].join(''),
    'gu',
);

function phones(text: string): Detected[] {
    const found: Detected[] = [];
    for (const m of text.matchAll(PHONE)) {
        const written = m[0];
        const digits = written.replace(/\D/g, '');
        if (written.startsWith('+') ? digits.length < 8 || digits.length > 15 : false) continue;
        // A bracket that's opened is closed: `+1 (555 123` isn't a number.
        if ((written.match(/\(/g) ?? []).length !== (written.match(/\)/g) ?? []).length) continue;
        found.push({
            kind: 'phone',
            at: m.index,
            end: m.index + written.length,
            text: written,
            href: `tel:${written.startsWith('+') ? '+' : ''}${digits}`,
        });
    }
    return found;
}

/** Everything detected in one line or paragraph of text, in order, none overlapping. */
export function detectIn(text: string): Detected[] {
    const found: Detected[] = [];
    for (const m of find(text, { defaultProtocol: 'https' })) {
        if (!m.isLink) continue;
        const kind = address(m.value, m.href, m.type);
        if (kind) found.push({ kind, at: m.start, end: m.end, text: m.value, href: m.href });
    }
    // A number inside an address (a URL's path, say) is part of the address.
    for (const p of phones(text)) {
        if (!found.some((f) => p.at < f.end && f.at < p.end)) found.push(p);
    }
    return found.sort((a, b) => a.at - b.at);
}

/** What the menu for one says it does, in order: the first is what Ctrl+click does. */
export function actionsFor(kind: DetectedKind, href: string): { label: string; href: string }[] {
    if (kind === 'email') return [{ label: 'Send email', href }];
    if (kind === 'phone')
        return [
            { label: 'Call', href },
            { label: 'Send message', href: href.replace(/^tel:/, 'sms:') },
        ];
    return [{ label: 'Open link', href }];
}

/** What Copy puts on the clipboard: the address without its mailto:, the number as written. */
export function copyText(kind: DetectedKind, href: string, text: string): string {
    if (kind === 'email') return href.replace(/^mailto:/i, '').split('?')[0];
    if (kind === 'phone') return text;
    return href;
}
