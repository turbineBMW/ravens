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
    import { mount, onMount, unmount } from 'svelte';
    import * as Y from 'yjs';
    import ChecklistBlock from '$lib/ChecklistBlock.svelte';
    import InkBlock from '$lib/InkBlock.svelte';
    import { remindMeHref } from '$lib/links';
    import { Sections, revealSection, sectionAt } from '$lib/sections';
    import type { Note } from '$lib/notes';

    let { note, id }: { note: Note; id: string } = $props();

    let host: HTMLElement;
    let editor = $state.raw<Editor | null>(null);
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
                    const block = mount(ChecklistBlock, { target: dom, props: { note, id, list } });
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
                    undo.addToScope(note.inkMap(name));
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
                Collaboration.configure({ fragment: note.body, yUndoOptions: { undoManager: undo } }),
            ],
            onTransaction: () => revision++,
        });
        editor = created;
        // A link from a reminder may name a section.
        const target = decodeURIComponent(location.hash.slice(1));
        if (target.startsWith('section-')) revealSection(created.view, target.slice('section-'.length));
        // Only a blank note takes focus: opening an existing one must not raise a phone's keyboard.
        if (created.isEmpty && !created.state.doc.firstChild?.type.name.startsWith('checklist')) {
            created.commands.focus('start');
        }
        return () => {
            created.destroy();
            undo.destroy();
            editor = null;
        };
    });
</script>

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
