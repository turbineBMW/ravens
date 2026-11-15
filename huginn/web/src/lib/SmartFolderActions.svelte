<script lang="ts">
    /** A Smart Folder's menu in the notes list: change it, or delete it (its notes stay). */
    import { dismiss } from '$lib/dismiss';
    import Icon from '$lib/Icon.svelte';
    import type { Index } from '$lib/notes';
    import type { SmartFolder } from '$lib/smartFolders';

    let { index, folder, onedit }: { index: Index; folder: SmartFolder; onedit: () => void } = $props();
    let menu: HTMLDetailsElement;
    let confirming = $state(false);
    function close() {
        if (menu) menu.open = false;
        confirming = false;
    }
</script>

<details
    class="menu folder-menu"
    bind:this={menu}
    use:dismiss
    ontoggle={(e) => !e.currentTarget.open && (confirming = false)}
>
    <summary class="icon-btn" aria-label="Actions for {folder.name || 'Untitled Smart Folder'}"
        ><Icon name="more" /></summary
    >
    <div class="sheet actions">
        {#if confirming}
            <p class="small menu-note">
                Delete the Smart Folder “{folder.name || 'Untitled Smart Folder'}”? Its notes stay where they are.
            </p>
            <button
                class="btn danger"
                type="button"
                onclick={() => {
                    index.deleteSmartFolder(folder.id);
                    close();
                }}>Delete Smart Folder</button
            >
            <button class="btn" type="button" onclick={() => (confirming = false)}>Keep it</button>
        {:else}
            <button
                class="btn"
                type="button"
                onclick={() => {
                    close();
                    onedit();
                }}>Edit Smart Folder…</button
            >
            <button class="btn" type="button" onclick={() => (confirming = true)}>Delete Smart Folder…</button>
        {/if}
    </div>
</details>
