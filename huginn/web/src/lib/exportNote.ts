/**
 * Export one note's body (the ProseMirror JSON that Tiptap's
 * yXmlFragmentToProsemirrorJSON gives) as Markdown (CommonMark + GFM) or as a
 * standalone, print-friendly HTML document, and say what couldn't be carried
 * across. Pure: no DOM, no Svelte, no app imports. Everything that lives
 * outside the body (checklist items, drawings, other notes, attachment files)
 * comes in through an ExportContext.
 */

export interface PMMark {
    type: string;
    attrs?: Record<string, unknown>;
}

export interface PMNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: PMNode[];
    text?: string;
    marks?: PMMark[];
}

export interface AttachmentAttrs {
    blob: string;
    kind: string;
    name: string;
    type: string;
    size: number;
    width: number;
    height: number;
    thumb: string;
    alt: string;
    url: string;
    title: string;
    description: string;
}

export interface ExportContext {
    /** A checklist block's items, in display order. */
    checklist(list: string): { text: string; checked: boolean }[];
    /** A drawing as a standalone SVG document string, or null if it's empty. */
    inkSvg(strokes: string): string | null;
    /** Where the drawing's SVG file sits relative to the exported note (Markdown references it), e.g. `drawings/1.svg`. */
    inkPath(strokes: string): string;
    /** What a note link says and where it goes (a relative path to the other exported note, or a URL). */
    noteLink(attrs: { note: string; section: string; heading: string; label: string }): { text: string; href: string };
    /** Where an attachment's file sits relative to the exported note, e.g. `attachments/report.pdf`. */
    attachmentPath(attrs: AttachmentAttrs): string;
}

export interface Exported {
    text: string;
    /** Human-readable, deduplicated, e.g. "Highlights (kept as plain text)" */
    lost: string[];
}

const LOST = {
    underline: 'Underline (kept as plain text)',
    highlight: 'Highlights (kept as plain text)',
    merged: 'Merged table cells (split)',
    ink: 'Drawings (exported as images, no longer editable)',
    unsafe: 'Unsafe links (kept as text)',
};

const INLINE = new Set(['text', 'hardBreak', 'noteLink']);
const BLOCKS = new Set([
    'doc',
    'paragraph',
    'heading',
    'blockquote',
    'codeBlock',
    'horizontalRule',
    'bulletList',
    'orderedList',
    'listItem',
    'table',
    'tableRow',
    'tableHeader',
    'tableCell',
    'checklist',
    'ink',
    'attachment',
]);
/** Marks nest in this order, outermost first, so the same input always nests the same way. */
const MD_MARKS = ['link', 'bold', 'italic', 'strike', 'code'];
const HTML_MARKS = ['link', 'bold', 'italic', 'underline', 'strike', 'highlight', 'code'];
const HTML_TAGS: Record<string, string> = {
    bold: 'strong',
    italic: 'em',
    underline: 'u',
    strike: 's',
    highlight: 'mark',
    code: 'code',
};
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

export function toMarkdown(doc: PMNode, title: string, ctx: ExportContext): Exported {
    const md = new MarkdownWriter(ctx);
    const body = md.blocks(doc.content ?? []);
    const head = title.trim() && !startsWithTitle(doc, title) ? `# ${md.headingText(escapeMd(title.trim()))}` : '';
    const text = [head, body].filter(Boolean).join('\n\n');
    return { text: text + '\n', lost: [...md.lost] };
}

