<script lang="ts" module>
    export interface Suggestion {
        key: string;
        text: string;
        /** Shown muted at the end: a count, a folder, "This note". */
        detail?: string;
    }
</script>

<script lang="ts">
    /**
     * Suggestions under what's being typed: tags already used after `#`, notes
     * and sections after `[[`. The editor keeps focus: arrows move, Enter or Tab
     * picks, Escape dismisses (RichEditor handles the keys), and a click or tap
     * picks without hiding a phone's keyboard.
     */
    let {
        label,
        items,
        picked,
        left,
        top,
        bottom,
        onpick,
    }: {
        label: string;
        items: Suggestion[];
        picked: number;
        /** Where what's typed starts on screen. */
        left: number;
        top: number;
        bottom: number;
        onpick: (item: Suggestion) => void;
    } = $props();

    /** As wide as the list is styled, so it stays on screen at the right edge. */
    const WIDTH = 240;
    const GAP = 4;
    let height = $state(0);
    /** Below what's typed, or above it when there's no room below, such as over a phone's keyboard. */
    const y = $derived.by(() => {
        const visible = window.visualViewport?.height ?? innerHeight;
        const below = bottom + GAP;
        return below + height > visible - 8 && top - GAP - height > 8 ? top - GAP - height : below;
    });
</script>

<div
    class="tag-suggest"
    role="listbox"
    aria-label={label}
    style:left="{Math.max(8, Math.min(left, innerWidth - WIDTH - 8))}px"
    style:top="{y}px"
    bind:clientHeight={height}
>
    {#each items as item, i (item.key)}
        <button
            type="button"
            role="option"
            aria-selected={i === picked}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => onpick(item)}
        >
            <span class="folder-name">{item.text}</span>
            {#if item.detail}<span class="muted small">{item.detail}</span>{/if}
        </button>
    {/each}
</div>
