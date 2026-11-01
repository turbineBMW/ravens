<script lang="ts">
    import { dismiss } from '$lib/dismiss';
    import Icon from '$lib/Icon.svelte';
    import { remindMeHref } from '$lib/links';
    import type { Note } from '$lib/notes';

    let { note, id, ondelete }: { note: Note; id: string; ondelete: () => void } = $props();

    const title = $derived(note.title);
    let menu: HTMLDetailsElement;
    let confirmDelete = $state(false);

    function run(action: () => void) {
        action();
        menu.open = false;
    }
</script>

<details class="menu" bind:this={menu} use:dismiss>
    <summary class="icon-btn" aria-label="List actions"><Icon name="more" /></summary>
    <div class="sheet actions">
        <a class="btn" href={remindMeHref(id, $title || 'Untitled list')}>Remind me about this list…</a>
        <button class="btn" type="button" onclick={() => run(note.uncheckAll)}>Uncheck all</button>
        <button class="btn" type="button" onclick={() => run(note.removeChecked)}>Delete checked items</button>
        {#if confirmDelete}
            <button class="btn danger" type="button" onclick={ondelete}>Move to Recently Deleted</button>
            <button class="btn" type="button" onclick={() => (confirmDelete = false)}>Keep it</button>
        {:else}
            <button class="btn" type="button" onclick={() => (confirmDelete = true)}>Delete list…</button>
        {/if}
    </div>
</details>
