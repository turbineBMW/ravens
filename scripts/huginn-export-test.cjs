// Tests for Huginn's note export (Markdown and standalone HTML), without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

const source = fs.readFileSync('huginn/web/src/lib/exportNote.ts', 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const lib = { exports: {} };
new Function('require', 'exports', compiled)(require, lib.exports);
const { toMarkdown, toHtml } = lib.exports;

// Builders for ProseMirror JSON.
const mark = (m) => (typeof m === 'string' ? { type: m } : m);
const t = (text, ...marks) => (marks.length ? { type: 'text', text, marks: marks.map(mark) } : { type: 'text', text });
const link = (href) => ({ type: 'link', attrs: { href } });
const br = { type: 'hardBreak' };
const p = (...content) => ({ type: 'paragraph', content });
const h = (level, text, section = '') => ({ type: 'heading', attrs: { level, section }, content: [t(text)] });
const li = (...content) => ({ type: 'listItem', content });
const ul = (...items) => ({ type: 'bulletList', content: items });
const ol = (start, ...items) => ({ type: 'orderedList', attrs: { start }, content: items });
const quote = (...content) => ({ type: 'blockquote', content });
const doc = (...content) => ({ type: 'doc', content });
const cell = (type, text, attrs = {}) => ({ type, attrs: { colspan: 1, rowspan: 1, ...attrs }, content: [p(t(text))] });
const row = (...cells) => ({ type: 'tableRow', content: cells });
const attachment = (attrs) => ({
    type: 'attachment',
    attrs: {
        blob: 'b1',
        kind: 'file',
        name: '',
        type: '',
        size: 0,
        width: 0,
        height: 0,
        thumb: '',
        alt: '',
        url: '',
        title: '',
        description: '',
        ...attrs,
    },
});

const SVG =
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';
const calls = { attachmentPath: [], noteLink: [] };
const ctx = {
    checklist: (list) =>
        ({
            groceries: [
                { text: 'Milk *2*', checked: false },
                { text: 'Eggs', checked: true },
            ],
        })[list] ?? [],
    inkSvg: (strokes) => (strokes === 'empty' ? null : SVG),
    inkPath: (strokes) => `drawings/${strokes}.svg`,
    noteLink: (attrs) => {
        calls.noteLink.push(attrs);
        if (attrs.note === 'evil') return { text: attrs.label, href: 'javascript:alert(1)' };
        return { text: attrs.label || attrs.heading, href: `Other note.md${attrs.section ? '#' + attrs.section : ''}` };
    },
    attachmentPath: (attrs) => {
        calls.attachmentPath.push(attrs);
        return `attachments/${attrs.name}`;
    },
};
const md = (d, title = '') => toMarkdown(d, title, ctx);
const html = (d, title = '') => toHtml(d, title, ctx);
/** The HTML document's body content, between <article> and </article>. */
const body = (d, title = '') => {
    const out = html(d, title);
    return { text: /<article>\n([\s\S]*)\n<\/article>/.exec(out.text)[1], lost: out.lost };
};
const LOST = {
    underline: 'Underline (kept as plain text)',
    highlight: 'Highlights (kept as plain text)',
    merged: 'Merged table cells (split)',
    ink: 'Drawings (exported as images, no longer editable)',
    unsafe: 'Unsafe links (kept as text)',
};
let checks = 0;
const test = (name, fn) => {
    try {
        fn();
        checks++;
    } catch (err) {
        console.error(`FAIL: ${name}`);
        throw err;
    }
};

// --- Markdown -----------------------------------------------------------

test('empty doc', () => {
    assert.deepEqual(md(doc()), { text: '\n', lost: [] });
    assert.deepEqual(md({ type: 'doc' }, 'Title'), { text: '# Title\n', lost: [] });
});

test('paragraphs, headings, rule, block separation', () => {
    const out = md(
        doc(h(1, 'One', 's1'), p(t('First')), p(), h(2, 'Two'), h(3, 'Three'), { type: 'horizontalRule' }, p(t('End'))),
    );
    assert.equal(out.text, '# One\n\nFirst\n\n## Two\n\n### Three\n\n---\n\nEnd\n');
    assert.deepEqual(out.lost, []);
});

test('title is added, or not when the body starts with it', () => {
    assert.equal(md(doc(p(t('Body'))), 'My note').text, '# My note\n\nBody\n');
    assert.equal(md(doc(h(1, 'My note'), p(t('Body'))), 'My note').text, '# My note\n\nBody\n');
    // Leading empty paragraphs don't count; whitespace around the title doesn't matter.
    assert.equal(md(doc(p(), h(1, ' My note '), p(t('Body'))), 'My note ').text, '# My note\n\nBody\n');
    // A different heading, or the same text at level 2, keeps the title.
    assert.equal(md(doc(h(1, 'Other')), 'My note').text, '# My note\n\n# Other\n');
    assert.equal(md(doc(h(2, 'My note')), 'My note').text, '# My note\n\n## My note\n');
    assert.equal(md(doc(p(t('x'))), '  ').text, 'x\n');
    // The title is escaped like any heading.
    assert.equal(md(doc(), 'C# *notes* #').text, '# C# \\*notes\\* \\#\n');
});

test('marks', () => {
    const out = md(
        doc(
            p(
                t('b', 'bold'),
                t(' '),
                t('i', 'italic'),
                t(' '),
                t('s', 'strike'),
                t(' '),
                t('c', 'code'),
                t(' '),
                t('l', link('https://example.com/')),
                t(' '),
                t('u', 'underline'),
                t(' '),
                t('h', 'highlight'),
            ),
        ),
    );
    assert.equal(out.text, '**b** _i_ ~~s~~ `c` [l](https://example.com/) u h\n');
    assert.deepEqual(out.lost, [LOST.underline, LOST.highlight]);
});

test('nested and overlapping marks', () => {
    // Bold over "bold both", italic over "both it": one bold run with italic inside, then italic again.
    const out = md(doc(p(t('bold ', 'bold'), t('both', 'bold', 'italic'), t(' it', 'italic'))));
    assert.equal(out.text, '**bold _both_** _it_\n');
    // Marks inside a link, a code span inside bold.
    assert.equal(
        md(doc(p(t('a ', link('https://x.y')), t('b', link('https://x.y'), 'bold'), t('c', 'bold', 'code')))).text,
        '[a **b**](https://x.y)**`c`**\n',
    );
    // Adjacent links with different hrefs stay separate.
    assert.equal(
        md(doc(p(t('a', link('https://a')), t('b', link('https://b'))))).text,
        '[a](https://a)[b](https://b)\n',
    );
});

test('whitespace moves outside delimiters; mid-word italic uses *', () => {
    assert.equal(md(doc(p(t('a'), t(' bold ', 'bold'), t('b')))).text, 'a **bold** b\n');
    assert.equal(md(doc(p(t('un'), t('believ', 'italic'), t('able')))).text, 'un*believ*able\n');
    assert.equal(md(doc(p(t('   ', 'bold'), t('x')))).text, 'x\n');
    // Punctuation against a word stops a delimiter opening or closing, so those runs use HTML tags.
    assert.equal(md(doc(p(t('"quoted"', 'bold'), t('after')))).text, '<strong>"quoted"</strong>after\n');
    assert.equal(md(doc(p(t('x'), t('(y)', 'italic')))).text, 'x<em>(y)</em>\n');
    assert.equal(md(doc(p(t('x '), t('(y)', 'strike'), t(' z')))).text, 'x ~~(y)~~ z\n');
});

test('code spans pick a longer fence', () => {
    assert.equal(md(doc(p(t('a`b', 'code')))).text, '``a`b``\n');
    assert.equal(md(doc(p(t('``x', 'code')))).text, '``` ``x ```\n');
    assert.equal(md(doc(p(t('*not_escaped*', 'code')))).text, '`*not_escaped*`\n');
});

test('links: destinations are encoded, empty text uses the href, ! before a link', () => {
    assert.equal(
        md(doc(p(t('report', link('files/my report (1).pdf'))))).text,
        '[report](files/my%20report%20%281%29.pdf)\n',
    );
    assert.equal(md(doc(p(t('Wow!'), t('see', link('https://x.y'))))).text, 'Wow\\![see](https://x.y)\n');
    const unsafe = md(doc(p(t('click', link('javascript:alert(1)')))));
    assert.deepEqual(unsafe, { text: 'click\n', lost: [LOST.unsafe] });
    // A link mark with no href is just text, and nothing is lost.
    assert.deepEqual(md(doc(p(t('x', link(''))))), { text: 'x\n', lost: [] });
});

test('escaping keeps plain text plain', () => {
    const text = 'a*b_c [d] #e | <f> & `g` \\h ~i~ &amp; 2*3=6';
    const out = md(doc(p(t(text)), p(t('1. not a list')), p(t('# not a heading')), p(t('#hashtag stays'))));
    assert.equal(
        out.text,
        'a\\*b\\_c \\[d\\] #e | \\<f\\> & \\`g\\` \\\\h \\~i\\~ \\&amp; 2\\*3=6\n\n' +
            '1\\. not a list\n\n' +
            '\\# not a heading\n\n' +
            '#hashtag stays\n',
    );
    assert.deepEqual(out.lost, []);
    // List, rule and setext markers at line starts, including after a hard break.
    assert.equal(
        md(doc(p(t('- a')), p(t('+ b')), p(t('---')), p(t('x'), br, t('==')), p(t('3) c')), p(t('-dash')))).text,
        '\\- a\n\n\\+ b\n\n\\---\n\nx\\\n\\==\n\n3\\) c\n\n-dash\n',
    );
    // Leading spaces would make an indented code block.
    assert.equal(md(doc(p(t('    indented')))).text, 'indented\n');
    // A heading ending in #s would lose them as a closing sequence.
    assert.equal(md(doc(h(2, 'Issue #'))).text, '## Issue \\#\n');
    assert.equal(md(doc(h(2, 'C#'))).text, '## C#\n');
});

test('hard breaks', () => {
    assert.equal(md(doc(p(t('one'), br, t('two')))).text, 'one\\\ntwo\n');
    assert.equal(md(doc({ type: 'heading', attrs: { level: 2 }, content: [t('a'), br, t('b')] })).text, '## a b\n');
    // A break at the end of a bold run moves outside it.
    assert.equal(
        md(doc(p(t('one', 'bold'), { type: 'hardBreak', marks: [{ type: 'bold' }] }, t('two')))).text,
        '**one**\\\ntwo\n',
    );
});

test('lists, nesting, start', () => {
    const out = md(
        doc(
            ul(li(p(t('a')), ul(li(p(t('a1'))), li(p(t('a2')), ol(1, li(p(t('deep'))))))), li(p(t('b')))),
            ol(7, li(p(t('seven'))), li(p(t('eight'))), li(p(t('nine'))), li(p(t('ten')), p(t('second para')))),
        ),
    );
    assert.equal(
        out.text,
        '- a\n' +
            '  - a1\n' +
            '  - a2\n' +
            '    1. deep\n' +
            '- b\n' +
            '\n' +
            '7. seven\n' +
            '8. eight\n' +
            '9. nine\n' +
            '10. ten\n' +
            '\n' +
            '    second para\n',
    );
    // A nested list not starting at 1 can't interrupt a paragraph, so a blank line comes first.
    assert.equal(md(doc(ul(li(p(t('a')), ol(3, li(p(t('c')))))))).text, '- a\n\n  3. c\n');
    // Adjacent lists of the same kind switch marker so they stay two lists.
    assert.equal(
        md(
            doc(
                ul(li(p(t('a')))),
                ul(li(p(t('b')))),
                p(),
                ul(li(p(t('c')))),
                ol(1, li(p(t('d')))),
                ol(1, li(p(t('e')))),
            ),
        ).text,
        '- a\n\n* b\n\n- c\n\n1. d\n\n1) e\n',
    );
    // An empty item, and a code block in an item.
    assert.equal(
        md(doc(ul(li(p()), li({ type: 'codeBlock', attrs: { language: null }, content: [t('x\n\ny')] })))).text,
        '-\n- ```\n  x\n\n  y\n  ```\n',
    );
});

test('blockquotes, with a list inside and a quote in a list', () => {
    assert.equal(
        md(doc(quote(p(t('q1'), br, t('q2')), ul(li(p(t('a')), ul(li(p(t('b'))))))))).text,
        '> q1\\\n> q2\n>\n> - a\n>   - b\n',
    );
    assert.equal(md(doc(ul(li(p(t('a')), quote(p(t('q'))))))).text, '- a\n\n  > q\n');
    assert.equal(md(doc(quote(quote(p(t('deep')))))).text, '> > deep\n');
    assert.equal(md(doc(quote(p()))).text, '\n');
});

test('code blocks', () => {
    assert.equal(
        md(doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;\n*not* _md_')] })).text,
        '```ts\nconst a = 1;\n*not* _md_\n```\n',
    );
    assert.equal(
        md(doc({ type: 'codeBlock', attrs: { language: null }, content: [t('```\nx')] })).text,
        '````\n```\nx\n````\n',
    );
    assert.equal(md(doc({ type: 'codeBlock', attrs: { language: null } })).text, '```\n```\n');
});

test('tables: header row, merged cells, escaping, breaks', () => {
    const table = {
        type: 'table',
        content: [
            row(cell('tableHeader', 'Name'), cell('tableHeader', 'A|B'), cell('tableHeader', 'C')),
            row(cell('tableCell', 'wide', { colspan: 2 }), cell('tableCell', 'tall', { rowspan: 2 })),
            row(
                { type: 'tableCell', attrs: {}, content: [p(t('x'), br, t('y')), p(t('z', 'bold'))] },
                cell('tableCell', 'pipe|code'),
            ),
        ],
    };
    const out = md(doc(table));
    assert.equal(
        out.text,
        '| Name | A\\|B | C |\n' +
            '| --- | --- | --- |\n' +
            '| wide |  | tall |\n' +
            '| x<br>y<br>**z** | pipe\\|code |  |\n',
    );
    assert.deepEqual(out.lost, [LOST.merged]);
    // A first row of plain cells is still the header; code in a cell keeps an escaped pipe.
    const plain = md(
        doc({
            type: 'table',
            content: [
                row(cell('tableCell', 'a'), cell('tableCell', 'b')),
                row({ type: 'tableCell', content: [p(t('|', 'code'))] }),
            ],
        }),
    );
    assert.deepEqual(plain, { text: '| a | b |\n| --- | --- |\n| `\\|` |  |\n', lost: [] });
});

test('checklists', () => {
    assert.equal(md(doc({ type: 'checklist', attrs: { list: 'groceries' } })).text, '- [ ] Milk \\*2\\*\n- [x] Eggs\n');
    assert.equal(md(doc({ type: 'checklist', attrs: { list: 'none' } })).text, '\n');
    // After a bullet list, a checklist switches marker.
    assert.equal(
        md(doc(ul(li(p(t('a')))), { type: 'checklist', attrs: { list: 'groceries' } })).text,
        '- a\n\n* [ ] Milk \\*2\\*\n* [x] Eggs\n',
    );
});

test('ink with and without content', () => {
    assert.deepEqual(md(doc({ type: 'ink', attrs: { strokes: 'sketch1' } })), {
        text: '![Drawing](drawings/sketch1.svg)\n',
        lost: [LOST.ink],
    });
    assert.deepEqual(md(doc({ type: 'ink', attrs: { strokes: 'empty' } }), 'T'), { text: '# T\n', lost: [] });
});

test('note links', () => {
    calls.noteLink.length = 0;
    const out = md(
        doc(
            p(
                t('See '),
                { type: 'noteLink', attrs: { note: 'n1', section: 's2', heading: 'Plans', label: 'the [plan]' } },
                t(' and '),
                {
                    type: 'noteLink',
                    attrs: { note: 'n2', section: '', heading: '', label: 'Other' },
                    marks: [{ type: 'bold' }],
                },
            ),
        ),
    );
    assert.equal(out.text, 'See [the \\[plan\\]](Other%20note.md#s2) and **[Other](Other%20note.md)**\n');
    assert.deepEqual(calls.noteLink[0], { note: 'n1', section: 's2', heading: 'Plans', label: 'the [plan]' });
    assert.deepEqual(md(doc(p({ type: 'noteLink', attrs: { note: 'evil', label: 'Bad' } }))), {
        text: 'Bad\n',
        lost: [LOST.unsafe],
    });
});

test('attachments of every kind', () => {
    calls.attachmentPath.length = 0;
    const out = md(
        doc(
            attachment({ kind: 'image', name: 'cat.png', alt: 'A [cat]', width: 640, height: 480 }),
            attachment({ kind: 'image', name: 'dog.png' }),
            attachment({ kind: 'video', name: 'clip.mp4' }),
            attachment({ kind: 'pdf', name: 'report (final).pdf', size: 1234567 }),
            attachment({ kind: 'file', name: 'notes_v2.txt' }),
            attachment({
                kind: 'link',
                url: 'https://example.com/a',
                title: 'Example *site*',
                description: '1. Great',
            }),
            attachment({ kind: 'link', url: 'https://example.com/b' }),
            attachment({ kind: 'link', url: 'javascript:alert(1)', title: 'Trap' }),
        ),
    );
    assert.equal(
        out.text,
        '![A \\[cat\\]](attachments/cat.png)\n\n' +
            '![dog.png](attachments/dog.png)\n\n' +
            '[clip.mp4](attachments/clip.mp4)\n\n' +
            '[report (final).pdf](attachments/report%20%28final%29.pdf)\n\n' +
            '[notes\\_v2.txt](attachments/notes_v2.txt)\n\n' +
            '[Example \\*site\\*](https://example.com/a)\n\n' +
            '1\\. Great\n\n' +
            '[https://example.com/b](https://example.com/b)\n\n' +
            'Trap\n',
    );
    assert.deepEqual(out.lost, [LOST.unsafe]);
    // The context gets full attrs; link cards don't need a file.
    assert.equal(calls.attachmentPath.length, 5);
    assert.deepEqual(calls.attachmentPath[0], {
        blob: 'b1',
        kind: 'image',
        name: 'cat.png',
        type: '',
        size: 0,
        width: 640,
        height: 480,
        thumb: '',
        alt: 'A [cat]',
        url: '',
        title: '',
        description: '',
    });
    // Missing attrs default rather than throw.
    assert.equal(md(doc({ type: 'attachment' })).text, '[Attachment](attachments/)\n');
});

test('unknown node and mark types', () => {
    const out = md(
        doc(
            { type: 'callout', content: [p(t('inside callout'))] },
            { type: 'aside', content: [t('inline in aside')] },
            { type: 'widget', attrs: { x: 1 } },
            p(t('a '), { type: 'mention', attrs: { id: 'u' }, content: [t('@sam')] }, t(' b', { type: 'sparkle' })),
        ),
    );
    assert.equal(out.text, 'inside callout\n\ninline in aside\n\na @sam b\n');
    assert.deepEqual(out.lost, [
        'Unsupported content "callout" (text kept)',
        'Unsupported content "aside" (text kept)',
        'Unsupported content "widget" (left out)',
        'Unsupported formatting "sparkle" (text kept)',
        'Unsupported content "mention" (text kept)',
    ]);
    // Stray inline nodes at block level become a paragraph.
    assert.equal(md(doc(t('loose'), br, t('text'))).text, 'loose\\\ntext\n');
});

test('lost is deduplicated', () => {
    const out = md(doc(p(t('a', 'underline'), t('b', 'highlight')), p(t('c', 'underline'), t('d', 'highlight'))));
    assert.deepEqual(out.lost, [LOST.underline, LOST.highlight]);
});

// --- HTML ---------------------------------------------------------------

test('HTML document shell', () => {
    const out = html(doc(p(t('Hi'))), 'A <b>&</b> "note"');
    assert.ok(out.text.startsWith('<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n'));
    assert.ok(out.text.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
    assert.ok(out.text.includes('<title>A &lt;b&gt;&amp;&lt;/b&gt; &quot;note&quot;</title>'));
    assert.ok(out.text.includes('<h1 class="title">A &lt;b&gt;&amp;&lt;/b&gt; &quot;note&quot;</h1>\n<p>Hi</p>'));
    assert.ok(out.text.endsWith('</article>\n</body>\n</html>\n'));
    const css = /<style>([\s\S]*)<\/style>/.exec(out.text)[1];
    for (const rule of [
        'max-width: 42rem',
        'system-ui',
        '@page { margin: 18mm; }',
        'img, figure, table tr, pre, .checklist li { break-inside: avoid',
        'break-after: avoid',
        'border: 1px solid',
        'max-width: 100%',
        'mark {',
        '.checklist',
        '@media print',
    ]) {
        assert.ok(css.includes(rule), `CSS has ${rule}`);
    }
    assert.ok(!/serif;|url\(|@import/.test(css.replace('sans-serif', '')), 'no serif font, no external resources');
    assert.ok(!/<script|<link /i.test(out.text));
    assert.deepEqual(out.lost, []);
    // Without a title, the first heading names the page; with none, "Untitled".
    assert.ok(html(doc(h(1, 'Heading'))).text.includes('<title>Heading</title>'));
    assert.ok(html(doc(p(t('x')))).text.includes('<title>Untitled</title>'));
});

test('HTML title deduplication', () => {
    assert.equal(body(doc(h(1, 'Plan', 'h1'), p(t('x'))), 'Plan').text, '<h1 id="section-h1">Plan</h1>\n<p>x</p>');
    assert.equal(body(doc(h(2, 'Plan')), 'Plan').text, '<h1 class="title">Plan</h1>\n<h2>Plan</h2>');
});

test('HTML blocks and marks', () => {
    const out = body(
        doc(
            h(2, 'Two', 'abc"x'),
            h(3, 'Three'),
            p(
                t('b', 'bold'),
                t('i', 'italic'),
                t('u', 'underline'),
                t('s', 'strike'),
                t('h', 'highlight'),
                t('<c>', 'code'),
                t('l', link('https://e.com/?a=1&b=2')),
                br,
                t('a & b < c > d "e"'),
            ),
            p(),
            { type: 'horizontalRule' },
            quote(p(t('q')), ul(li(p(t('qa'))))),
            { type: 'codeBlock', attrs: { language: 'html' }, content: [t('<b>&</b>')] },
            { type: 'codeBlock', attrs: { language: null }, content: [t('x')] },
        ),
    );
    assert.equal(
        out.text,
        [
            '<h2 id="section-abc&quot;x">Two</h2>',
            '<h3>Three</h3>',
            '<p><strong>b</strong><em>i</em><u>u</u><s>s</s><mark>h</mark><code>&lt;c&gt;</code>' +
                '<a href="https://e.com/?a=1&amp;b=2">l</a><br>a &amp; b &lt; c &gt; d &quot;e&quot;</p>',
            '<hr>',
            '<blockquote>\n<p>q</p>\n<ul>\n<li>qa</li>\n</ul>\n</blockquote>',
            '<pre><code class="language-html">&lt;b&gt;&amp;&lt;/b&gt;</code></pre>',
            '<pre><code>x</code></pre>',
        ].join('\n'),
    );
    assert.deepEqual(out.lost, []);
    assert.equal(
        body(doc(p(t('bold ', 'bold'), t('both', 'bold', 'italic'), t(' it', 'italic')))).text,
        '<p><strong>bold <em>both</em></strong><em> it</em></p>',
    );
});

test('HTML lists', () => {
    assert.equal(
        body(doc(ul(li(p(t('a')), ol(3, li(p(t('c'))))), li(p(t('one')), p(t('two')))), ol(1, li(p(t('x')))))).text,
        '<ul>\n<li>a\n<ol start="3">\n<li>c</li>\n</ol></li>\n<li><p>one</p>\n<p>two</p></li>\n</ul>\n<ol>\n<li>x</li>\n</ol>',
    );
});

test('HTML tables keep merged cells', () => {
    const table = {
        type: 'table',
        content: [
            row(cell('tableHeader', 'H1'), cell('tableHeader', 'H2')),
            row(cell('tableCell', 'wide', { colspan: 2 })),
            row(cell('tableCell', 'tall', { rowspan: 2 }), { type: 'tableCell', content: [p(t('a')), p(t('b'))] }),
        ],
    };
    const out = body(doc(table));
    assert.equal(
        out.text,
        '<table>\n<thead>\n<tr><th>H1</th><th>H2</th></tr>\n</thead>\n<tbody>\n' +
            '<tr><td colspan="2">wide</td></tr>\n<tr><td rowspan="2">tall</td><td><p>a</p>\n<p>b</p></td></tr>\n' +
            '</tbody>\n</table>',
    );
    assert.deepEqual(out.lost, []);
    assert.equal(
        body(doc({ type: 'table', content: [row(cell('tableCell', 'x'))] })).text,
        '<table>\n<tbody>\n<tr><td>x</td></tr>\n</tbody>\n</table>',
    );
});

test('HTML checklist and ink', () => {
    const out = body(
        doc(
            { type: 'checklist', attrs: { list: 'groceries' } },
            { type: 'ink', attrs: { strokes: 'sketch1' } },
            { type: 'ink', attrs: { strokes: 'empty' } },
            { type: 'checklist', attrs: { list: 'none' } },
        ),
    );
    assert.equal(
        out.text,
        '<ul class="checklist">\n<li><input type="checkbox" disabled> Milk *2*</li>\n' +
            '<li class="done"><input type="checkbox" disabled checked> Eggs</li>\n</ul>\n' +
            '<figure class="drawing"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg></figure>',
    );
    assert.deepEqual(out.lost, []);
});

test('HTML note links', () => {
    const out = body(doc(p({ type: 'noteLink', attrs: { note: 'n1', section: 's"1', heading: 'H', label: 'A <b>' } })));
    assert.equal(out.text, '<p><a class="note-link" href="Other note.md#s&quot;1">A &lt;b&gt;</a></p>');
    assert.deepEqual(body(doc(p({ type: 'noteLink', attrs: { note: 'evil', label: 'Bad' } }))), {
        text: '<p>Bad</p>',
        lost: [LOST.unsafe],
    });
});

test('HTML attachments of every kind', () => {
    const out = body(
        doc(
            attachment({ kind: 'image', name: 'cat.png', alt: 'A "cat"', width: 640, height: 480 }),
            attachment({ kind: 'image', name: 'dog.png' }),
            attachment({ kind: 'video', name: 'clip.mp4' }),
            attachment({ kind: 'pdf', name: 'report.pdf', size: 1234567 }),
            attachment({ kind: 'file', name: 'a&b.txt', size: 999 }),
            attachment({ kind: 'file', name: 'big.iso', size: 4.2e9 }),
            attachment({ kind: 'file', name: 'empty.txt' }),
            attachment({
                kind: 'link',
                url: 'https://www.example.com/a?b',
                title: 'Ex <1>',
                description: 'Desc & more',
            }),
            attachment({ kind: 'link', url: 'mailto:me@example.com' }),
        ),
    );
    assert.equal(
        out.text,
        [
            '<figure class="image"><img src="attachments/cat.png" alt="A &quot;cat&quot;" width="640" height="480"></figure>',
            '<figure class="image"><img src="attachments/dog.png" alt="dog.png"></figure>',
            '<figure class="video"><video controls preload="metadata" src="attachments/clip.mp4"><a href="attachments/clip.mp4">clip.mp4</a></video></figure>',
            '<p class="file"><a href="attachments/report.pdf">report.pdf</a> <span class="size">(1.2 MB)</span></p>',
            '<p class="file"><a href="attachments/a&amp;b.txt">a&amp;b.txt</a> <span class="size">(999 B)</span></p>',
            '<p class="file"><a href="attachments/big.iso">big.iso</a> <span class="size">(4.2 GB)</span></p>',
            '<p class="file"><a href="attachments/empty.txt">empty.txt</a></p>',
            '<a class="card" href="https://www.example.com/a?b"><span class="card-title">Ex &lt;1&gt;</span>' +
                '<span class="card-description">Desc &amp; more</span><span class="card-host">example.com</span></a>',
            '<a class="card" href="mailto:me@example.com"><span class="card-title">mailto:me@example.com</span></a>',
        ].join('\n'),
    );
    assert.deepEqual(out.lost, []);
});

test('HTML drops unsafe links', () => {
    const out = body(
        doc(
            p(t('one', link('javascript:alert(1)'))),
            p(t('two', link(' JaVa\tScRipt:alert(1)'))),
            p(t('three', link('data:text/html,<script>alert(1)</script>'))),
            p(t('four', link('vbscript:x'))),
            attachment({ kind: 'link', url: 'javascript:alert(2)', title: 'Trap', description: 'd' }),
            p(t('ok', link('tel:+15551234')), t(' '), t('rel', link('../x.md#y')), t(' '), t('frag', link('#s'))),
        ),
    );
    assert.equal(
        out.text,
        '<p>one</p>\n<p>two</p>\n<p>three</p>\n<p>four</p>\n<p>Trap</p>\n<p>d</p>\n' +
            '<p><a href="tel:+15551234">ok</a> <a href="../x.md#y">rel</a> <a href="#s">frag</a></p>',
    );
    assert.deepEqual(out.lost, [LOST.unsafe]);
    assert.ok(!/javascript|vbscript|data:/i.test(html(doc(p(t('x', link('javascript:alert(1)'))))).text));
});

test('HTML unknown types and lost', () => {
    const out = body(
        doc(
            { type: 'callout', content: [p(t('in <callout>'))] },
            { type: 'aside', content: [t('inline')] },
            { type: 'widget' },
            p(t('a'), { type: 'mention', content: [t('@sam')] }, t('b', { type: 'sparkle' }), t('u', 'underline')),
        ),
    );
    assert.equal(out.text, '<p>in &lt;callout&gt;</p>\n<p>inline</p>\n<p>a@samb<u>u</u></p>');
    assert.deepEqual(out.lost, [
        'Unsupported content "callout" (text kept)',
        'Unsupported content "aside" (text kept)',
        'Unsupported content "widget" (left out)',
        'Unsupported formatting "sparkle" (text kept)',
        'Unsupported content "mention" (text kept)',
    ]);
});

test('a whole note exports in both formats without throwing', () => {
    const everything = doc(
        h(1, 'Trip', 't'),
        p(t('Pack '), t('light', 'bold', 'underline', 'highlight'), br, t('and early')),
        ul(li(p(t('passport')), ul(li(p(t('copy')))))),
        { type: 'checklist', attrs: { list: 'groceries' } },
        { type: 'ink', attrs: { strokes: 'map' } },
        attachment({ kind: 'image', name: 'map.png' }),
        { type: 'table', content: [row(cell('tableHeader', 'Day', { colspan: 2 }))] },
        { type: 'mystery' },
    );
    const m = md(everything, 'Trip');
    assert.ok(m.text.startsWith('# Trip\n\nPack **light**\\\nand early\n'));
    assert.ok(m.text.endsWith('\n') && !m.text.endsWith('\n\n'));
    assert.deepEqual(m.lost, [
        LOST.underline,
        LOST.highlight,
        LOST.ink,
        LOST.merged,
        'Unsupported content "mystery" (left out)',
    ]);
    const x = html(everything, 'Trip');
    assert.ok(x.text.includes('<strong><u><mark>light</mark></u></strong>'));
    assert.deepEqual(x.lost, ['Unsupported content "mystery" (left out)']);
});

console.log(`PASS: export (${checks} groups)`);
