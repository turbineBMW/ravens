<script lang="ts">
    /**
     * A drawing in the body. The pen and the mouse draw; fingers scroll the
     * note unless "Draw with finger" is on. The pen's eraser end, or the
     * Eraser tool, removes whole strokes. A stroke is stored once it's
     * finished, so other devices see it then, not while it's being drawn.
     */
    import { onMount } from 'svelte';
    import { inputKind, isEraser, samples } from '@ravens/ui/pointer';
    import { INK_COLORS, INK_STRIDE, INK_WIDTH, type InkColor, type Note, type Stroke } from '$lib/notes';
    import { ERASER_RADIUS, bottomOf, drawSegment, drawStroke, heightFor, inkColor, prepare, touches } from '$lib/ink';

    let { note, name }: { note: Note; name: string } = $props();

    const model = $derived(note.ink(name));
    const strokeStore = $derived(model.strokes);
    const strokes = $derived($strokeStore);

    const PEN_WIDTH = 4;
    const FINGER_KEY = 'huginn.ink.finger';
    const COLOR_NAMES: Record<InkColor, string> = { ink: 'Ink', blue: 'Blue', red: 'Red', green: 'Green' };

    let tool = $state<'pen' | 'eraser'>('pen');
    let color = $state<InkColor>('ink');
    let fingerDraws = $state(readFinger());

    function readFinger(): boolean {
        try {
            return localStorage.getItem(FINGER_KEY) === '1';
        } catch {
            return false;
        }
    }
    function toggleFinger() {
        fingerDraws = !fingerDraws;
        try {
            if (fingerDraws) localStorage.setItem(FINGER_KEY, '1');
            else localStorage.removeItem(FINGER_KEY);
        } catch {
            /* It still applies for this visit. */
        }
    }

    let frame: HTMLElement;
    let canvas: HTMLCanvasElement;
    let cssWidth = $state(0);
    const scale = $derived(cssWidth / INK_WIDTH);
    // Redraw when the theme's colours change.
    let themeRevision = $state(0);

    interface Live {
        pointer: number;
        erasing: boolean;
        start: number;
        points: number[];
        erased: Set<string>;
    }
    let live: Live | null = null;
    /** How low the stroke being drawn reaches, so the drawing grows under the pen. */
    let liveBottom = $state(0);
    const height = $derived(heightFor(Math.max(bottomOf(strokes), liveBottom)));

    function context(): CanvasRenderingContext2D | null {
        const ctx = canvas?.getContext('2d');
        if (!ctx) return null;
        const ratio = (window.devicePixelRatio || 1) * scale;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return ctx;
    }

    function redraw() {
        if (!canvas || !cssWidth) return;
        const ratio = window.devicePixelRatio || 1;
        const w = Math.round(cssWidth * ratio);
        const h = Math.round(height * scale * ratio);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        } else {
            canvas.getContext('2d')?.clearRect(0, 0, w, h);
        }
        const ctx = context();
        if (!ctx) return;
        for (const s of strokes) {
            if (live?.erased.has(s.id)) continue;
            drawStroke(ctx, s, inkColor(canvas, s.color));
        }
        if (live && !live.erasing) {
            prepare(ctx, inkColor(canvas, color));
            for (let i = 0; i < live.points.length / INK_STRIDE; i++) drawSegment(ctx, live.points, i, PEN_WIDTH);
        }
    }

    $effect(() => {
        void strokes;
        void height;
        void scale;
        void themeRevision;
        redraw();
    });

    function local(e: PointerEvent, rect: DOMRect): [number, number] {
        return [(e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale];
    }

    function take(e: PointerEvent) {
        if (!live || !scale) return;
        const rect = canvas.getBoundingClientRect();
        const ctx = context();
        if (live.erasing) {
            const hit: string[] = [];
            const test = (x: number, y: number) => {
                for (const s of strokes) {
                    if (!live!.erased.has(s.id) && touches(s, x, y)) {
                        live!.erased.add(s.id);
                        hit.push(s.id);
                    }
                }
            };
            for (const sample of samples(e)) {
                const [x, y] = local(sample, rect);
                // Check along the way from the last sample, so a quick eraser can't jump a stroke.
                const [px, py] = live.points.length ? live.points : [x, y];
                const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (ERASER_RADIUS / 2)));
                for (let i = 1; i <= steps; i++) test(px + ((x - px) * i) / steps, py + ((y - py) * i) / steps);
                live.points = [x, y];
            }
            if (hit.length) model.remove(hit);
            return;
        }
        if (ctx) prepare(ctx, inkColor(canvas, color));
        for (const sample of samples(e)) {
            const [x, y] = local(sample, rect);
            // Pressed mice report 0.5; a pen touching down can report 0 for its first sample.
            live.points.push(x, y, sample.pressure, sample.timeStamp - live.start);
            if (ctx) drawSegment(ctx, live.points, live.points.length / INK_STRIDE - 1, PEN_WIDTH);
            if (y + PEN_WIDTH > liveBottom) liveBottom = y + PEN_WIDTH;
        }
    }

    function down(e: PointerEvent) {
        const kind = inputKind(e);
        if (kind === 'touch' && !fingerDraws) return; // Fingers scroll.
        if (kind === 'mouse' && e.button !== 0) return;
        if (live) return; // One pointer at a time.
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        live = {
            pointer: e.pointerId,
            erasing: tool === 'eraser' || isEraser(e),
            start: e.timeStamp,
            points: [],
            erased: new Set(),
        };
        take(e);
    }

    function move(e: PointerEvent) {
        if (live?.pointer === e.pointerId) take(e);
    }

    function up(e: PointerEvent) {
        if (live?.pointer !== e.pointerId) return;
        const finished = live;
        live = null;
        if (!finished.erasing && finished.points.length) {
            model.add({ color, width: PEN_WIDTH, points: Float32Array.from(finished.points) });
        }
        liveBottom = 0;
        redraw();
    }

    /** The browser took the pointer, to scroll or zoom: drop the stroke. */
    function cancel(e: PointerEvent) {
        if (live?.pointer !== e.pointerId) return;
        live = null;
        liveBottom = 0;
        redraw();
    }

    onMount(() => {
        const resize = new ResizeObserver(([entry]) => (cssWidth = entry.contentRect.width));
        resize.observe(frame);
        // A pen on a touch screen (the S Pen in Chrome) would otherwise pan the note.
        const stylus = (e: TouchEvent) => {
            const pen = [...e.changedTouches].some((t) => (t as Touch & { touchType?: string }).touchType === 'stylus');
            if (pen || fingerDraws) e.preventDefault();
        };
        canvas.addEventListener('touchstart', stylus, { passive: false });
        canvas.addEventListener('touchmove', stylus, { passive: false });
        const theme = new MutationObserver(() => themeRevision++);
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        const scheme = matchMedia('(prefers-color-scheme: dark)');
        const schemeChanged = () => themeRevision++;
        scheme.addEventListener('change', schemeChanged);
        return () => {
            resize.disconnect();
            canvas.removeEventListener('touchstart', stylus);
            canvas.removeEventListener('touchmove', stylus);
            theme.disconnect();
            scheme.removeEventListener('change', schemeChanged);
        };
    });
