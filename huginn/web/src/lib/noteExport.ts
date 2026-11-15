/**
 * A note out of Huginn: as Markdown or HTML (exportNote.ts does the writing),
 * with its attachments and drawings beside it in a zip when it has any, and
 * printed (or saved as a PDF from the print dialog) from the same HTML.
 */
import { get } from 'svelte/store';
import { strToU8, zipSync } from 'fflate';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { toHtml, toMarkdown, type AttachmentAttrs, type ExportContext, type PMNode } from '$lib/exportNote';
import { fileBlob } from '$lib/files';
import { HIGHLIGHTER_ALPHA, widthAt } from '$lib/ink';
import { linkText } from '$lib/noteLinks';
import { INK_STRIDE, INK_WIDTH, type Index, type Note, type Stroke } from '$lib/notes';
import { noteHref } from '$lib/scope';

/** Fixed colours, for paper and other apps: a theme's don't travel. */
const PRINT_COLORS: Record<string, string> = {
    ink: '#1f2328',
    blue: '#2563eb',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#eab308',
};

/** A drawing as a standalone SVG, or null when it has no strokes. */
export function inkSvg(strokes: Stroke[]): string | null {
    if (!strokes.length) return null;
    let bottom = 0;
    const paths = [...strokes]
        .sort((a, b) => a.created - b.created)
        .map((s) => {
            const p = s.points;
            const parts: string[] = [];
            let pressure = 0;
            for (let i = 0; i < p.length; i += INK_STRIDE) {
                parts.push(`${i ? 'L' : 'M'}${p[i].toFixed(1)} ${p[i + 1].toFixed(1)}`);
                pressure += p[i + 2];
                bottom = Math.max(bottom, p[i + 1] + s.width);
            }
            const samples = Math.max(1, p.length / INK_STRIDE);
            // One dot is a line to itself.
            if (samples === 1) parts.push(`L${p[0].toFixed(1)} ${p[1].toFixed(1)}`);
            const width = s.tool === 'highlighter' ? s.width : widthAt(s.width, pressure / samples);
            const opacity = s.tool === 'highlighter' ? ` stroke-opacity="${HIGHLIGHTER_ALPHA}"` : '';
            return `<path d="${parts.join('')}" stroke="${PRINT_COLORS[s.color] ?? PRINT_COLORS.ink}" stroke-width="${width.toFixed(1)}"${opacity}/>`;
        });
    const height = Math.ceil(bottom + 20);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${INK_WIDTH} ${height}" width="${INK_WIDTH}" height="${height}" ` +
        `fill="none" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</svg>`
    );
}

/** A name a file system takes, unique among `taken`. */
function fileName(name: string, taken: Set<string>): string {
    const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'attachment';
    const dot = clean.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
    let candidate = clean;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
}

export interface Exported {
    /** What to save it as. */
    name: string;
    bytes: Uint8Array;
    type: string;
    /** What couldn't come across, in words. */
    lost: string[];
}

interface Gathered {
    doc: PMNode;
    files: Map<string, { path: string; blob: Blob | null }>;
    drawings: Map<string, { path: string; svg: string | null }>;
    missing: number;
}

function walk(node: PMNode, visit: (n: PMNode) => void) {
    visit(node);
    for (const child of node.content ?? []) walk(child, visit);
}

/** The note's body, its attachments' bytes and its drawings, ready to write. */
async function gather(note: Note): Promise<Gathered> {
    const doc = yXmlFragmentToProsemirrorJSON(note.body) as unknown as PMNode;
    const taken = new Set<string>();
    const files = new Map<string, { path: string; blob: Blob | null }>();
    const drawings = new Map<string, { path: string; svg: string | null }>();
    let missing = 0;
    const wanted: AttachmentAttrs[] = [];
    walk(doc, (n) => {
        if (n.type === 'attachment' && n.attrs?.kind !== 'link' && n.attrs?.blob)
            wanted.push(n.attrs as unknown as AttachmentAttrs);
        if (n.type === 'ink' && n.attrs?.strokes) {
            const name = String(n.attrs.strokes);
            if (!drawings.has(name)) {
                drawings.set(name, {
                    path: `drawings/${drawings.size + 1}.svg`,
                    svg: inkSvg(get(note.ink(name).strokes)),
                });
            }
        }
    });
    for (const a of wanted) {
        if (files.has(a.blob)) continue;
        const blob = await fileBlob(a.blob);
        if (!blob) missing++;
        files.set(a.blob, { path: `attachments/${fileName(a.name || 'attachment', taken)}`, blob });
    }
    return { doc, files, drawings, missing };
}

