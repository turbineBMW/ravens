<script lang="ts">
    /**
     * The note's body: Tiptap on the note's Yjs fragment. Undo covers this
     * device's edits to the prose and the checklist together, and never another
     * device's or the migration's. A checklist block only shows the items map it
     * names, and a drawing the strokes map it names, so pasted or dragged copies
     * of either are refused rather than sharing that map.
     */
    import { Editor, Node, type CommandProps } from '@tiptap/core';
    import Collaboration from '@tiptap/extension-collaboration';
    import Highlight from '@tiptap/extension-highlight';
    import { TableKit } from '@tiptap/extension-table';
    import { Placeholder } from '@tiptap/extensions';
    import { NodeSelection, TextSelection } from '@tiptap/pm/state';
    import StarterKit from '@tiptap/starter-kit';
    import { ySyncPluginKey } from '@tiptap/y-tiptap';
    import { getContext, mount, onMount, tick, unmount } from 'svelte';
    import { get, writable } from 'svelte/store';
    import * as Y from 'yjs';
    import ChecklistBlock from '$lib/ChecklistBlock.svelte';
    import InkBlock from '$lib/InkBlock.svelte';
    import { remindMeHref } from '$lib/links';
    import { matchCount, type Found } from '$lib/find';
    import { FindInNote, findKey, findState, type FindAction } from '$lib/findInNote';
    import Icon from '$lib/Icon.svelte';
    import { Sections, revealPosition, revealSection, sectionAt } from '$lib/sections';
    import { Hashtags, type TypedTag } from '$lib/hashtags';
    import TagSuggest from '$lib/TagSuggest.svelte';
    import { filterByTag, suggestTags, tags, type TagInfo } from '$lib/tags';
    import type { Index, Note } from '$lib/notes';

    let { note, id }: { note: Note; id: string } = $props();

    let host: HTMLElement;

    /** A link (from a reminder or a search) may name a section to open the note at. */
    function revealLinkedSection() {
        const target = decodeURIComponent(location.hash.slice(1));
        if (editor && target.startsWith('section-')) revealSection(editor.view, target.slice('section-'.length));
    }
    let editor = $state.raw<Editor | null>(null);

    // Suggesting the tags already used while one is typed.
    const libraryNotes = getContext<Index>('index').notes;
    const liveNotes = $derived(new Set($libraryNotes.filter((n) => !n.deletedAt).map((n) => n.id)));
    const countOf = (t: TagInfo) => t.notes.filter((id) => liveNotes.has(id)).length;
    let typing = $state<(TypedTag & { left: number; top: number; bottom: number }) | null>(null);
    /** The tag whose suggestions Escape put away, by where its `#` is. */
    let dismissed = $state<number | null>(null);
    let picked = $state(0);
    const suggestions = $derived(
        typing && typing.from !== dismissed
            ? suggestTags($tags, typing.typed, countOf).filter((t) => t.name !== typing!.typed)
            : [],
    );
    function onTyping(next: typeof typing) {
        if (!next || next.from !== dismissed) dismissed = null;
        if (next?.typed !== typing?.typed) picked = 0;
        typing = next;
    }
    function onKey(event: KeyboardEvent): boolean {
        const n = suggestions.length;
        if (!n || event.altKey || event.ctrlKey || event.metaKey) return false;
        if (event.key === 'ArrowDown') picked = (picked + 1) % n;
        else if (event.key === 'ArrowUp') picked = (picked - 1 + n) % n;
        else if (event.key === 'Enter' || event.key === 'Tab') pickTag(suggestions[picked]);
        else if (event.key === 'Escape') dismissed = typing?.from ?? null;
        else return false;
        return true;
    }
    /** Fill in the whole tag, and a space after it unless one's there. */
    function pickTag(tag: TagInfo) {
        if (!editor || !typing) return;
        const { from, to } = typing;
        const next = editor.state.doc.textBetween(
            to,
            Math.min(to + 1, editor.state.doc.content.size),
            undefined,
            '\ufffc',
        );
        editor
            .chain()
            .focus()
            .insertContentAt({ from, to }, `#${tag.name}${/\s/u.test(next) ? '' : ' '}`)
            .run();
    }
    /** Keep the suggestions under the tag as the note scrolls. */
    function follow() {
        if (!typing || !editor) return;
        const { left, top, bottom } = editor.view.coordsAtPos(typing.from);
        typing = { ...typing, left, top, bottom };
    }
    // Find in note: a field under the toolbar, Ctrl+F or the note menu to open it.
    let finding = $state(false);
    let query = $state('');
    let findInput = $state<HTMLInputElement>();
    /** Told to the checklist blocks, which highlight their own items. */
    const found = writable<Found>({ query: '', list: null, item: null, shown: 0 });
    const find = $derived.by(() => {
        void revision;
        return editor ? findState(editor.state) : undefined;
    });
    const countText = $derived(find?.query ? matchCount(find.current, find.matches.length) : '');

    function tellBlocks(ed: Editor, show = false) {
        const state = findState(ed.state);
        const match = state?.matches[state.current];
        const was = get(found);
        const next: Found = {
            query: state?.query ?? '',
            list: match?.kind === 'item' ? match.list : null,
            item: match?.kind === 'item' ? match.item : null,
            shown: was.shown + (show ? 1 : 0),
        };
        if (next.query !== was.query || next.list !== was.list || next.item !== was.item || show) found.set(next);
    }
    function findAction(action: FindAction) {
        editor?.view.dispatch(editor.state.tr.setMeta(findKey, action));
    }
    /** Bring the current match into view, opening any collapsed section it's in. */
    function showMatch() {
        if (!editor) return;
        const state = findState(editor.state);
        const match = state?.matches[state.current];
        if (match) revealPosition(editor.view, match.from);
        tellBlocks(editor, !!match);
        // A checklist brings its own item into view.
        if (match?.kind === 'text') editor.view.dom.querySelector('.find-current')?.scrollIntoView({ block: 'center' });
    }
    function lookFor(text: string) {
        query = text;
        findAction({ query: text });
        showMatch();
    }
    function step(by: 1 | -1) {
        findAction({ step: by });
        showMatch();
    }
    function openFind() {
        if (!editor) return;
        // Text selected on one line is what's looked for.
        const { from, to, empty } = editor.state.selection;
        const selected = empty ? '' : editor.state.doc.textBetween(from, to, '\n', ' ');
        if (selected.trim() && !selected.includes('\n') && selected.length <= 100) query = selected;
        finding = true;
        lookFor(query);
        void tick().then(() => {
            findInput?.focus();
            findInput?.select();
        });
    }
    /** `focus`: put the caret on the current match, selecting it, as Escape does. */
    function closeFind(focus: boolean) {
        if (!editor) return;
        const state = findState(editor.state);
        const match = state?.matches[state.current];
        finding = false;
        findAction({ query: '' });
        tellBlocks(editor);
        if (!focus || !match) return;
        if (match.kind === 'text') {
            editor.chain().focus().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run();
        } else {
            const input = host.querySelector<HTMLInputElement>(
                `.note-checklist [data-item="${CSS.escape(match.item)}"] input.text`,
            );
            input?.focus();
            input?.setSelectionRange(match.at, match.end);
        }
    }
    function onFindKey(event: KeyboardEvent) {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            closeFind(true);
        }
    }
    /** Ctrl+F (⌘F) from anywhere in the note; F3 or Ctrl+G for the next match, with Shift the previous. */
    function onWindowKey(event: KeyboardEvent) {
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (mod && !event.altKey && !event.shiftKey && key === 'f') {
            const target = event.target as Element | null;
            // The notes list keeps the browser's own find.
            if (target && target !== document.body && !target.closest('.editor-pane')) return;
            event.preventDefault();
            openFind();
        } else if (finding && !event.altKey && (key === 'f3' || (mod && key === 'g'))) {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
        }
    }

    // Toolbar state is read from the editor, so redraw it on every change.
    let revision = $state(0);
    let linkOpen = $state(false);
    let linkUrl = $state('');
    let linkInput = $state<HTMLInputElement>();

    const active = (name: string, attrs?: Record<string, unknown>) => {
        void revision;
        return editor?.isActive(name, attrs) ?? false;
    };
    const can = (check: (e: Editor) => boolean) => {
        void revision;
        return editor ? check(editor) : false;
    };
    const chain = () => editor!.chain().focus();
    const inTable = $derived(active('table'));

    /** "Remind me" about the selected text, linking back to the section it's in. */
    const reminderHref = $derived.by(() => {
        void revision;
        if (!editor || editor.state.selection.empty) return null;
        const { from, to } = editor.state.selection;
        const text = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (!text) return null;
        const section = sectionAt(editor.state, from);
        return remindMeHref(id, text, section ? `section-${section}` : undefined);
    });

    let pasteProblem = $state('');
    async function pastePlain() {
        pasteProblem = '';
        try {
            const text = await navigator.clipboard.readText();
            editor?.view.pasteText(text);
            editor?.commands.focus();
        } catch {
            pasteProblem = "Couldn't read the clipboard. Paste with Ctrl+Shift+V, or allow clipboard access.";
        }
    }

    /** Step off a selected checklist or drawing, so what's inserted next goes after it, not over it. */
    function pastBlock({ tr, dispatch }: CommandProps) {
        const { selection } = tr;
        const atom = selection instanceof NodeSelection && ['checklist', 'ink'].includes(selection.node.type.name);
        if (atom && dispatch) {
            tr.setSelection(TextSelection.near(tr.doc.resolve(selection.to), 1));
        }
        return true;
    }

    const blockStyle = $derived.by(() => {
        if (active('heading', { level: 1 })) return 'title';
        if (active('heading', { level: 2 })) return 'heading';
        if (active('heading', { level: 3 })) return 'subheading';
        if (active('codeBlock')) return 'mono';
        return 'body';
    });
    function setBlockStyle(style: string) {
        if (style === 'title') chain().setHeading({ level: 1 }).run();
        else if (style === 'heading') chain().setHeading({ level: 2 }).run();
        else if (style === 'subheading') chain().setHeading({ level: 3 }).run();
        else if (style === 'mono') chain().setCodeBlock().run();
        else chain().setParagraph().run();
    }

    function toggleLinkField() {
        linkUrl = editor?.getAttributes('link').href ?? '';
        linkOpen = !linkOpen;
        if (linkOpen) queueMicrotask(() => linkInput?.focus());
    }
    function applyLink(event: SubmitEvent) {
        event.preventDefault();
        const url = linkUrl.trim();
        const href = !url || /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
        if (href) chain().extendMarkRange('link').setLink({ href }).run();
        else chain().extendMarkRange('link').unsetLink().run();
        linkOpen = false;
    }

    onMount(() => {
        const undo = new Y.UndoManager([note.body, note.doc.doc.getMap('items')], {
            trackedOrigins: new Set([ySyncPluginKey, null]),
            captureTimeout: 400,
        });
        const Checklist = Node.create({
            name: 'checklist',
            group: 'block',
            atom: true,
            selectable: true,
            draggable: false,
            addAttributes: () => ({ list: { default: 'items' } }),
            // Nothing parses into this node, so a paste can't make a second block.
            parseHTML: () => [],
            renderHTML: () => ['div', { 'data-checklist': '' }],
            addNodeView:
                () =>
                ({ node }) => {
                    const list = String(node.attrs.list);
                    undo.addToScope(note.listMap(list));
                    const dom = document.createElement('div');
                    dom.className = 'note-checklist';
                    dom.contentEditable = 'false';
                    const block = mount(ChecklistBlock, {
                        target: dom,
                        props: { note, id, list },
                        context: new Map([['find', found]]),
                    });
                    return {
                        dom,
                        // The rows handle their own typing, clicks and drags.
                        stopEvent: () => true,
                        ignoreMutation: () => true,
                        destroy: () => void unmount(block),
                    };
                },
        });
        const Ink = Node.create({
            name: 'ink',
            group: 'block',
            atom: true,
            selectable: true,
            draggable: false,
            addAttributes: () => ({ strokes: { default: 'strokes' } }),
            parseHTML: () => [],
            renderHTML: () => ['div', { 'data-ink': '' }],
            addNodeView:
                () =>
                ({ node }) => {
                    const name = String(node.attrs.strokes);
                    undo.addToScope([note.inkMap(name), note.paperMap]);
                    const dom = document.createElement('div');
                    dom.className = 'note-ink';
                    dom.contentEditable = 'false';
                    const block = mount(InkBlock, { target: dom, props: { note, name } });
                    return {
                        dom,
                        // The canvas and its tools handle their own pointers.
                        stopEvent: () => true,
                        ignoreMutation: () => true,
                        destroy: () => void unmount(block),
                    };
                },
        });
        const created = new Editor({
            element: host,
            extensions: [
                StarterKit.configure({ undoRedo: false }),
                Highlight,
                TableKit.configure({ table: { resizable: false } }),
                Placeholder.configure({ placeholder: 'Start writing' }),
                Checklist,
                Ink,
                Sections.configure({ noteId: id }),
                // A tag filters the notes list, when the list is in view beside the note.
                Hashtags.configure({
                    onTag: (tag) => {
                        if ((document.querySelector('.notes-pane') as HTMLElement | null)?.offsetParent)
                            filterByTag(tag);
                    },
                    onTyping,
                    onKey,
                }),
                FindInNote.configure({ itemsOf: (list) => get(note.list(list).items) }),
                Collaboration.configure({ fragment: note.body, yUndoOptions: { undoManager: undo } }),
            ],
            onTransaction: ({ editor: ed }) => {
                revision++;
                tellBlocks(ed);
            },
        });
        editor = created;
        revealLinkedSection();
        // Following a link to another section of this note may only change the hash.
        addEventListener('hashchange', revealLinkedSection);
        addEventListener('scroll', follow, true);
        addEventListener('resize', follow);
        addEventListener('keydown', onWindowKey);
        addEventListener('huginn:find', openFind);
        // Checklist items aren't in the body, so a change to one is looked through again.
        let rereading = false;
        const reread = () => {
            if (!finding || rereading) return;
            rereading = true;
            queueMicrotask(() => {
                rereading = false;
                if (editor === created && finding) findAction({ refresh: true });
            });
        };
        note.doc.doc.on('update', reread);
        // Only a blank note takes focus: opening an existing one must not raise a phone's keyboard.
        if (created.isEmpty && !created.state.doc.firstChild?.type.name.startsWith('checklist')) {
            created.commands.focus('start');
        }
        return () => {
            removeEventListener('hashchange', revealLinkedSection);
            removeEventListener('scroll', follow, true);
            removeEventListener('resize', follow);
            removeEventListener('keydown', onWindowKey);
            removeEventListener('huginn:find', openFind);
            note.doc.doc.off('update', reread);
            created.destroy();
            undo.destroy();
            editor = null;
        };
    });
