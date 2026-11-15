<script lang="ts">
    /**
     * A folder's menu in the notes list: a new note or folder in it, rename it,
     * move it, or delete it. The list stays as it is; the parent expands it.
     */
    import { dismiss } from '$lib/dismiss';
    import FolderPicker from '$lib/FolderPicker.svelte';
    import { folderTree, within, type Folder } from '$lib/folders';
    import Icon from '$lib/Icon.svelte';
    import type { Index } from '$lib/notes';

    let {
        index,
        folder,
        folders,
        notesInside,
        onnewnote,
        onexpand,
        ondelete,
    }: {
        index: Index;
        folder: Folder;
        folders: Folder[];
        notesInside: number;
        onnewnote: (folder: string) => void;
        /** Show what's inside this folder. */
        onexpand: (folder: string) => void;
        /** It's gone to Recently Deleted, with the folders and notes in it. */
        ondelete: (gone: Set<string>) => void;
    } = $props();

    let menu: HTMLDetailsElement;
    let mode = $state<'menu' | 'rename' | 'subfolder' | 'move' | 'delete'>('menu');
    let name = $state('');
    const tree = $derived(folderTree(folders));
    const inside = $derived(within(folders, folder.id));
    const subfolders = $derived(inside.size - 1);

    function start(next: typeof mode) {
        mode = next;
        name = next === 'rename' ? folder.name : '';
    }
    function close() {
        menu.open = false;
        mode = 'menu';
    }
    function submit(event: SubmitEvent) {
        event.preventDefault();
        const text = name.trim();
        if (!text) return;
        if (mode === 'rename') index.renameFolder(folder.id, text);
        else {
            index.createFolder(text, folder.id);
            onexpand(folder.id);
        }
        close();
    }
    function remove() {
        const gone = inside;
        index.deleteFolder(folder.id);
        close();
        ondelete(gone);
    }
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
    const focus = (input: HTMLInputElement) => input.focus();
</script>

<details
    class="menu folder-menu"
    bind:this={menu}
    use:dismiss
    ontoggle={(e) => !e.currentTarget.open && (mode = 'menu')}
>
    <summary class="icon-btn" aria-label="Actions for {folder.name || 'Untitled folder'}"><Icon name="more" /></summary>
    <div class="sheet actions">
        {#if mode === 'rename' || mode === 'subfolder'}
            <form class="folder-form" onsubmit={submit}>
                <input
                    bind:value={name}
                    aria-label={mode === 'rename' ? 'Folder name' : 'New folder name'}
                    placeholder="Folder name"
                    maxlength="100"
                    use:focus
                />
                <button class="btn primary" type="submit" disabled={!name.trim()}
                    >{mode === 'rename' ? 'Rename' : 'Create'}</button
                >
                <button class="btn" type="button" onclick={() => (mode = 'menu')}>Cancel</button>
            </form>
        {:else if mode === 'move'}
            <p class="small muted menu-note">Move “{folder.name || 'Untitled folder'}” to</p>
            <FolderPicker
                rows={tree}
                current={tree.some((r) => r.folder.id === folder.parent) ? folder.parent : ''}
                exclude={inside}
                onpick={(parent) => {
                    index.moveFolder(folder.id, parent);
                    close();
                }}
            />
        {:else if mode === 'delete'}
            <p class="small menu-note">
                Move “{folder.name || 'Untitled folder'}”{subfolders ? `, ${plural(subfolders, 'folder')} in it` : ''} and
                {plural(notesInside, 'note')} to Recently Deleted? You can restore them all from there.
            </p>
            <button class="btn danger" type="button" onclick={remove}>Delete folder</button>
            <button class="btn" type="button" onclick={() => (mode = 'menu')}>Keep it</button>
        {:else}
            <button
                class="btn"
                type="button"
                onclick={() => {
                    close();
                    onnewnote(folder.id);
                }}>New note here</button
            >
            <button class="btn" type="button" onclick={() => start('rename')}>Rename folder…</button>
            <button class="btn" type="button" onclick={() => start('subfolder')}>New folder inside…</button>
            <button class="btn" type="button" onclick={() => start('move')}>Move folder…</button>
            <button class="btn" type="button" onclick={() => start('delete')}>Delete folder…</button>
        {/if}
    </div>
</details>
