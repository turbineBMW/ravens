<script lang="ts">
    /**
     * A drawing in the body. The pen and the mouse draw; fingers scroll the
     * note unless "Draw with finger" is on. The Eraser cuts away what it
     * touches and the Stroke eraser removes whole strokes; the pen's eraser
     * end uses whichever was chosen last. The Lasso selects strokes to move,
     * resize or delete. The Ruler, on this device only, is dragged with a
     * finger or the mouse and turned with two fingers or its ends; a stroke
     * that starts on it or near an edge draws straight along that edge. A
     * stroke is stored once it's finished, and an eraser gesture or a move
     * once it lifts, so other devices see each as one change.
     */
    import { onMount } from 'svelte';
    import { inputKind, isEraser, samples } from '@ravens/ui/pointer';
    import {
        INK_COLORS,
        INK_STRIDE,
        INK_WIDTH,
        PAPERS,
        type InkColor,
        type InkTool,
        type Note,
        type Paper,
        type Stroke,
    } from '$lib/notes';
    import {
        ERASER_RADIUS,
        IDENTITY,
        RULER_LENGTH,
        RULER_THICKNESS,
        WIDTHS,
        alongRuler,
        bottomOf,
        boundsOf,
        drawHighlighter,
        drawSegment,
        drawStroke,
        eraseFrom,
        heightFor,
        inkColor,
        lassoed,
        moveWithin,
        prepare,
        resizeTo,
        rulerDegrees,
        rulerSide,
        settleAngle,
        touches,
        transformed,
        type Box,
        type Ruler,
        type Transform,
    } from '$lib/ink';

    let { note, name }: { note: Note; name: string } = $props();

    const model = $derived(note.ink(name));
    const strokeStore = $derived(model.strokes);
    const strokes = $derived($strokeStore);
    const paperStore = $derived(model.paper);
    const paper = $derived($paperStore);

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
    const PAPER_NAMES: Record<Paper, string> = { plain: 'Plain', lines: 'Lines', grid: 'Grid', dots: 'Dots' };
    /** Paper lines, in drawing units, so they scale with the strokes. */
    const PAPER_STEP = 50;

    type Eraser = 'partial' | 'stroke';
    interface Tools {
        tool: InkTool | 'eraser' | 'lasso';
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
                tool: ['pen', 'highlighter', 'eraser', 'lasso'].includes(saved.tool) ? saved.tool : 'pen',
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
    const drawingTool = $derived<InkTool | null>(
        tools.tool === 'pen' || tools.tool === 'highlighter' ? tools.tool : null,
    );
    function choose(tool: Tools['tool'], eraser?: Eraser) {
        tools.tool = tool;
        if (eraser) tools.eraser = eraser;
        if (tool !== 'lasso') selectedIds = [];
    }

    /** The strokes the lasso took; any that are erased elsewhere drop out. */
    let selectedIds = $state<string[]>([]);
    const selection = $derived.by(() => {
        const ids = new Set(selectedIds);
        return strokes.filter((s) => ids.has(s.id));
    });
    const selectionBox = $derived(boundsOf(selection));
    function deleteSelection() {
        model.remove(selection.map((s) => s.id));
        selectedIds = [];
    }

    let ruler = $state<Ruler | null>(null);
    /** The ruler as it's shown and drawn along: settled on level and square angles when close. */
    const rulerAt = $derived(ruler && { ...ruler, angle: settleAngle(ruler.angle) });
    function toggleRuler() {
        if (ruler) {
            ruler = null;
            return;
        }
        // In the middle of the part of the drawing on screen.
        const r = frame.getBoundingClientRect();
        const top = Math.max(0, -r.top);
        const bottom = Math.min(r.height, innerHeight - r.top);
        const middle = bottom > top ? (top + bottom) / 2 / scale : height / 2;
        ruler = {
            x: INK_WIDTH / 2,
            y: Math.max(RULER_THICKNESS, Math.min(middle, height - RULER_THICKNESS)),
            angle: 0,
        };
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
        /** The ruler edge the stroke follows, if any. */
        side: -1 | 0 | 1;
    }
    interface Erasing {
        kind: 'erase';
        pointer: number;
        whole: boolean;
        last: [number, number] | null;
        /** What's left of each stroke touched so far; stored when the eraser lifts. */
        left: Map<string, Float32Array[]>;
    }
    interface Lassoing {
        kind: 'lasso';
        pointer: number;
        path: number[];
    }
    /** Moving or resizing the selection: shown live, stored when the pointer lifts. */
    interface Reshaping {
        kind: 'reshape';
        resize: boolean;
        pointer: number;
        from: [number, number];
        box: Box;
        t: Transform;
    }
    let live: Drawing | Erasing | Lassoing | Reshaping | null = null;
    /** What the mouse or a hovering pen would do here: shown by the cursor. */
    let hover = $state<'move' | 'resize' | null>(null);
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

    function cssColor(name: string): string {
        return getComputedStyle(canvas).getPropertyValue(name).trim() || 'currentColor';
    }

    function boxAfter(box: Box, t: Transform): Box {
        const x = (v: number) => t.ox + (v - t.ox) * t.scale + t.dx;
        const y = (v: number) => t.oy + (v - t.oy) * t.scale + t.dy;
        return { left: x(box.left), top: y(box.top), right: x(box.right), bottom: y(box.bottom) };
    }

    /** Selection handles, in CSS pixels so they stay easy to hit in a narrow column. */
    const PAD_PX = 8;
    const HANDLE_PX = 9;
    const HANDLE_REACH_PX = 22;

    function drawSelection(ctx: CanvasRenderingContext2D, box: Box) {
        const pad = PAD_PX / scale;
        ctx.save();
        ctx.strokeStyle = ctx.fillStyle = cssColor('--accent');
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([6 / scale, 4 / scale]);
        ctx.strokeRect(box.left - pad, box.top - pad, box.right - box.left + 2 * pad, box.bottom - box.top + 2 * pad);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(box.right + pad, box.bottom + pad, HANDLE_PX / scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawLasso(ctx: CanvasRenderingContext2D, path: number[]) {
        if (path.length < 4) return;
        ctx.save();
        ctx.strokeStyle = cssColor('--accent');
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([6 / scale, 4 / scale]);
        ctx.beginPath();
        ctx.moveTo(path[0], path[1]);
        for (let i = 2; i < path.length; i += 2) ctx.lineTo(path[i], path[i + 1]);
        ctx.stroke();
        ctx.restore();
    }

    /** What a pointer at (x, y) would take hold of: the resize handle, the selection, or nothing. */
    function hitSelection(x: number, y: number): 'move' | 'resize' | null {
        const box = selectionBox;
        if (tools.tool !== 'lasso' || !box || !scale) return null;
        const pad = PAD_PX / scale;
        if (Math.hypot(x - (box.right + pad), y - (box.bottom + pad)) <= HANDLE_REACH_PX / scale) return 'resize';
        if (x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad) return 'move';
        return null;
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
        const t = live?.kind === 'reshape' ? live.t : null;
        const chosen = new Set(selectedIds);
        for (const s of strokes) {
            const color = inkColor(canvas, s.color);
            const pieces = left?.get(s.id);
            if (pieces) for (const points of pieces) drawStroke(ctx, { ...s, points }, color);
            else if (t && chosen.has(s.id)) drawStroke(ctx, { ...s, ...transformed(s, t) }, color);
            else drawStroke(ctx, s, color);
        }
        if (live?.kind === 'draw') drawLive(ctx, live);
        if (live?.kind === 'lasso') drawLasso(ctx, live.path);
        if (selectionBox && tools.tool === 'lasso') drawSelection(ctx, t ? boxAfter(selectionBox, t) : selectionBox);
    }

    $effect(() => {
        void strokes;
        void height;
        void scale;
        void themeRevision;
        void selectionBox;
        void tools.tool;
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
        if (live.kind === 'lasso') {
            for (const sample of samples(e)) live.path.push(...local(sample, rect));
            redraw();
            return;
        }
        if (live.kind === 'reshape') {
            const [x, y] = local(e, rect);
            const { box } = live;
            live.t = live.resize
                ? resizeTo(box, x, y, INK_WIDTH)
                : moveWithin(box, x - live.from[0], y - live.from[1], INK_WIDTH);
            liveBottom = boxAfter(box, live.t).bottom;
            redraw();
            return;
        }
        const ctx = context();
        if (ctx && live.tool === 'pen') prepare(ctx, inkColor(canvas, live.color));
        for (const sample of samples(e)) {
            let [x, y] = local(sample, rect);
            if (live.side && rulerAt) [x, y] = alongRuler(rulerAt, live.side, x, y, live.width);
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
        hover = null;
        const [x, y] = local(e, canvas.getBoundingClientRect());
        if (tools.tool === 'lasso' && !isEraser(e)) {
            const hit = hitSelection(x, y);
            if (hit && selectionBox) {
                live = {
                    kind: 'reshape',
                    resize: hit === 'resize',
                    pointer: e.pointerId,
                    from: [x, y],
                    box: selectionBox,
                    t: IDENTITY,
                };
            } else {
                selectedIds = [];
                live = { kind: 'lasso', pointer: e.pointerId, path: [] };
            }
        } else if (!drawingTool || isEraser(e)) {
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
                side: rulerAt ? rulerSide(rulerAt, x, y) : 0,
            };
        }
        take(e);
    }

    function move(e: PointerEvent) {
        if (live?.pointer === e.pointerId) take(e);
        else if (!live && inputKind(e) !== 'touch') hover = hitSelection(...local(e, canvas.getBoundingClientRect()));
    }

    function up(e: PointerEvent) {
        if (live?.pointer !== e.pointerId) return;
        const finished = live;
        live = null;
        if (finished.kind === 'erase') model.erase(finished.left);
        else if (finished.kind === 'lasso') {
            const path = finished.path;
            selectedIds = strokes.filter((s) => lassoed(s, path)).map((s) => s.id);
        } else if (finished.kind === 'reshape') {
            const { t } = finished;
            if (t.dx || t.dy || t.scale !== 1) {
                model.reshape(new Map(selection.map((s) => [s.id, transformed(s, t)])));
            }
        } else if (finished.points.length) {
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

    /** Fingers or the mouse holding the ruler, where each last was. */
    const holding = new Map<number, [number, number]>();
    /** The pointer turning the ruler by one of its ends, and which end. */
    let turning: { pointer: number; end: number } | null = null;
    const clampRuler = (r: Ruler) => {
        r.x = Math.max(0, Math.min(INK_WIDTH, r.x));
        r.y = Math.max(0, Math.min(height, r.y));
    };
    const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

    function rulerDown(e: PointerEvent) {
        // The pen draws, erases or lassos as if the ruler weren't there.
        if (inputKind(e) === 'pen') return down(e);
        if (inputKind(e) === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        holding.set(e.pointerId, local(e, canvas.getBoundingClientRect()));
        const end = (e.target as HTMLElement).dataset.end;
        if (end) turning = { pointer: e.pointerId, end: Number(end) };
    }

    function rulerMove(e: PointerEvent) {
        const before = holding.get(e.pointerId);
        if (!before || !ruler) return;
        const now = local(e, canvas.getBoundingClientRect());
        holding.set(e.pointerId, now);
        if (turning?.pointer === e.pointerId) {
            ruler.angle = wrap(Math.atan2(now[1] - ruler.y, now[0] - ruler.x) + (turning.end < 0 ? Math.PI : 0));
            return;
        }
        const others = [...holding.keys()].filter((id) => id !== turning?.pointer && id !== e.pointerId);
        const other = others.length ? holding.get(others[0])! : null;
        if (other) {
            // Two fingers: it follows their middle and turns as they turn.
            ruler.x += (now[0] - before[0]) / 2;
            ruler.y += (now[1] - before[1]) / 2;
            const was = Math.atan2(before[1] - other[1], before[0] - other[0]);
            const is = Math.atan2(now[1] - other[1], now[0] - other[0]);
            ruler.angle = wrap(ruler.angle + wrap(is - was));
        } else {
            ruler.x += now[0] - before[0];
            ruler.y += now[1] - before[1];
        }
        clampRuler(ruler);
    }

    function rulerUp(e: PointerEvent) {
        holding.delete(e.pointerId);
        if (turning?.pointer === e.pointerId) turning = null;
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
        <button
            type="button"
            aria-pressed={tools.tool === 'lasso'}
            title="Draw round strokes to move, resize or delete them"
            onclick={() => choose('lasso')}>Lasso</button
        >
    </span>
    {#if tools.tool === 'lasso' && selection.length}
        <button type="button" onclick={deleteSelection}>Delete selection</button>
    {/if}
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
    <span class="ink-group">
        <button type="button" aria-pressed={!!ruler} onclick={toggleRuler}>Ruler</button>
        <select aria-label="Paper" value={paper} onchange={(e) => model.setPaper(e.currentTarget.value as Paper)}>
            {#each PAPERS as p (p)}
                <option value={p}>{PAPER_NAMES[p]}</option>
            {/each}
        </select>
        <button type="button" aria-pressed={fingerDraws} onclick={toggleFinger}>Draw with finger</button>
    </span>
</div>
<div
    class="ink-frame paper-{paper}"
    bind:this={frame}
    style:height="{height * scale}px"
    style:--paper-step="{PAPER_STEP * scale}px"
>
    <canvas
        bind:this={canvas}
        class="ink-canvas"
        class:finger={fingerDraws}
        class:erasing={tools.tool === 'eraser'}
        class:lasso={tools.tool === 'lasso'}
        class:moving={hover === 'move'}
        class:resizing={hover === 'resize'}
        aria-label={strokes.length ? `Drawing, ${strokes.length} strokes` : 'Empty drawing'}
        data-strokes={strokes.length}
        data-selected={selection.length}
        onpointerdown={down}
        onpointermove={move}
        onpointerup={up}
        onpointercancel={cancel}
        oncontextmenu={(e) => e.preventDefault()}
    ></canvas>
    {#if rulerAt}
        <div
            class="ink-ruler"
            role="presentation"
            data-angle={rulerDegrees(rulerAt.angle)}
            style:left="{rulerAt.x * scale}px"
            style:top="{rulerAt.y * scale}px"
            style:width="{RULER_LENGTH * scale}px"
            style:height="{RULER_THICKNESS * scale}px"
            style:--tick="{20 * scale}px"
            style:transform="translate(-50%, -50%) rotate({rulerAt.angle}rad)"
            onpointerdown={rulerDown}
            onpointermove={rulerMove}
            onpointerup={rulerUp}
            onpointercancel={rulerUp}
            oncontextmenu={(e) => e.preventDefault()}
        >
            <span class="ink-ruler-end" data-end="-1" title="Turn the ruler"></span>
            <span class="ink-ruler-angle">{rulerDegrees(rulerAt.angle)}°</span>
            <span class="ink-ruler-end" data-end="1" title="Turn the ruler"></span>
        </div>
    {/if}
    {#if !strokes.length}
        <p class="ink-hint muted small" aria-hidden="true">
            Draw with a pen or mouse{fingerDraws ? ', or a finger' : ''}
        </p>
    {/if}
</div>
