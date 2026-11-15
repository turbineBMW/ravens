<script lang="ts">
    /**
     * The tags already used, under a tag being typed. The editor keeps focus:
     * arrows move, Enter or Tab picks, Escape dismisses (RichEditor handles the
     * keys), and a click or tap picks without hiding a phone's keyboard.
     */
    import type { TagInfo } from '$lib/tags';

    let {
        items,
        picked,
        left,
        top,
        bottom,
        count,
        onpick,
    }: {
        items: TagInfo[];
        picked: number;
        /** Where the tag's `#` is on screen. */
        left: number;
        top: number;
        bottom: number;
        count: (tag: TagInfo) => number;
        onpick: (tag: TagInfo) => void;
    } = $props();

    /** As wide as the list is styled, so it stays on screen at the right edge. */
    const WIDTH = 240;
    const GAP = 4;
    let height = $state(0);
    /** Below the tag, or above it when there's no room below, such as over a phone's keyboard. */
    const y = $derived.by(() => {
        const visible = window.visualViewport?.height ?? innerHeight;
        const below = bottom + GAP;
        return below + height > visible - 8 && top - GAP - height > 8 ? top - GAP - height : below;
    });
</script>

<div
    class="tag-suggest"
    role="listbox"
    aria-label="Tags already used"
    style:left="{Math.max(8, Math.min(left, innerWidth - WIDTH - 8))}px"
    style:top="{y}px"
    bind:clientHeight={height}
>
    {#each items as tag, i (tag.tag)}
        <button
            type="button"
            role="option"
            aria-selected={i === picked}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => onpick(tag)}
        >
            <span class="folder-name">#{tag.name}</span>
            <span class="muted small">{count(tag)}</span>
        </button>
    {/each}
</div>
