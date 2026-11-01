/**
 * Pen and touch are different inputs, and the whole UI treats them so: the
 * pen writes, fingers scroll, pan and pinch. Pointer Events already tell them
 * apart; these helpers keep the decision in one place and pull the extra
 * per-sample data (pressure, tilt, coalesced events) into one shape the ink
 * layer stores.
 */

export type InputKind = 'pen' | 'touch' | 'mouse';

export function inputKind(e: PointerEvent): InputKind {
    return e.pointerType === 'pen' ? 'pen' : e.pointerType === 'touch' ? 'touch' : 'mouse';
}

/** The pen's eraser end (Surface Pen, S Pen) or its eraser button. */
export function isEraser(e: PointerEvent): boolean {
    return e.button === 5 || (e.buttons & 32) !== 0;
}

/** The pen's barrel button (held, on Surface Pen; S Pen reports it too). */
export function isBarrelButton(e: PointerEvent): boolean {
    return (e.buttons & 2) !== 0 && e.pointerType === 'pen';
}

/** A pen above the screen, not touching it. */
export function isHover(e: PointerEvent): boolean {
    return e.pointerType === 'pen' && e.buttons === 0;
}

/**
 * Every sample the browser collected since the last event (pens report at
 * 200Hz+ while the page paints at 60-120Hz), oldest first; the event itself
 * when the browser does not coalesce.
 */
export function samples(e: PointerEvent): PointerEvent[] {
    const all = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    return all.length ? all : [e];
}

/** The browser's guess at where the pen goes next, for hiding latency. */
export function predicted(e: PointerEvent): PointerEvent[] {
    return typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents() : [];
}

/** One stored ink sample, in canvas-local CSS pixels. */
export interface InkPoint {
    x: number;
    y: number;
    /** 0..1; mice and most touch report 0.5 or 0. */
    p: number;
    /** Milliseconds, DOMHighResTimeStamp. */
    t: number;
    /** Degrees, -90..90; absent when the hardware has none. */
    tx?: number;
    ty?: number;
}

export function inkPoint(e: PointerEvent, origin: { left: number; top: number }): InkPoint {
    const point: InkPoint = { x: e.clientX - origin.left, y: e.clientY - origin.top, p: e.pressure, t: e.timeStamp };
    if (e.tiltX || e.tiltY) {
        point.tx = e.tiltX;
        point.ty = e.tiltY;
    }
    return point;
}