function context(
    note: Note,
    index: Index,
    g: Gathered,
    pathOf: (blob: string, fallback: string) => string,
): ExportContext {
    return {
        checklist: (list) => get(note.list(list).items).map((i) => ({ text: i.text, checked: i.checked })),
        inkSvg: (strokes) => g.drawings.get(strokes)?.svg ?? null,
        inkPath: (strokes) => g.drawings.get(strokes)?.path ?? 'drawing.svg',
        noteLink: (attrs) => ({
            text: linkText(attrs, index.entry(attrs.note)).text,
            href: new URL(noteHref(attrs.note, { kind: 'all' }, attrs.section || undefined), location.origin).href,
        }),
        attachmentPath: (attrs) => pathOf(attrs.blob, g.files.get(attrs.blob)?.path ?? 'attachment'),
    };
}

/** The note as Markdown or HTML: one file, or a zip with what it holds beside it. */
export async function exportNote(note: Note, index: Index, title: string, as: 'md' | 'html'): Promise<Exported> {
    const g = await gather(note);
    const ctx = context(note, index, g, (_blob, path) => path);
    const out = as === 'md' ? toMarkdown(g.doc, title, ctx) : toHtml(g.doc, title, ctx);
    const lost = [...out.lost];
    if (g.missing) {
        lost.push(
            `${g.missing} ${g.missing === 1 ? 'attachment' : 'attachments'} not on this device or the server yet (left out)`,
        );
    }
    const base = fileName(title.slice(0, 80) || 'Untitled note', new Set());
    const main = `${base}.${as}`;
    const beside: Record<string, Uint8Array> = {};
    for (const { path, blob } of g.files.values()) {
        if (blob) beside[path] = new Uint8Array(await blob.arrayBuffer());
    }
    // HTML has its drawings inline; Markdown refers to them.
    if (as === 'md') for (const { path, svg } of g.drawings.values()) if (svg) beside[path] = strToU8(svg);
    const type = as === 'md' ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8';
    if (!Object.keys(beside).length) return { name: main, bytes: strToU8(out.text), type, lost };
    // Stored, not compressed: photos and PDFs are compressed already.
    const zip = zipSync({ [main]: strToU8(out.text), ...beside }, { level: 0 });
    return { name: `${base}.zip`, bytes: zip, type: 'application/zip', lost };
}

/** Hand a file to the browser to save. */
export function save(file: { name: string; bytes: Uint8Array; type: string }) {
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Print the note, or save it as a PDF from the print dialog, as its HTML export lays it out. */
export async function printNote(note: Note, index: Index, title: string): Promise<string[]> {
    const g = await gather(note);
    const urls = new Map<string, string>();
    for (const [blob, { blob: bytes }] of g.files) if (bytes) urls.set(blob, URL.createObjectURL(bytes));
    const out = toHtml(
        g.doc,
        title,
        context(note, index, g, (blob, path) => urls.get(blob) ?? path),
    );
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    frame.srcdoc = out.text;
    document.body.append(frame);
    await new Promise<void>((resolve) => (frame.onload = () => resolve()));
    // Images first, or the page prints with gaps.
    await Promise.all(
        [...frame.contentDocument!.images].map((img) =>
            img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))),
        ),
    );
    const done = () => {
        frame.remove();
        for (const url of urls.values()) URL.revokeObjectURL(url);
    };
    frame.contentWindow!.addEventListener('afterprint', () => setTimeout(done, 100), { once: true });
    frame.contentWindow!.print();
    // Some browsers never say printing ended.
    setTimeout(done, 10 * 60_000);
    return g.missing ? [...out.lost, `${g.missing} attachments not on this device or the server yet`] : out.lost;
}
