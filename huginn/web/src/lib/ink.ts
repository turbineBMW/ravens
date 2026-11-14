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
export const COLOR_VARS: Record<InkColor, string> = {
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

// ---------- lasso, move and resize ----------

/** Whether (x, y) is inside the polygon through `poly` (x, y pairs). */
export function inside(poly: ArrayLike<number>, x: number, y: number): boolean {
    let isIn = false;
    for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
        const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) isIn = !isIn;
    }
    return isIn;
}

/** Whether a lasso through `poly` takes the stroke: at least half of it, by length, lies inside. */
export function lassoed(stroke: Pick<Stroke, 'points'>, poly: ArrayLike<number>): boolean {
    if (poly.length < 6) return false;
    const dense = resample(stroke.points, 4);
    let count = 0;
    for (let i = 0; i < dense.length; i += INK_STRIDE) if (inside(poly, dense[i], dense[i + 1])) count++;
    return count * 2 >= dense.length / INK_STRIDE;
}

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

/** The box the strokes' ink covers, edges included. */
export function boundsOf(strokes: Pick<Stroke, 'points' | 'width'>[]): Box | null {
    let box: Box | null = null;
    for (const s of strokes) {
        const r = s.width / 2;
        for (let i = 0; i < s.points.length; i += INK_STRIDE) {
            const x = s.points[i];
            const y = s.points[i + 1];
            if (!box) box = { left: x - r, top: y - r, right: x + r, bottom: y + r };
            else {
                box.left = Math.min(box.left, x - r);
                box.top = Math.min(box.top, y - r);
                box.right = Math.max(box.right, x + r);
                box.bottom = Math.max(box.bottom, y + r);
            }
        }
    }
    return box;
}

/** Scale by `scale` about (ox, oy), then move by (dx, dy). */
export interface Transform {
    ox: number;
    oy: number;
    scale: number;
    dx: number;
    dy: number;
}

export const IDENTITY: Transform = { ox: 0, oy: 0, scale: 1, dx: 0, dy: 0 };

export function transformed(stroke: Pick<Stroke, 'points' | 'width'>, t: Transform): Pick<Stroke, 'points' | 'width'> {
    const points = Float32Array.from(stroke.points);
    for (let i = 0; i < points.length; i += INK_STRIDE) {
        points[i] = t.ox + (points[i] - t.ox) * t.scale + t.dx;
        points[i + 1] = t.oy + (points[i + 1] - t.oy) * t.scale + t.dy;
    }
    return { points, width: stroke.width * t.scale };
}

/** The smallest a selection can be resized to, along its longer side. */
export const MIN_SELECTION = 16;

/** A move of `box` by (dx, dy), kept inside the drawing: within its width, and not above its top. */
export function moveWithin(box: Box, dx: number, dy: number, width: number): Transform {
    const span = box.right - box.left;
    const x = span >= width ? -box.left : Math.min(Math.max(dx, -box.left), width - box.right);
    return { ...IDENTITY, dx: x, dy: Math.max(dy, -box.top) };
}

/**
 * Resizing `box` from its top-left corner by dragging the bottom-right one to
 * (x, y), keeping its shape: no smaller than MIN_SELECTION and no wider than
 * the drawing.
 */
export function resizeTo(box: Box, x: number, y: number, width: number): Transform {
    const w = Math.max(box.right - box.left, 1e-3);
    const h = Math.max(box.bottom - box.top, 1e-3);
    // Along the box's diagonal, so the corner follows the pointer as closely as its shape allows.
    let scale = ((x - box.left) * w + (y - box.top) * h) / (w * w + h * h);
    scale = Math.max(scale, MIN_SELECTION / Math.max(w, h));
    scale = Math.min(scale, (width - Math.max(box.left, 0)) / w);
    return { ox: box.left, oy: box.top, scale, dx: 0, dy: 0 };
}

// ---------- the ruler ----------

/** The ruler, in drawing units: its centre and its angle in radians. */
export interface Ruler {
    x: number;
    y: number;
    angle: number;
}

export const RULER_LENGTH = 900;
export const RULER_THICKNESS = 90;
/** How close to an edge a stroke must start to follow it. */
export const RULER_REACH = 40;
/** The ruler settles on multiples of 15 degrees within this many degrees. */
const RULER_SNAP_DEGREES = 2;

/** An angle settled on the nearest multiple of 15 degrees when it is close, for level and square lines. */
export function settleAngle(angle: number): number {
    const step = Math.PI / 12;
    const nearest = Math.round(angle / step) * step;
    return Math.abs(angle - nearest) <= (RULER_SNAP_DEGREES * Math.PI) / 180 ? nearest + 0 : angle;
}

/** Degrees from level, 0 to 90, as the ruler shows them: tilted either way reads the same. */
export function rulerDegrees(angle: number): number {
    const degrees = ((Math.round((angle * 180) / Math.PI) % 180) + 180) % 180;
    return Math.min(degrees, 180 - degrees);
}

/**
 * Which edge of the ruler a stroke starting at (x, y) follows: 1 for the edge
 * below the ruler's centre line, -1 for the one above, 0 for neither. A stroke
 * follows the nearer edge when it starts on the ruler or within RULER_REACH of
 * an edge, alongside the ruler's length.
 */
export function rulerSide(ruler: Ruler, x: number, y: number): -1 | 0 | 1 {
    const cos = Math.cos(ruler.angle);
    const sin = Math.sin(ruler.angle);
    const along = (x - ruler.x) * cos + (y - ruler.y) * sin;
    const across = -(x - ruler.x) * sin + (y - ruler.y) * cos;
    if (Math.abs(along) > RULER_LENGTH / 2) return 0;
    if (Math.abs(across) > RULER_THICKNESS / 2 + RULER_REACH) return 0;
    return across < 0 ? -1 : 1;
}

/** (x, y) moved onto the line a stroke `width` wide draws along that edge, just clear of the ruler. */
export function alongRuler(ruler: Ruler, side: -1 | 1, x: number, y: number, width: number): [number, number] {
    const cos = Math.cos(ruler.angle);
    const sin = Math.sin(ruler.angle);
    const along = (x - ruler.x) * cos + (y - ruler.y) * sin;
    const across = side * (RULER_THICKNESS / 2 + width / 2);
    return [ruler.x + along * cos - across * sin, ruler.y + along * sin + across * cos];
}
