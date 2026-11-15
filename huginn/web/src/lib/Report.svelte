<script lang="ts">
    /**
     * What an export or import did, and what couldn't come across. OK or
     * Escape puts it away, said at once and once: the dialog's close event
     * comes later, and would otherwise take away a report shown after this one.
     */
    import { onMount } from 'svelte';

    let { title, lines, onclose }: { title: string; lines: string[]; onclose: () => void } = $props();
    let dialog: HTMLDialogElement;
    let closed = false;
    function finish() {
        if (closed) return;
        closed = true;
        if (dialog.open) dialog.close();
        onclose();
    }
    onMount(() => dialog.showModal());
</script>

<dialog class="report" bind:this={dialog} onclose={finish} aria-label={title}>
    <h2>{title}</h2>
    {#if lines.length}
        <ul>
            {#each lines as line, i (i)}<li>{line}</li>{/each}
        </ul>
    {/if}
    <div class="actions-row">
        <button class="btn primary" type="button" onclick={finish}>OK</button>
    </div>
</dialog>
