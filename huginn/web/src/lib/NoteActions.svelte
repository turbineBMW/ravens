<script lang="ts">
    import { dismiss } from '$lib/dismiss';
    import Icon from '$lib/Icon.svelte';
    import { remindMeHref } from '$lib/links';
    import type { Note } from '$lib/notes';

    let { note, id, ondelete }: { note: Note; id: string; ondelete: () => void } = $props();

    const title = $derived(note.title);
    const firstLine = $derived(note.firstLine);
    const hasChecklist = $derived(note.hasChecklist);
    const shownTitle = $derived($title.trim() || $firstLine || 'Untitled note');
    let menu: HTMLDetailsElement;
    let confirmDelete = $state(false);

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
    }
</script>

<details class="menu" bind:this={menu} use:dismiss>
    <summary class="icon-btn" aria-label="Note actions"><Icon name="more" /></summary>
    <div class="sheet actions">
        <a class="btn" href={remindMeHref(id, shownTitle)}>Remind me about this note…</a>
        {#if $hasChecklist}
            <button class="btn" type="button" onclick={() => run(note.uncheckAll)}>Uncheck all</button>
            <button class="btn" type="button" onclick={() => run(note.removeChecked)}>Delete checked items</button>
        {/if}
        <button class="btn" type="button" onclick={() => run(exportText)}>Export as text</button>
        {#if confirmDelete}
            <button class="btn danger" type="button" onclick={ondelete}>Move to Recently Deleted</button>
            <button class="btn" type="button" onclick={() => (confirmDelete = false)}>Keep it</button>
        {:else}
            <button class="btn" type="button" onclick={() => (confirmDelete = true)}>Delete note…</button>
        {/if}
    </div>
</details>
