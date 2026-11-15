<script lang="ts">
    import { getContext } from 'svelte';
    import { dismiss } from '$lib/dismiss';
    import FolderPicker from '$lib/FolderPicker.svelte';
    import { folderTree, shownFolder } from '$lib/folders';
    import Icon from '$lib/Icon.svelte';
    import { remindMeHref } from '$lib/links';
    import type { Index, Note } from '$lib/notes';

    let { note, id, ondelete }: { note: Note; id: string; ondelete: () => void } = $props();

    const title = $derived(note.title);
    const firstLine = $derived(note.firstLine);
    const hasChecklist = $derived(note.hasChecklist);
    const shownTitle = $derived($title.trim() || $firstLine || 'Untitled note');
    let menu: HTMLDetailsElement;
    let confirmDelete = $state(false);
    let moving = $state(false);

    const index = getContext<Index>('index');
    const notes = index.notes;
    const folders = index.folders;
    const tree = $derived(folderTree($folders));
    const place = $derived(
        shownFolder($notes.find((n) => n.id === id)?.folder ?? '', new Set(tree.map((r) => r.folder.id))),
    );

    function exportText() {
        const url = URL.createObjectURL(new Blob([note.plainText()], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${shownTitle.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80)}.txt`;
        link.click();
        URL.revokeObjectURL(url);
    }

    function run(action: () => void) {
        action();
        menu.open = false;
        moving = false;
    }
</script>

<details class="menu" bind:this={menu} use:dismiss ontoggle={(e) => !e.currentTarget.open && (moving = false)}>
    <summary class="icon-btn" aria-label="Note actions"><Icon name="more" /></summary>
    <div class="sheet actions">
        {#if moving}
            <p class="small muted menu-note">Move “{shownTitle}” to</p>
            <FolderPicker rows={tree} current={place} onpick={(folder) => run(() => index.moveNotes([id], folder))} />
            <button class="btn" type="button" onclick={() => (moving = false)}>Cancel</button>
        {:else}
            <button
                class="btn"
                type="button"
                title="Ctrl+F"
                onclick={() => run(() => dispatchEvent(new CustomEvent('huginn:find')))}>Find in note</button
            >
            <a class="btn" href={remindMeHref(id, shownTitle)}>Remind me about this note…</a>
            <button class="btn" type="button" onclick={() => (moving = true)}>Move to folder…</button>
            {#if $hasChecklist}
                <button class="btn" type="button" onclick={() => run(note.uncheckEverything)}>Uncheck all</button>
                <button class="btn" type="button" onclick={() => run(note.removeAllChecked)}
                    >Delete checked items</button
                >
            {/if}
            <button class="btn" type="button" onclick={() => run(exportText)}>Export as text</button>
            {#if confirmDelete}
                <button class="btn danger" type="button" onclick={ondelete}>Move to Recently Deleted</button>
                <button class="btn" type="button" onclick={() => (confirmDelete = false)}>Keep it</button>
            {:else}
                <button class="btn" type="button" onclick={() => (confirmDelete = true)}>Delete note…</button>
            {/if}
        {/if}
    </div>
</details>