export function toHtml(doc: PMNode, title: string, ctx: ExportContext): Exported {
    const html = new HtmlWriter(ctx);
    const body = html.blocks(doc.content ?? []);
    const name = title.trim();
    const head = name && !startsWithTitle(doc, title) ? `<h1 class="title">${escapeHtml(name)}</h1>` : '';
    const text = [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(name || firstHeading(doc) || 'Untitled')}</title>`,
        `<style>\n${CSS}\n</style>`,
        '</head>',
        '<body>',
        '<article>',
        ...[head, body].filter(Boolean),
        '</article>',
        '</body>',
        '</html>',
        '',
    ].join('\n');
    return { text, lost: [...html.lost] };
}

// ---------------------------------------------------------------------------
// Shared

type Attrs = Record<string, unknown> | undefined;

function str(attrs: Attrs, key: string): string {
    const v = attrs?.[key];
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function num(attrs: Attrs, key: string, fallback = 0): number {
    const v = attrs?.[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

function attachmentAttrs(attrs: Attrs): AttachmentAttrs {
    return {
        blob: str(attrs, 'blob'),
        kind: str(attrs, 'kind'),
        name: str(attrs, 'name'),
        type: str(attrs, 'type'),
        size: num(attrs, 'size'),
        width: num(attrs, 'width'),
        height: num(attrs, 'height'),
        thumb: str(attrs, 'thumb'),
        alt: str(attrs, 'alt'),
        url: str(attrs, 'url'),
        title: str(attrs, 'title'),
        description: str(attrs, 'description'),
    };
}

function noteLinkAttrs(attrs: Attrs) {
    return {
        note: str(attrs, 'note'),
        section: str(attrs, 'section'),
        heading: str(attrs, 'heading'),
        label: str(attrs, 'label'),
    };
}

/** All the text under a node: inline runs joined directly, blocks with a space. */
function plainText(node: PMNode): string {
    if (typeof node.text === 'string') return node.text;
    if (node.type === 'hardBreak') return ' ';
    const kids = node.content ?? [];
    return kids.map(plainText).join(kids.some(isInline) ? '' : ' ');
}

function isInline(node: PMNode): boolean {
    return INLINE.has(node.type) || typeof node.text === 'string';
}

/** An unknown node whose children are inline, which we export like a paragraph. */
function holdsInline(node: PMNode): boolean {
    return (node.content ?? []).some(isInline);
}

function firstBlock(doc: PMNode): PMNode | undefined {
    return (doc.content ?? []).find((n) => !(n.type === 'paragraph' && !plainText(n).trim()));
}

function startsWithTitle(doc: PMNode, title: string): boolean {
    const first = firstBlock(doc);
    return first?.type === 'heading' && num(first.attrs, 'level', 1) === 1 && plainText(first).trim() === title.trim();
}

function firstHeading(doc: PMNode): string {
    const first = firstBlock(doc);
    return first?.type === 'heading' ? plainText(first).trim() : '';
}

/** Turns runs of stray inline nodes among blocks into paragraphs. */
function asBlocks(nodes: PMNode[]): PMNode[] {
    const out: PMNode[] = [];
    let run: PMNode[] | null = null;
    for (const node of nodes) {
        if (isInline(node)) {
            if (!run) out.push({ type: 'paragraph', content: (run = []) });
            run.push(node);
        } else {
            run = null;
            out.push(node);
        }
    }
    return out;
}

/** Whether an href may be emitted: 'empty', 'unsafe' (a scheme we don't allow), or 'safe'. */
function hrefKind(href: string): 'empty' | 'unsafe' | 'safe' {
    // Browsers ignore tabs and newlines inside URLs and leading controls, so `java\tscript:` is still javascript:.
    const s = href.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '');
    if (!s) return 'empty';
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
    if (!scheme) return 'safe';
    return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? 'safe' : 'unsafe';
}

function linkHref(mark: PMMark): string {
    return str(mark.attrs, 'href').trim();
}

function sameMark(a: PMMark, b: PMMark): boolean {
    return a.type === b.type && (a.type !== 'link' || linkHref(a) === linkHref(b));
}

/** Inline content as a tree of marks, so each mark opens and closes once around a run. */
type Inline = { leaf: PMNode } | { mark: PMMark; kids: Inline[] };

function markTree(nodes: PMNode[], order: string[], keep: (mark: PMMark) => boolean): Inline[] {
    const root: Inline[] = [];
    const open: { mark: PMMark; kids: Inline[] }[] = [];
    for (const node of nodes) {
        const marks: PMMark[] = [];
        for (const mark of node.marks ?? []) {
            if (!keep(mark) || marks.some((m) => m.type === mark.type)) continue;
            marks.push(mark);
        }
        marks.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
        let same = 0;
        while (same < open.length && same < marks.length && sameMark(open[same].mark, marks[same])) same++;
        open.length = same;
        for (const mark of marks.slice(same)) {
            const wrap = { mark, kids: [] as Inline[] };
            (open.length ? open[open.length - 1].kids : root).push(wrap);
            open.push(wrap);
        }
        (open.length ? open[open.length - 1].kids : root).push({ leaf: node });
    }
    return root;
}

class Writer {
    readonly lost = new Set<string>();
    constructor(protected ctx: ExportContext) {}

    unknown(node: PMNode): void {
        const kept = plainText(node).trim() ? 'text kept' : 'left out';
        this.lost.add(`Unsupported content "${node.type}" (${kept})`);
    }

    /** Keeps a mark if `supported` lists it; links only with a safe href. */
    keepMark(mark: PMMark, supported: string[]): boolean {
        if (mark.type === 'link') {
            const kind = hrefKind(linkHref(mark));
            if (kind === 'unsafe') this.lost.add(LOST.unsafe);
            return kind === 'safe';
        }
        if (supported.includes(mark.type)) return true;
        if (mark.type === 'underline') this.lost.add(LOST.underline);
        else if (mark.type === 'highlight') this.lost.add(LOST.highlight);
        else if (!HTML_MARKS.includes(mark.type)) this.lost.add(`Unsupported formatting "${mark.type}" (text kept)`);
        return false;
    }

    /** The href to emit, or null to leave the text unlinked (recording it if it was unsafe). */
    safe(href: string): string | null {
        const kind = hrefKind(href);
        if (kind === 'unsafe') this.lost.add(LOST.unsafe);
        return kind === 'safe' ? href.trim() : null;
    }
}

// ---------------------------------------------------------------------------
// Markdown

/** How a hard break is written: a backslash line break, a space (headings), or `<br>` (table cells). */
type Breaks = 'line' | 'space' | 'br';

function escapeMd(text: string): string {
    return text
        .replace(/\r?\n/g, ' ')
        .replace(/[\\`*_[\]<>~]/g, '\\$&')
        .replace(/&(?=#?[a-z0-9]+;)/gi, '\\&');
}

/** Escapes what would turn a line of paragraph text into a list, heading, rule or code block. */
function escapeLineStarts(text: string): string {
    return text
        .split('\n')
        .map((line) => {
            line = line.replace(/^[ \t]+/, '');
            if (/^#{1,6}([ \t]|$)/.test(line)) return '\\' + line;
            if (/^-([ \t]|$)|^-+[ \t]*$/.test(line) || /^=+[ \t]*$/.test(line)) return '\\' + line;
            if (/^\+([ \t]|$)/.test(line)) return '\\' + line;
            return line.replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2');
        })
        .join('\n');
}

/** Percent-encodes what would end or break a link destination. */
function mdDest(href: string): string {
    return href.replace(/[\s()<>\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function codeSpan(raw: string): string {
    const longest = Math.max(0, ...(raw.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad = raw.trim() && /^[` ]|[` ]$/.test(raw) ? ' ' : '';
    return fence + pad + raw + pad + fence;
}

const WORD_END = /[\p{L}\p{N}]$/u;
const WORD_START = /^[\p{L}\p{N}]/u;
const PUNCT_START = /^[\p{P}\p{S}]/u;
const PUNCT_END = /[\p{P}\p{S}]$/u;

function listKind(type: string): 'bullet' | 'ordered' | null {
    return type === 'bulletList' || type === 'checklist' ? 'bullet' : type === 'orderedList' ? 'ordered' : null;
}

class MarkdownWriter extends Writer {
    /**
     * Blocks separated by a blank line. In a list item (`tight`) a list follows a paragraph directly. Adjacent
     * lists of the same kind switch marker (`-`/`*`, `.`/`)`) so they don't merge into one.
     */
    blocks(nodes: PMNode[], tight = false): string {
        let out = '';
        let prev: PMNode | null = null;
        let lastKind: string | null = null;
        let lastAlt = false;
        for (const node of asBlocks(nodes)) {
            const kind = listKind(node.type);
            const alt: boolean = !!kind && lastKind === kind && !lastAlt;
            const text = this.block(node, alt);
            if (!text) continue;
            // Only a bullet list or a list starting at 1 may interrupt a paragraph.
            const interrupts = kind === 'bullet' || (kind === 'ordered' && num(node.attrs, 'start', 1) === 1);
            if (prev) out += tight && interrupts && prev.type === 'paragraph' ? '\n' : '\n\n';
            out += text;
            prev = node;
            lastKind = kind;
            lastAlt = alt;
        }
        return out;
    }

    block(node: PMNode, alt: boolean): string {
        const a = node.attrs;
        switch (node.type) {
            case 'paragraph':
                return escapeLineStarts(this.inline(node.content ?? [], 'line'));
            case 'heading': {
                const text = this.headingText(escapeLineStarts(this.inline(node.content ?? [], 'space')).trimEnd());
                const level = Math.min(6, Math.max(1, Math.floor(num(a, 'level', 1))));
                return text.trim() ? `${'#'.repeat(level)} ${text}` : '';
            }
            case 'blockquote': {
                const inner = this.blocks(node.content ?? []);
                return inner && inner.replace(/^(.?)/gm, (_, c: string) => (c ? '> ' + c : '>'));
            }
            case 'codeBlock': {
                const code = (node.content ?? []).map(plainText).join('');
                const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
                const fence = '`'.repeat(Math.max(3, longest + 1));
                const lang = str(a, 'language').replace(/[\s`]/g, '');
                return `${fence}${lang}\n${code}${code && !code.endsWith('\n') ? '\n' : ''}${fence}`;
            }
            case 'horizontalRule':
                return '---';
            case 'bulletList':
                return (node.content ?? []).map((li) => this.item(li, alt ? '*' : '-')).join('\n');
            case 'orderedList': {
                const start = Math.max(0, Math.floor(num(a, 'start', 1)));
                return (node.content ?? []).map((li, i) => this.item(li, `${start + i}${alt ? ')' : '.'}`)).join('\n');
            }
            case 'listItem':
                return this.item(node, '-');
            case 'table':
                return this.table(node);
            case 'checklist': {
                const marker = alt ? '*' : '-';
                return this.ctx
                    .checklist(str(a, 'list'))
                    .map((it) => `${marker} [${it.checked ? 'x' : ' '}] ${escapeMd(it.text)}`.trimEnd())
                    .join('\n');
            }
            case 'ink': {
                const strokes = str(a, 'strokes');
                if (this.ctx.inkSvg(strokes) === null) return '';
                this.lost.add(LOST.ink);
                return `![Drawing](${mdDest(this.ctx.inkPath(strokes))})`;
            }
            case 'attachment':
                return this.attachment(attachmentAttrs(a));
            case 'tableRow':
            case 'tableHeader':
            case 'tableCell':
                return this.blocks(node.content ?? []);
            default:
                this.unknown(node);
                if (holdsInline(node)) return escapeLineStarts(this.inline(node.content ?? [], 'line'));
                if (node.content?.length) return this.blocks(node.content);
                return escapeLineStarts(escapeMd(node.text ?? ''));
        }
    }

    /** Escapes a trailing run of `#`s that would read as a closing sequence. */
    headingText(text: string): string {
        return text.replace(/(^|[ \t])(#+[ \t]*)$/, '$1\\$2');
    }

    item(li: PMNode, marker: string): string {
        const kids = li.type === 'listItem' ? (li.content ?? []) : [li];
        const lines = this.blocks(kids, true).split('\n');
        const pad = ' '.repeat(marker.length + 1);
        return [
            lines[0] ? `${marker} ${lines[0]}` : marker,
            ...lines.slice(1).map((line) => (line ? pad + line : '')),
        ].join('\n');
    }

    table(node: PMNode): string {
        const rows = (node.content ?? []).filter((row) => row.content?.length);
        const grid: string[][] = rows.map(() => []);
        rows.forEach((row, r) => {
            let c = 0;
            for (const cell of row.content ?? []) {
                while (grid[r][c] !== undefined) c++;
                const cols = Math.max(1, Math.floor(num(cell.attrs, 'colspan', 1)));
                const span = Math.max(1, Math.floor(num(cell.attrs, 'rowspan', 1)));
                if (cols > 1 || span > 1) this.lost.add(LOST.merged);
                for (let dr = 0; dr < span && r + dr < rows.length; dr++) {
                    for (let dc = 0; dc < cols; dc++) grid[r + dr][c + dc] = dr || dc ? '' : this.cell(cell);
                }
                c += cols;
            }
        });
        const width = Math.max(0, ...grid.map((row) => row.length));
        if (!width) return '';
        const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
        return [line(grid[0]), line(Array(width).fill('---')), ...grid.slice(1).map(line)].join('\n');
    }

    cell(cell: PMNode): string {
        return (cell.content ?? [])
            .map((b) =>
                b.type === 'paragraph' || b.type === 'heading'
                    ? this.inline(b.content ?? [], 'br')
                    : escapeMd(plainText(b)),
            )
            .map((s) => s.trim())
            .filter(Boolean)
            .join('<br>')
            .replace(/\|/g, '\\|');
    }

    attachment(at: AttachmentAttrs): string {
        if (at.kind === 'link') {
            const label = escapeMd(at.title || at.url || 'Link');
            const href = this.safe(at.url);
            const link = href ? `[${label}](${mdDest(href)})` : escapeLineStarts(label);
            return at.description ? `${link}\n\n${escapeLineStarts(escapeMd(at.description))}` : link;
        }
        const path = mdDest(this.ctx.attachmentPath(at));
        if (at.kind === 'image') return `![${escapeMd(at.alt || at.name || 'Image')}](${path})`;
        return `[${escapeMd(at.name || 'Attachment')}](${path})`;
    }

    inline(nodes: PMNode[], breaks: Breaks): string {
        return this.inlines(
            markTree(nodes, MD_MARKS, (m) => this.keepMark(m, MD_MARKS)),
            breaks,
        );
    }

    inlines(items: Inline[], breaks: Breaks): string {
        let out = '';
        items.forEach((item, i) => {
            const piece = 'leaf' in item ? this.leaf(item.leaf, breaks) : this.wrap(item, breaks, out, items[i + 1]);
            // `!` right before a link would make it an image.
            if (piece.startsWith('[') && out.endsWith('!')) out = out.slice(0, -1) + '\\!';
            out += piece;
        });
        return out;
    }

    leaf(node: PMNode, breaks: Breaks): string {
        if (node.type === 'text') return escapeMd(node.text ?? '');
        if (node.type === 'hardBreak') return breaks === 'line' ? '\\\n' : breaks === 'br' ? '<br>' : ' ';
        if (node.type === 'noteLink') {
            const link = this.ctx.noteLink(noteLinkAttrs(node.attrs));
            const text = escapeMd(link.text || str(node.attrs, 'label') || 'Note');
            const href = this.safe(link.href);
            return href ? `[${text}](${mdDest(href)})` : text;
        }
        this.unknown(node);
        return escapeMd(plainText(node));
    }

    wrap(item: { mark: PMMark; kids: Inline[] }, breaks: Breaks, before: string, next: Inline | undefined): string {
        const type = item.mark.type;
        if (type === 'code') {
            const raw = item.kids.map((k) => ('leaf' in k ? plainText(k.leaf) : '')).join('');
            return raw ? codeSpan(raw) : '';
        }
        // Delimiters can't sit against whitespace, so leading and trailing spaces (and line breaks) move outside.
        const [, pre, body, post] = /^([ \t]*)([\s\S]*?)((?:[ \t]|\\\n)*)$/.exec(this.inlines(item.kids, breaks))!;
        if (type === 'link') {
            return `${pre}[${body || escapeMd(linkHref(item.mark))}](${mdDest(linkHref(item.mark))})${post}`;
        }
        if (!body) return pre + post;
        const wordBefore = !pre && WORD_END.test(before);
        const wordAfter =
            !post && !!next && 'leaf' in next && next.leaf.type === 'text' && WORD_START.test(next.leaf.text ?? '');
        // Against a word, a delimiter next to punctuation can't open (`a**"b"**`) or close (`**"b"**c`): use HTML.
        if ((wordBefore && PUNCT_START.test(body)) || (wordAfter && PUNCT_END.test(body))) {
            const tag = type === 'bold' ? 'strong' : type === 'strike' ? 'del' : 'em';
            return `${pre}<${tag}>${body}</${tag}>${post}`;
        }
        // `_` doesn't work inside a word; `*` does.
        const delim = type === 'bold' ? '**' : type === 'strike' ? '~~' : wordBefore || wordAfter ? '*' : '_';
        return pre + delim + body + delim + post;
    }
}

// ---------------------------------------------------------------------------
// HTML

function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`);
}

function humanSize(bytes: number): string {
    if (!(bytes > 0)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (unit < units.length - 1 && Math.round(value) >= 1000) {
        value /= 1000;
        unit++;
    }
    const shown = unit && value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
    return `${shown} ${units[unit]}`;
}

function urlHost(url: string): string {
    const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/?#:]+)/i.exec(url.trim());
    return m ? m[1].replace(/^www\./i, '') : '';
}

class HtmlWriter extends Writer {
    blocks(nodes: PMNode[]): string {
        return asBlocks(nodes)
            .map((node) => this.block(node))
            .filter(Boolean)
            .join('\n');
    }

    block(node: PMNode): string {
        const a = node.attrs;
        switch (node.type) {
            case 'paragraph': {
                const inner = this.inline(node.content ?? []);
                return inner && `<p>${inner}</p>`;
            }
            case 'heading': {
                const inner = this.inline(node.content ?? []);
                const level = Math.min(6, Math.max(1, Math.floor(num(a, 'level', 1))));
                const section = str(a, 'section');
                const id = section ? ` id="section-${escapeHtml(section)}"` : '';
                return inner && `<h${level}${id}>${inner}</h${level}>`;
            }
            case 'blockquote': {
                const inner = this.blocks(node.content ?? []);
                return inner && `<blockquote>\n${inner}\n</blockquote>`;
            }
            case 'codeBlock': {
                const lang = str(a, 'language').trim();
                const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
                return `<pre><code${cls}>${escapeHtml((node.content ?? []).map(plainText).join(''))}</code></pre>`;
            }
            case 'horizontalRule':
                return '<hr>';
            case 'bulletList':
                return `<ul>\n${this.items(node)}\n</ul>`;
            case 'orderedList': {
                const start = Math.max(0, Math.floor(num(a, 'start', 1)));
                return `<ol${start === 1 ? '' : ` start="${start}"`}>\n${this.items(node)}\n</ol>`;
            }
            case 'listItem':
                return `<ul>\n${this.item(node)}\n</ul>`;
            case 'table':
                return this.table(node);
            case 'checklist': {
                const items = this.ctx.checklist(str(a, 'list'));
                if (!items.length) return '';
                const lis = items.map(
                    (it) =>
                        `<li${it.checked ? ' class="done"' : ''}><input type="checkbox" disabled${it.checked ? ' checked' : ''}> ${escapeHtml(it.text)}</li>`,
                );
                return `<ul class="checklist">\n${lis.join('\n')}\n</ul>`;
            }
            case 'ink': {
                const svg = this.ctx.inkSvg(str(a, 'strokes'));
                if (svg === null) return '';
                const inline = svg
                    .replace(/^\s*<\?xml[\s\S]*?\?>/i, '')
                    .replace(/^\s*<!doctype[^>]*>/i, '')
                    .trim();
                return `<figure class="drawing">${inline}</figure>`;
            }
            case 'attachment':
                return this.attachment(attachmentAttrs(a));
            case 'tableRow':
            case 'tableHeader':
            case 'tableCell':
                return this.blocks(node.content ?? []);
            default: {
                this.unknown(node);
                if (holdsInline(node)) {
                    const inner = this.inline(node.content ?? []);
                    return inner && `<p>${inner}</p>`;
                }
                if (node.content?.length) return this.blocks(node.content);
                return node.text ? `<p>${escapeHtml(node.text)}</p>` : '';
            }
        }
    }

    items(list: PMNode): string {
        return (list.content ?? []).map((li) => this.item(li)).join('\n');
    }

    /** A list item; its paragraph sits directly in the `<li>` when it has just one. */
    item(li: PMNode): string {
        return `<li>${this.flow(li.content ?? [])}</li>`;
    }

    /** Block content of a list item or table cell, with a lone paragraph unwrapped. */
    flow(kids: PMNode[]): string {
        const blocks = asBlocks(kids);
        const paragraphs = blocks.filter((b) => b.type === 'paragraph');
        if (paragraphs.length === 1 && blocks[0] === paragraphs[0]) {
            const rest = this.blocks(blocks.slice(1));
            const first = this.inline(blocks[0].content ?? []);
            return rest ? `${first}\n${rest}` : first;
        }
        return this.blocks(blocks);
    }

    table(node: PMNode): string {
        const rows = (node.content ?? []).filter((row) => row.content?.length);
        if (!rows.length) return '';
        const tr = (row: PMNode) =>
            '<tr>' +
            (row.content ?? [])
                .map((cell) => {
                    const tag = cell.type === 'tableHeader' ? 'th' : 'td';
                    const cols = Math.floor(num(cell.attrs, 'colspan', 1));
                    const span = Math.floor(num(cell.attrs, 'rowspan', 1));
                    const attrs = (cols > 1 ? ` colspan="${cols}"` : '') + (span > 1 ? ` rowspan="${span}"` : '');
                    return `<${tag}${attrs}>${this.flow(cell.content ?? [])}</${tag}>`;
                })
                .join('') +
            '</tr>';
        const headed = (rows[0].content ?? []).every((cell) => cell.type === 'tableHeader');
        const head = headed ? `<thead>\n${tr(rows[0])}\n</thead>\n` : '';
        const body = (headed ? rows.slice(1) : rows).map(tr).join('\n');
        return `<table>\n${head}${body ? `<tbody>\n${body}\n</tbody>\n` : ''}</table>`;
    }

    attachment(at: AttachmentAttrs): string {
        if (at.kind === 'link') {
            const title = escapeHtml(at.title || at.url || 'Link');
            const description = at.description ? escapeHtml(at.description) : '';
            const href = this.safe(at.url);
            if (!href) return `<p>${title}</p>` + (description ? `\n<p>${description}</p>` : '');
            const host = urlHost(href);
            return (
                `<a class="card" href="${escapeHtml(href)}">` +
                `<span class="card-title">${title}</span>` +
                (description ? `<span class="card-description">${description}</span>` : '') +
                (host ? `<span class="card-host">${escapeHtml(host)}</span>` : '') +
                '</a>'
            );
        }
        const name = escapeHtml(at.name || (at.kind === 'image' ? 'Image' : 'Attachment'));
        const path = this.safe(this.ctx.attachmentPath(at));
        if (!path) return `<p class="file">${name}</p>`;
        const src = escapeHtml(path);
        if (at.kind === 'image') {
            const size =
                (at.width > 0 ? ` width="${Math.round(at.width)}"` : '') +
                (at.height > 0 ? ` height="${Math.round(at.height)}"` : '');
            return `<figure class="image"><img src="${src}" alt="${escapeHtml(at.alt || at.name)}"${size}></figure>`;
        }
        if (at.kind === 'video') {
            return `<figure class="video"><video controls preload="metadata" src="${src}"><a href="${src}">${name}</a></video></figure>`;
        }
        const size = humanSize(at.size);
        return `<p class="file"><a href="${src}">${name}</a>${size ? ` <span class="size">(${size})</span>` : ''}</p>`;
    }

    inline(nodes: PMNode[]): string {
        return this.inlines(markTree(nodes, HTML_MARKS, (m) => this.keepMark(m, HTML_MARKS)));
    }

    inlines(items: Inline[]): string {
        return items
            .map((item) => {
                if ('leaf' in item) return this.leaf(item.leaf);
                const inner = this.inlines(item.kids);
                if (item.mark.type === 'link') return `<a href="${escapeHtml(linkHref(item.mark))}">${inner}</a>`;
                const tag = HTML_TAGS[item.mark.type];
                return `<${tag}>${inner}</${tag}>`;
            })
            .join('');
    }

    leaf(node: PMNode): string {
        if (node.type === 'text') return escapeHtml(node.text ?? '');
        if (node.type === 'hardBreak') return '<br>';
        if (node.type === 'noteLink') {
            const link = this.ctx.noteLink(noteLinkAttrs(node.attrs));
            const text = escapeHtml(link.text || str(node.attrs, 'label') || 'Note');
            const href = this.safe(link.href);
            return href ? `<a class="note-link" href="${escapeHtml(href)}">${text}</a>` : text;
        }
        this.unknown(node);
        return escapeHtml(plainText(node));
    }
}

const CSS = `:root { color-scheme: light; }
body { margin: 0 auto; max-width: 42rem; padding: 2rem 1rem; background: #fff; color: #1f2328;
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; }
a { color: #0b57d0; }
blockquote { margin: 1em 0; padding: 0 1em; border-left: 3px solid #d0d7de; color: #57606a; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
:not(pre) > code { background: #f6f8fa; padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: #f6f8fa; padding: 0.75em 1em; border-radius: 6px; overflow-x: auto; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #d0d7de; padding: 0.35em 0.6em; text-align: left; vertical-align: top; }
th { background: #f6f8fa; }
li > ul, li > ol { margin: 0.2em 0; }
img, video, svg { max-width: 100%; height: auto; }
figure { margin: 1em 0; }
mark { background: #fff3a3; color: inherit; }
hr { border: 0; border-top: 1px solid #d0d7de; margin: 2em 0; }
ul.checklist { list-style: none; padding-left: 0.25em; }
.checklist li { margin: 0.2em 0; }
.checklist input { margin: 0 0.5em 0 0; vertical-align: middle; }
.checklist .done { color: #57606a; }
.file .size, .card-host { color: #57606a; }
a.card { display: block; margin: 1em 0; padding: 0.75em 1em; border: 1px solid #d0d7de; border-radius: 8px;
  color: inherit; text-decoration: none; }
.card span { display: block; }
.card-title { font-weight: 600; color: #0b57d0; }
.card-host { font-size: 0.85em; }
@page { margin: 18mm; }
@media print {
  body { max-width: none; padding: 0; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  a, .card-title { color: #0b57d0; }
  img, figure, table tr, pre, .checklist li { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
}`;