</script>

<div class="ink-tools" role="toolbar" aria-label="Drawing">
    <button type="button" aria-pressed={tool === 'pen'} onclick={() => (tool = 'pen')}>Pen</button>
    <button type="button" aria-pressed={tool === 'eraser'} onclick={() => (tool = 'eraser')}>Eraser</button>
    <span class="ink-swatches">
        {#each INK_COLORS as c (c)}
            <button
                type="button"
                class="ink-swatch {c}"
                aria-label={COLOR_NAMES[c]}
                title={COLOR_NAMES[c]}
                aria-pressed={color === c}
                onclick={() => {
                    color = c;
                    tool = 'pen';
                }}
            ></button>
        {/each}
    </span>
    <button type="button" aria-pressed={fingerDraws} onclick={toggleFinger}>Draw with finger</button>
</div>
<div class="ink-frame" bind:this={frame} style:height="{height * scale}px">
    <canvas
        bind:this={canvas}
        class="ink-canvas"
        class:finger={fingerDraws}
        class:erasing={tool === 'eraser'}
        aria-label={strokes.length ? `Drawing, ${strokes.length} strokes` : 'Empty drawing'}
        data-strokes={strokes.length}
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={cancel}
        oncontextmenu={(e) => e.preventDefault()}
    ></canvas>
    {#if !strokes.length}
        <p class="ink-hint muted small" aria-hidden="true">
            Draw with a pen or mouse{fingerDraws ? ', or a finger' : ''}
        </p>
    {/if}
</div>