</script>

<div class="editor-top">
    <div class="editor-toolbar" role="toolbar" aria-label="Formatting">
        <select
            aria-label="Text style"
            value={blockStyle}
            disabled={!editor}
            onchange={(e) => setBlockStyle(e.currentTarget.value)}
        >
            <option value="body">Body</option>
            <option value="title">Title</option>
            <option value="heading">Heading</option>
            <option value="subheading">Subheading</option>
            <option value="mono">Monospaced</option>
        </select>
        {#snippet tool(label: string, text: string, run: () => void, pressed?: boolean, disabled?: boolean)}
            <button
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={pressed}
                disabled={!editor || disabled}
                onmousedown={(e) => e.preventDefault()}
                onclick={run}>{text}</button
            >
        {/snippet}
        <span class="sep"></span>
        {@render tool('Bold', 'B', () => chain().toggleBold().run(), active('bold'))}
        {@render tool('Italic', 'I', () => chain().toggleItalic().run(), active('italic'))}
        {@render tool('Underline', 'U', () => chain().toggleUnderline().run(), active('underline'))}
        {@render tool('Strikethrough', 'S', () => chain().toggleStrike().run(), active('strike'))}
        {@render tool('Highlight', 'Mark', () => chain().toggleHighlight().run(), active('highlight'))}
        {@render tool('Link', 'Link', toggleLinkField, active('link'))}
        {#if reminderHref}
            <a class="tool-link" href={reminderHref} title="Remind me about the selected text">Remind me</a>
        {:else}
            <span class="tool-link" aria-disabled="true" title="Select text to make a reminder">Remind me</span>
        {/if}
        {@render tool('Paste as plain text', 'Paste text', () => void pastePlain())}
        <span class="sep"></span>
        {@render tool('Bulleted list', '• List', () => chain().toggleBulletList().run(), active('bulletList'))}
        {@render tool('Numbered list', '1. List', () => chain().toggleOrderedList().run(), active('orderedList'))}
        {@render tool(
            'Indent',
            'Indent',
            () => chain().sinkListItem('listItem').run(),
            undefined,
            !can((e) => e.can().sinkListItem('listItem')),
        )}
        {@render tool(
            'Outdent',
            'Outdent',
            () => chain().liftListItem('listItem').run(),
            undefined,
            !can((e) => e.can().liftListItem('listItem')),
        )}
        <span class="sep"></span>
        {@render tool('Add checklist', 'Checklist', () =>
            chain()
                .command(pastBlock)
                .insertContent({ type: 'checklist', attrs: { list: note.newList() } })
                .command(pastBlock)
                .run(),
        )}
        {@render tool('Add drawing', 'Drawing', () =>
            chain()
                .command(pastBlock)
                .insertContent({ type: 'ink', attrs: { strokes: note.newInk() } })
                .command(pastBlock)
                .run(),
        )}
        {@render tool('Add table', 'Table', () =>
            chain().command(pastBlock).insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run(),
        )}
        {@render tool('Add divider', 'Divider', () => chain().command(pastBlock).setHorizontalRule().run())}
        {#if inTable}
            <span class="sep"></span>
            {@render tool('Add row', '+ Row', () => chain().addRowAfter().run())}
            {@render tool('Delete row', '− Row', () => chain().deleteRow().run())}
            {@render tool('Add column', '+ Column', () => chain().addColumnAfter().run())}
            {@render tool('Delete column', '− Column', () => chain().deleteColumn().run())}
            {@render tool('Delete table', 'Delete table', () => chain().deleteTable().run())}
        {/if}
        <span class="sep"></span>
        {@render tool('Undo', 'Undo', () => chain().undo().run(), undefined, !can((e) => e.can().undo()))}
        {@render tool('Redo', 'Redo', () => chain().redo().run(), undefined, !can((e) => e.can().redo()))}
    </div>
    {#if finding}
        <div class="find-bar" role="search">
            <input
                bind:this={findInput}
                type="search"
                value={query}
                placeholder="Find in note"
                aria-label="Find in note"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                enterkeyhint="search"
                oninput={(e) => lookFor(e.currentTarget.value)}
                onkeydown={onFindKey}
            />
            <span class="find-count small muted" role="status">{countText}</span>
            <button
                class="icon-btn"
                type="button"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                disabled={!find?.matches.length}
                onclick={() => step(-1)}><Icon name="up" /></button
            >
            <button
                class="icon-btn"
                type="button"
                aria-label="Next match"
                title="Next match (Enter)"
                disabled={!find?.matches.length}
                onclick={() => step(1)}><Icon name="down" /></button
            >
            <button
                class="icon-btn"
                type="button"
                aria-label="Close find"
                title="Close (Escape)"
                onclick={() => closeFind(false)}><Icon name="close" /></button
            >
        </div>
    {/if}
</div>
{#if pasteProblem}
    <p class="small muted" role="alert">{pasteProblem}</p>
{/if}
{#if linkOpen}
    <form class="link-field" onsubmit={applyLink}>
        <input
            bind:this={linkInput}
            bind:value={linkUrl}
            type="text"
            inputmode="url"
            placeholder="https://"
            aria-label="Link address; leave empty to remove the link"
            autocomplete="off"
            autocapitalize="off"
        />
        <button class="btn" type="submit">Apply</button>
    </form>
{/if}
<div bind:this={host}></div>
{#if typing && suggestions.length}
    <TagSuggest
        items={suggestions}
        {picked}
        left={typing.left}
        top={typing.top}
        bottom={typing.bottom}
        count={countOf}
        onpick={pickTag}
    />
{/if}
