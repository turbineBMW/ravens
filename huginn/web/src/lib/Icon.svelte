<script lang="ts">
    // Symbolic header bar icons, drawn in the current text colour.
    let { name }: { name: 'add' | 'menu' | 'more' | 'back' } = $props();
</script>

<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    {#if name === 'add'}
        <path d="M8 2.5v11M2.5 8h11" />
    {:else if name === 'menu'}
        <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    {:else if name === 'back'}
        <path d="M10 3 5 8l5 5" />
    {:else}
        <circle cx="3" cy="8" r="1.25" />
        <circle cx="8" cy="8" r="1.25" />
        <circle cx="13" cy="8" r="1.25" />
    {/if}
</svg>
