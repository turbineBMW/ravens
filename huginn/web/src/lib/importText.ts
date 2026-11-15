/**
 * Markdown and plain text into new notes. Markdown is read with marked and
 * written as the editor's own content: headings, paragraphs, bold, italic,
 * strikethrough, code, links, lists, quotes, code blocks, divider lines,
 * tables, and task lists as checklists. An image the Markdown refers to by a
 * path is attached when the file came with it (a zip exported from Huginn,
 * say); one on the web stays a link. What can't come across is reported.
 */
import { getSchema, Node } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap';
import { marked, type Token, type Tokens } from 'marked';
import { addFile } from '$lib/files';
import { openNote, type Index } from '$lib/notes';
import { describe } from '$lib/thumbs';

type PMNode = { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: PMMark[] };
type PMMark = { type: string; attrs?: Record<string, unknown> };

/** The editor's schema, enough to write what an import makes. */
let schema: ReturnType<typeof getSchema> | null = null;
function editorSchema() {
    const block = (name: string, attrs: Record<string, unknown>) =>
        Node.create({
            name,
            group: 'block',
            atom: true,
            addAttributes: () => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { default: v }])),
        });
    schema ??= getSchema([
        StarterKit.configure({ undoRedo: false }),
        Highlight,
        TableKit,
        block('checklist', { list: 'items' }),
        block('attachment', {
            blob: '',
            kind: 'file',
            name: '',
            type: '',
            size: 0,
            width: 0,
            height: 0,
            pages: 0,
            thumb: '',
            alt: '',
            url: '',
            title: '',
            description: '',
        }),
    ]);
    return schema;
}

export interface ImportReport {
    notes: number;
    files: number;
    lost: string[];
}

interface Converting {
    /** A file that came with the Markdown, by its path. */
    asset: (path: string) => Blob | undefined;
    /** Checklists to fill once the note exists: each block's items. */
    lists: { text: string; checked: boolean }[][];
    attachments: Promise<PMNode | null>[];
    lost: Set<string>;
}

const SAFE = /^(https?:|mailto:|tel:)/i;

function inline(tokens: Token[] | undefined, c: Converting, marks: PMMark[] = []): PMNode[] {
    const out: PMNode[] = [];
    const text = (t: string) => {
        if (t) out.push({ type: 'text', text: t, ...(marks.length ? { marks } : {}) });
    };
    for (const t of tokens ?? []) {
        switch (t.type) {
            case 'strong':
                out.push(...inline(t.tokens, c, [...marks, { type: 'bold' }]));
                break;
            case 'em':
                out.push(...inline(t.tokens, c, [...marks, { type: 'italic' }]));
                break;
            case 'del':
                out.push(...inline(t.tokens, c, [...marks, { type: 'strike' }]));
                break;
            case 'codespan':
                text(decode(t.text));
                if (out.length) out[out.length - 1].marks = [...marks, { type: 'code' }];
                break;
            case 'link': {
                const href = (t as Tokens.Link).href;
                if (SAFE.test(href)) out.push(...inline(t.tokens, c, [...marks, { type: 'link', attrs: { href } }]));
                else {
                    out.push(...inline(t.tokens, c, marks));
                    // A link to a file that came along, as an exported note has for its PDFs: attached.
                    if (c.asset(href)) c.attachments.push(attach(href, '', c));
                }
                break;
            }
            case 'image': {
                const img = t as Tokens.Image;
                // Kept as its words here; attached below the paragraph when the file came along.
                if (SAFE.test(img.href)) {
                    out.push({
                        type: 'text',
                        text: img.text || img.href,
                        marks: [...marks, { type: 'link', attrs: { href: img.href } }],
                    });
                } else if (c.asset(img.href)) {
                    c.attachments.push(attach(img.href, img.text, c));
                } else {
                    text(img.text);
                    c.lost.add('Images that didn’t come with the file (their descriptions kept)');
                }
                break;
            }
            case 'br':
                out.push({ type: 'hardBreak' });
                break;
            case 'html':
                text(t.raw.replace(/<[^>]*>/g, ''));
                c.lost.add('HTML in Markdown (its text kept)');
                break;
            case 'escape':
            case 'text':
                if ('tokens' in t && t.tokens?.length) out.push(...inline(t.tokens, c, marks));
                else text(decode(t.text));
                break;
            default:
                if ('text' in t && typeof t.text === 'string') text(decode(t.text));
        }
    }
    return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
function decode(s: string) {
    return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (all, e: string) => {
        if (e[0] === '#') {
            const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
        }
        return ENTITIES[e.toLowerCase()] ?? all;
    });
}

async function attach(path: string, alt: string, c: Converting): Promise<PMNode | null> {
    const blob = c.asset(path)!;
    const name = decodeURIComponent(path.split('/').pop() || 'image');
    try {
        const made = await describe(blob, name);
        const id = await addFile(blob);
        const thumb = made.thumb ? await addFile(made.thumb) : '';
        return {
            type: 'attachment',
            attrs: {
                blob: id,
                kind: made.kind,
                name,
                type: blob.type,
                size: blob.size,
                width: made.width,
                height: made.height,
                pages: made.pages,
                thumb,
                alt,
            },
        };
    } catch {
        c.lost.add('Images that couldn’t be stored on this device');
        return null;
    }
}

const paragraph = (content: PMNode[]): PMNode => ({ type: 'paragraph', ...(content.length ? { content } : {}) });

