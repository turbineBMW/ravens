<script lang="ts">
    /**
     * A drawing in the body. The pen and the mouse draw; fingers scroll the
     * note unless "Draw with finger" is on. The Eraser cuts away what it
     * touches and the Stroke eraser removes whole strokes; the pen's eraser
     * end uses whichever was chosen last. A stroke is stored once it's
     * finished, and an eraser gesture once it lifts, so other devices see each
     * as one change.
     */
    import { onMount } from 'svelte';
    import { inputKind, isEraser, samples } from '@ravens/ui/pointer';
    import { INK_COLORS, INK_STRIDE, INK_WIDTH, type InkColor, type InkTool, type Note, type Stroke } from '$lib/notes';
    import {
        ERASER_RADIUS,
        WIDTHS,
        bottomOf,
        drawHighlighter,
        drawSegment,
        drawStroke,
        eraseFrom,
        heightFor,
        inkColor,
        prepare,
        touches,
    } from '$lib/ink';

    let { note, name }: { note: Note; name: string } = $props();

    const model = $derived(note.ink(name));
    const strokeStore = $derived(model.strokes);
    const strokes = $derived($strokeStore);

    const FINGER_KEY = 'huginn.ink.finger';
    const TOOLS_KEY = 'huginn.ink.tools';
    const COLOR_NAMES: Record<InkColor, string> = {
        ink: 'Ink',
        blue: 'Blue',
        red: 'Red',
        green: 'Green',
        yellow: 'Yellow',
    };
    const WIDTH_NAMES = ['Fine', 'Medium', 'Bold'] as const;

    type Eraser = 'partial' | 'stroke';
    interface Tools {
        tool: InkTool | 'eraser';
        eraser: Eraser;
        pen: { color: InkColor; width: number };
        highlighter: { color: InkColor; width: number };
    }
    const DEFAULT_TOOLS: Tools = {
        tool: 'pen',
        eraser: 'partial',
        pen: { color: 'ink', width: 1 },
        highlighter: { color: 'yellow', width: 1 },
    };

    /** This device's tools, as last left. */
    function readTools(): Tools {
        try {
            const saved = JSON.parse(localStorage.getItem(TOOLS_KEY) ?? '{}');
            const pick = (t: InkTool) => ({
                color: INK_COLORS.includes(saved[t]?.color) ? saved[t].color : DEFAULT_TOOLS[t].color,
                width: [0, 1, 2].includes(saved[t]?.width) ? saved[t].width : DEFAULT_TOOLS[t].width,
            });
            return {
                tool: ['pen', 'highlighter', 'eraser'].includes(saved.tool) ? saved.tool : 'pen',
                eraser: saved.eraser === 'stroke' ? 'stroke' : 'partial',
                pen: pick('pen'),
                highlighter: pick('highlighter'),
            };
        } catch {
            return structuredClone(DEFAULT_TOOLS);
        }
    }
    let tools = $state(readTools());
    $effect(() => {
        const json = JSON.stringify(tools);
        try {
            localStorage.setItem(TOOLS_KEY, json);
        } catch {
            /* They still apply for this visit. */
        }
    });
    const drawingTool = $derived<InkTool | null>(tools.tool === 'eraser' ? null : tools.tool);
    function choose(tool: Tools['tool'], eraser?: Eraser) {
        tools.tool = tool;
        if (eraser) tools.eraser = eraser;
    }

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

    interface Drawing {
        kind: 'draw';
        pointer: number;
        start: number;
        tool: InkTool;
        color: InkColor;
        width: number;
        points: number[];
    }
    interface Erasing {
        kind: 'erase';
        pointer: number;
        whole: boolean;
        last: [number, number] | null;
        /** What's left of each stroke touched so far; stored when the eraser lifts. */
        left: Map<string, Float32Array[]>;
    }
    let live: Drawing | Erasing | null = null;
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

    function drawLive(ctx: CanvasRenderingContext2D, d: Drawing) {
        const color = inkColor(canvas, d.color);
        if (d.tool === 'highlighter') return drawHighlighter(ctx, d.points, d.width, color);
        prepare(ctx, color);
        for (let i = 0; i < d.points.length / INK_STRIDE; i++) drawSegment(ctx, d.points, i, d.width);
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
        const left = live?.kind === 'erase' ? live.left : null;
        for (const s of strokes) {
            const color = inkColor(canvas, s.color);
            const pieces = left?.get(s.id);
            if (pieces) for (const points of pieces) drawStroke(ctx, { ...s, points }, color);
            else drawStroke(ctx, s, color);
        }
        if (live?.kind === 'draw') drawLive(ctx, live);
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

    /** Erase along `path`; whether anything changed. */
    function erase(e: Erasing, path: number[]): boolean {
        let any = false;
        for (const s of strokes) {
            const now = e.left.get(s.id) ?? [s.points];
            if (!now.length) continue;
            if (e.whole) {
                const hit = now.some((points) => {
                    const piece = { ...s, points };
                    for (let i = 0; i < path.length; i += 2) if (touches(piece, path[i], path[i + 1])) return true;
                    return false;
                });
                if (hit) e.left.set(s.id, []);
                any ||= hit;
                continue;
            }
            let changed = false;
            const next: Float32Array[] = [];
            for (const points of now) {
                const pieces = eraseFrom({ points, width: s.width }, path);
                if (pieces) changed = true;
                next.push(...(pieces ?? [points]));
            }
            if (changed) e.left.set(s.id, next);
            any ||= changed;
        }
        return any;
    }

    function take(e: PointerEvent) {
        if (!live || !scale) return;
        const rect = canvas.getBoundingClientRect();
        if (live.kind === 'erase') {
            // The way from the last sample, in short steps, so a quick eraser can't jump a stroke.
            const path: number[] = [];
            for (const sample of samples(e)) {
                const [x, y] = local(sample, rect);
                const [px, py] = live.last ?? [x, y];
                const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / (ERASER_RADIUS / 2)));
                for (let i = 1; i <= steps; i++) path.push(px + ((x - px) * i) / steps, py + ((y - py) * i) / steps);
                live.last = [x, y];
            }
            if (erase(live, path)) redraw();
            return;
        }
        const ctx = context();
        if (ctx && live.tool === 'pen') prepare(ctx, inkColor(canvas, live.color));
        for (const sample of samples(e)) {
            const [x, y] = local(sample, rect);
            // Pressed mice report 0.5; a pen touching down can report 0 for its first sample.
            live.points.push(x, y, sample.pressure, sample.timeStamp - live.start);
            if (ctx && live.tool === 'pen') {
                drawSegment(ctx, live.points, live.points.length / INK_STRIDE - 1, live.width);
            }
            if (y + live.width > liveBottom) liveBottom = y + live.width;
        }
        // A highlighter is one see-through path, so it's drawn whole each time.
        if (live.tool === 'highlighter') redraw();
    }

    function down(e: PointerEvent) {
        const kind = inputKind(e);
        if (kind === 'touch' && !fingerDraws) return; // Fingers scroll.
        if (kind === 'mouse' && e.button !== 0) return;
        if (live) return; // One pointer at a time.
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        if (!drawingTool || isEraser(e)) {
            live = {
                kind: 'erase',
                pointer: e.pointerId,
                whole: tools.eraser === 'stroke',
                last: null,
                left: new Map(),
            };
        } else {
            const { color, width } = tools[drawingTool];
            live = {
                kind: 'draw',
                pointer: e.pointerId,
                start: e.timeStamp,
                tool: drawingTool,
                color,
                width: WIDTHS[drawingTool][width],
                points: [],
            };
        }
        take(e);
    }

    function move(e: PointerEvent) {
        if (live?.pointer === e.pointerId) take(e);
    }

    function up(e: PointerEvent) {
        if (live?.pointer !== e.pointerId) return;
        const finished = live;
        live = null;
        if (finished.kind === 'erase') model.erase(finished.left);
        else if (finished.points.length) {
            const { tool, color, width } = finished;
            model.add({ tool, color, width, points: Float32Array.from(finished.points) });
        }
        liveBottom = 0;
        redraw();
    }

    /** The browser took the pointer, to scroll or zoom: drop the stroke or the erasing. */
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
    <span class="ink-group">
        <button type="button" aria-pressed={tools.tool === 'pen'} onclick={() => choose('pen')}>Pen</button>
        <button type="button" aria-pressed={tools.tool === 'highlighter'} onclick={() => choose('highlighter')}
            >Highlighter</button
        >
        <button
            type="button"
            aria-pressed={tools.tool === 'eraser' && tools.eraser === 'partial'}
            title="Erase what it touches"
            onclick={() => choose('eraser', 'partial')}>Eraser</button
        >
        <button
            type="button"
            aria-pressed={tools.tool === 'eraser' && tools.eraser === 'stroke'}
            title="Erase whole strokes"
            onclick={() => choose('eraser', 'stroke')}>Stroke eraser</button
        >
    </span>
    {#if drawingTool}
        {@const current = tools[drawingTool]}
        <span class="ink-group" role="group" aria-label="Colour">
            {#each INK_COLORS as c (c)}
                <button
                    type="button"
                    class="ink-swatch {c}"
                    aria-label={COLOR_NAMES[c]}
                    title={COLOR_NAMES[c]}
                    aria-pressed={current.color === c}
                    onclick={() => (current.color = c)}
                ></button>
            {/each}
        </span>
        <span class="ink-group" role="group" aria-label="Width">
            {#each WIDTH_NAMES as label, i (label)}
                <button
                    type="button"
                    class="ink-width"
                    aria-label={label}
                    title={label}
                    aria-pressed={current.width === i}
                    onclick={() => (current.width = i)}><span style:--dot="{4 + i * 4}px"></span></button
                >
            {/each}
        </span>
    {/if}
    <button type="button" aria-pressed={fingerDraws} onclick={toggleFinger}>Draw with finger</button>
</div>
<div class="ink-frame" bind:this={frame} style:height="{height * scale}px">
    <canvas
        bind:this={canvas}
        class="ink-canvas"
        class:finger={fingerDraws}
        class:erasing={!drawingTool}
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
