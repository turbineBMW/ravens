/**
 * Drag-to-reorder for a vertical list, by a handle. Pen, mouse and finger
 * all work through Pointer Events; the handle carries `touch-action: none`
 * so a finger on it drags while a finger anywhere else still scrolls.
 *
 * The list owns the order. While a drag is in progress it renders from
 * `preview` (so the other rows slide out of the way, animated by whatever
 * the list uses, such as svelte/animate's flip); on release `commit` gets
 * the dragged id's new neighbours and writes the position for real.
 */

export interface ReorderHooks {
    /** The ids in their current (committed) order, top to bottom. */
    order(): string[];
    /** Called with the full proposed order whenever the slot changes; null when the drag ends. */
    preview(order: string[] | null): void;
    /** The drag ended with `id` between these neighbours (null at an end). */
    commit(id: string, beforeId: string | null, afterId: string | null): void;
    /** Rows that can be reordered: the element for each id, in DOM order. */
    rows(): HTMLElement[];
    rowId(row: HTMLElement): string | undefined;
}

export interface Reorder {
    /** A Svelte action for the handle of the row with this id. */
    handle: (node: HTMLElement, id: string) => { destroy(): void };
    /** True while something is being dragged. */
    active(): boolean;
}

export function createReorder(hooks: ReorderHooks): Reorder {
    let current: { id: string; order: string[]; row: HTMLElement | null } | null = null;

    function slotFor(clientY: number, id: string): number {
        // The slot is after every other row whose middle is above the pointer.
        let index = 0;
        for (const row of hooks.rows()) {
            if (hooks.rowId(row) === id) continue;
            const r = row.getBoundingClientRect();
            if (clientY > r.top + r.height / 2) index++;
        }
        return index;
    }

    function handle(node: HTMLElement, id: string) {
        let pointerId: number | null = null;
        const row = () => node.closest<HTMLElement>('[data-reorder-row]');

        function down(e: PointerEvent) {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            pointerId = e.pointerId;
            node.setPointerCapture(e.pointerId);
            current = { id, order: hooks.order(), row: row() };
            current.row?.classList.add('dragging');
            e.preventDefault();
        }
        function move(e: PointerEvent) {
            if (pointerId !== e.pointerId || !current) return;
            const index = slotFor(e.clientY, id);
            const order = current.order.filter((x) => x !== id);
            order.splice(index, 0, id);
            if (order.join('\n') !== current.order.join('\n')) {
                current.order = order;
                hooks.preview(order);
            }
        }
        function up(e: PointerEvent) {
            if (pointerId !== e.pointerId) return;
            pointerId = null;
            if (current) {
                current.row?.classList.remove('dragging');
                const { order } = current;
                const at = order.indexOf(id);
                if (order.join('\n') !== hooks.order().join('\n')) {
                    hooks.commit(id, order[at - 1] ?? null, order[at + 1] ?? null);
                }
            }
            current = null;
            hooks.preview(null);
        }
        node.style.touchAction = 'none';
        node.addEventListener('pointerdown', down);
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
        return {
            destroy() {
                node.removeEventListener('pointerdown', down);
                node.removeEventListener('pointermove', move);
                node.removeEventListener('pointerup', up);
                node.removeEventListener('pointercancel', up);
            },
        };
    }

    return { handle, active: () => current !== null };
}
