<script lang="ts">
    /**
     * A note's first drawing, small, in the notes list. It's drawn from the
     * index's copy (see encodeSketch), so the list needn't open the note, and
     * in the theme's colours, so it follows the theme like the drawing does.
     */
    import { decodeSketch, SKETCH_SIZE } from '$lib/notes';
    import { COLOR_VARS, HIGHLIGHTER_ALPHA } from '$lib/ink';

    let { bytes }: { bytes: Uint8Array } = $props();

    /** The thumbnail's side in CSS pixels, as styled. */
    const SIDE_PX = 48;
    const PAD = 12;
    /** No line thinner than this many pixels, or a fine pen would vanish. */
    const MIN_PX = 1.25;
    const minWidth = (MIN_PX * (SKETCH_SIZE + 2 * PAD)) / SIDE_PX;

    const sketch = $derived(decodeSketch(bytes));

    function path(points: number[]): string {
        if (points.length === 2) return `M${points[0]} ${points[1]}h0.01`;
        let d = `M${points[0]} ${points[1]}`;
        for (let i = 2; i < points.length; i += 2) d += `L${points[i]} ${points[i + 1]}`;
        return d;
    }
</script>

{#if sketch}
    <svg
        class="sketch"
        viewBox="{-PAD} {-PAD} {sketch.width + 2 * PAD} {sketch.height + 2 * PAD}"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
    >
        {#each sketch.strokes as s, i (i)}
            <path
                d={path(s.points)}
                fill="none"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={Math.max(s.width, minWidth)}
                opacity={s.tool === 'highlighter' ? HIGHLIGHTER_ALPHA : undefined}
                style:stroke="var({COLOR_VARS[s.color]})"
            />
        {/each}
    </svg>
{/if}
