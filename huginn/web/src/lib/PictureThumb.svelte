<script lang="ts">
    /** A note's first image, small, in the notes list, from this device or the server. */
    import { fileUrl } from '$lib/files';

    let { id }: { id: string } = $props();
    const url = $derived(fileUrl(id));
</script>

{#if $url}<img class="sketch picture" src={$url} alt="" loading="lazy" />{/if}
