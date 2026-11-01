<script lang="ts">
    import type { Snippet } from 'svelte';
    import Icon from '$lib/Icon.svelte';

    let {
        back,
        subtitle = '',
        children,
        actions,
    }: { back: string; subtitle?: string; children?: Snippet; actions?: Snippet } = $props();
</script>

<header class="headerbar">
    <div class="headerbar-start">
        <a class="icon-btn editor-back" href={back} aria-label="Back to notes"><Icon name="back" /></a>
    </div>
    <div class="headerbar-title">
        {@render children?.()}
        {#if subtitle}<span class="headerbar-subtitle" role="status" title={subtitle}>{subtitle}</span>{/if}
    </div>
    <div class="headerbar-end">{@render actions?.()}</div>
</header>