async function blocks(tokens: Token[], c: Converting): Promise<PMNode[]> {
    const out: PMNode[] = [];
    for (const t of tokens) {
        c.attachments = [];
        switch (t.type) {
            case 'heading':
                out.push({
                    type: 'heading',
                    attrs: { level: Math.min(3, (t as Tokens.Heading).depth) },
                    content: inline(t.tokens, c),
                });
                if ((t as Tokens.Heading).depth > 3) c.lost.add('Headings below the third level (made third level)');
                break;
            case 'paragraph': {
                const content = inline(t.tokens, c);
                // A paragraph that only showed or linked files that came along is those attachments now.
                const onlyFiles = (t.tokens ?? []).every(
                    (x) =>
                        (x.type === 'text' && !x.text.trim()) ||
                        x.type === 'br' ||
                        ((x.type === 'image' || x.type === 'link') &&
                            !SAFE.test((x as Tokens.Link).href) &&
                            !!c.asset((x as Tokens.Link).href)),
                );
                if (!onlyFiles || !c.attachments.length) out.push(paragraph(content));
                break;
            }
            case 'text':
                out.push(paragraph(inline((t as Tokens.Text).tokens ?? [t], c)));
                break;
            case 'blockquote':
                out.push({ type: 'blockquote', content: await blocks((t as Tokens.Blockquote).tokens, c) });
                break;
            case 'code':
                out.push({
                    type: 'codeBlock',
                    attrs: { language: (t as Tokens.Code).lang || null },
                    ...(t.text ? { content: [{ type: 'text', text: t.text }] } : {}),
                });
                break;
            case 'hr':
                out.push({ type: 'horizontalRule' });
                break;
            case 'list': {
                const list = t as Tokens.List;
                if (list.items.some((i) => i.task)) {
                    c.lists.push(
                        list.items.map((i) => ({ text: i.text.replace(/\s+/g, ' ').trim(), checked: !!i.checked })),
                    );
                    out.push({ type: 'checklist', attrs: { list: `pending:${c.lists.length - 1}` } });
                    break;
                }
                const items: PMNode[] = [];
                for (const item of list.items) {
                    const inner = await blocks(item.tokens, c);
                    items.push({ type: 'listItem', content: inner.length ? inner : [paragraph([])] });
                }
                out.push({
                    type: list.ordered ? 'orderedList' : 'bulletList',
                    ...(list.ordered && list.start !== '' && Number(list.start) !== 1
                        ? { attrs: { start: Number(list.start) } }
                        : {}),
                    content: items,
                });
                break;
            }
            case 'table': {
                const table = t as Tokens.Table;
                const cell = (type: string, cellToken: Tokens.TableCell): PMNode => ({
                    type,
                    content: [paragraph(inline(cellToken.tokens, c))],
                });
                out.push({
                    type: 'table',
                    content: [
                        { type: 'tableRow', content: table.header.map((h) => cell('tableHeader', h)) },
                        ...table.rows.map((row) => ({
                            type: 'tableRow',
                            content: row.map((r) => cell('tableCell', r)),
                        })),
                    ],
                });
                if (table.align.some(Boolean)) c.lost.add('Table column alignment');
                break;
            }
            case 'html':
                out.push(paragraph([{ type: 'text', text: t.raw.replace(/<[^>]*>/g, '').trim() || ' ' }]));
                c.lost.add('HTML in Markdown (its text kept)');
                break;
            case 'space':
            case 'def':
                break;
            default:
                if ('text' in t && typeof t.text === 'string' && t.text.trim()) {
                    out.push(paragraph([{ type: 'text', text: t.text }]));
                }
        }
        // Images found in that block go after it, as attachments.
        for (const node of await Promise.all(c.attachments)) if (node) out.push(node);
    }
    return out;
}

/** Plain text: each line a paragraph, so the first is the title. */
function plainBlocks(text: string): PMNode[] {
    return text
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => paragraph(line ? [{ type: 'text', text: line }] : []));
}

/** Drop empty text nodes, which ProseMirror refuses. */
function tidy(nodes: PMNode[]): PMNode[] {
    return nodes.flatMap((n) => {
        if (n.type === 'text') return n.text ? [n] : [];
        return [{ ...n, ...(n.content ? { content: tidy(n.content) } : {}) }];
    });
}

/**
 * One file as a new note. `assets`: files that came with it, by path, for the
 * images it refers to. Resolves once the note is written on this device.
 */
export async function importText(
    index: Index,
    name: string,
    text: string,
    assets: Map<string, Blob> = new Map(),
    folder = '',
): Promise<{ lost: string[] }> {
    const markdown = !/\.txt$/i.test(name);
    const c: Converting = {
        asset: (path) => assets.get(decodeURIComponent(path).replace(/^\.\//, '')),
        lists: [],
        attachments: [],
        lost: new Set(),
    };
    let content = markdown ? await blocks(marked.lexer(text, { gfm: true }), c) : plainBlocks(text);
    if (!content.length) content = [paragraph([])];

    const id = index.create('text', folder);
    const note = openNote(id, index);
    try {
        await note.doc.whenLocal;
        note.initialise();
        // Each checklist block gets its own list, filled in.
        const names = c.lists.map(() => note.newList());
        content = content.map((n) =>
            n.type === 'checklist' && String(n.attrs?.list).startsWith('pending:')
                ? { ...n, attrs: { list: names[Number(String(n.attrs!.list).slice('pending:'.length))] } }
                : n,
        );
        if (content.some((n) => n.type === 'attachment')) note.allowAttachments();
        note.doc.doc.transact(() => {
            prosemirrorJSONToYXmlFragment(editorSchema(), { type: 'doc', content: tidy(content) }, note.body);
        });
        c.lists.forEach((items, i) => {
            const list = note.list(names[i]);
            let after: string | null = null;
            for (const item of items) {
                after = list.addItem(item.text, after);
                if (item.checked) list.setChecked(after, true);
            }
        });
        note.repairIndex();
    } finally {
        note.release();
    }
    return { lost: [...c.lost] };
}
