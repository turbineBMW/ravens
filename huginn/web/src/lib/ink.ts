/**
 * Drawing strokes on a canvas, and finding the ones an eraser touches. Pure
 * geometry: storage is in notes.ts, input in InkBlock.svelte. Everything here
 * is in drawing units (INK_WIDTH across); the caller's canvas transform scales
 * them to the column.
 */
import { INK_STRIDE, type InkColor, type InkTool, type Stroke } from '$lib/notes';

/** A new drawing's height, in drawing units. */
export const INK_MIN_HEIGHT = 560;
/** Room kept below the lowest stroke, so there's always space to carry on. */
export const INK_MARGIN = 200;
/** How far the eraser reaches beyond a stroke's edge. */
export const ERASER_RADIUS = 12;
/** A highlighter shows what's under it. */
export const HIGHLIGHTER_ALPHA = 0.35;

/** Fine, medium and bold, in drawing units at full pressure. */
export const WIDTHS: Record<InkTool, readonly [number, number, number]> = {
    pen: [2, 4, 8],
    highlighter: [14, 24, 36],
};

/** Each colour follows the theme, including the Omarchy one. */
const COLOR_VARS: Record<InkColor, string> = {
    ink: '--ink',
    blue: '--accent-2',
    red: '--danger',
    green: '--ok',
    yellow: '--warn',
};

export function inkColor(element: Element, color: InkColor): string {
    return getComputedStyle(element).getPropertyValue(COLOR_VARS[color]).trim() || 'currentColor';
}

/** Hardware without pressure reports 0 or 0.5; both draw at the middle width. */
const pressure = (p: number) => (p > 0 ? Math.min(p, 1) : 0.5);

/** A stroke's width at one sample: thinner when the pen presses lightly. */
export function widthAt(width: number, p: number): number {
    return width * (0.35 + 0.65 * pressure(p));
}

/** Draw from sample `i - 1` to sample `i`, or a dot for a stroke's first sample. */
export function drawSegment(ctx: CanvasRenderingContext2D, points: ArrayLike<number>, i: number, width: number) {
    const at = i * INK_STRIDE;
    const x = points[at];
    const y = points[at + 1];
    const w = widthAt(width, points[at + 2]);
    if (i === 0) {
        ctx.beginPath();
        ctx.arc(x, y, w / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    const prev = at - INK_STRIDE;
    ctx.lineWidth = (w + widthAt(width, points[prev + 2])) / 2;
    ctx.beginPath();
    ctx.moveTo(points[prev], points[prev + 1]);
    ctx.lineTo(x, y);
    ctx.stroke();
}

export function prepare(ctx: CanvasRenderingContext2D, color: string) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
}

/**
 * A highlighter is one see-through path of even width: drawn segment by
 * segment, the overlaps at each joint would show darker.
 */
export function drawHighlighter(
    ctx: CanvasRenderingContext2D,
    points: ArrayLike<number>,
    width: number,
    color: string,
) {
    if (!points.length) return;
    ctx.save();
    ctx.globalAlpha = HIGHLIGHTER_ALPHA;
    prepare(ctx, color);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    if (points.length === INK_STRIDE) ctx.lineTo(points[0] + 0.01, points[1]);
    for (let i = INK_STRIDE; i < points.length; i += INK_STRIDE) ctx.lineTo(points[i], points[i + 1]);
    ctx.stroke();
    ctx.restore();
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, color: string) {
    if (stroke.tool === 'highlighter') return drawHighlighter(ctx, stroke.points, stroke.width, color);
    prepare(ctx, color);
    const samples = stroke.points.length / INK_STRIDE;
    // A stroke longer than a dot doesn't need its first dot.
    for (let i = samples > 1 ? 1 : 0; i < samples; i++) drawSegment(ctx, stroke.points, i, stroke.width);
}

/** The lowest point any stroke reaches. */
export function bottomOf(strokes: Stroke[]): number {
    let bottom = 0;
    for (const s of strokes) {
        for (let i = 1; i < s.points.length; i += INK_STRIDE) bottom = Math.max(bottom, s.points[i] + s.width);
    }
    return bottom;
}

/** How tall a drawing is: never smaller than a new one, and always with room below. */
export function heightFor(bottom: number): number {
    return Math.max(INK_MIN_HEIGHT, Math.ceil(bottom + INK_MARGIN));
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether an eraser at (x, y) touches the stroke. */
export function touches(stroke: Stroke, x: number, y: number, radius = ERASER_RADIUS): boolean {
    const reach = radius + stroke.width / 2;
    const p = stroke.points;
    if (p.length === INK_STRIDE) return Math.hypot(x - p[0], y - p[1]) <= reach;
    for (let i = INK_STRIDE; i < p.length; i += INK_STRIDE) {
        if (distanceToSegment(x, y, p[i - INK_STRIDE], p[i - INK_STRIDE + 1], p[i], p[i + 1]) <= reach) return true;
    }
    return false;
}

/**
 * The same stroke with extra samples, so no step is longer than `step`; the
 * new ones take their pressure and time from either side.
 */
export function resample(points: ArrayLike<number>, step: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < points.length; i += INK_STRIDE) {
        if (i > 0) {
            const prev = i - INK_STRIDE;
            const n = Math.ceil(Math.hypot(points[i] - points[prev], points[i + 1] - points[prev + 1]) / step);
            for (let k = 1; k < n; k++) {
                const f = k / n;
                for (let j = 0; j < INK_STRIDE; j++)
                    out.push(points[prev + j] + (points[i + j] - points[prev + j]) * f);
            }
        }
        for (let j = 0; j < INK_STRIDE; j++) out.push(points[i + j]);
    }
    return out;
}

/**
 * What's left of a stroke after the eraser passes through `eraser` (x, y
 * pairs): null when it isn't touched, otherwise the pieces that remain, each
 * with at least two samples, so an erased stroke leaves no crumbs.
 */
export function eraseFrom(
    stroke: Pick<Stroke, 'points' | 'width'>,
    eraser: number[],
    radius = ERASER_RADIUS,
): Float32Array[] | null {
    const reach = radius + stroke.width / 2;
    const hit = (x: number, y: number) => {
        for (let e = 0; e < eraser.length; e += 2)
            if (Math.hypot(x - eraser[e], y - eraser[e + 1]) <= reach) return true;
        return false;
    };
    const asStroke = { points: stroke.points, width: stroke.width } as Stroke;
    let touched = false;
    for (let e = 0; e < eraser.length && !touched; e += 2)
        touched = touches(asStroke, eraser[e], eraser[e + 1], radius);
    if (!touched) return null;
    const dense = resample(stroke.points, Math.max(1, radius / 3));
    const pieces: Float32Array[] = [];
    let run: number[] = [];
    const flush = () => {
        if (run.length >= INK_STRIDE * 2) pieces.push(Float32Array.from(run));
        run = [];
    };
    for (let i = 0; i < dense.length; i += INK_STRIDE) {
        if (hit(dense[i], dense[i + 1])) flush();
        else for (let j = 0; j < INK_STRIDE; j++) run.push(dense[i + j]);
    }
    flush();
    return pieces;
}
