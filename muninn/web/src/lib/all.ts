/**
 * Every task across every list, for the smart views (Today, Scheduled,
 * Flagged, All). Opens each list's document; a personal number of lists
 * makes that cheap, and the documents are shared with the list pages.
 */
import { derived, get, readable, type Readable } from 'svelte/store';
import { openList, type Index, type List, type ListMeta, type Task } from '$lib/tasks';

export interface TaskIn extends Task {
    list: ListMeta;
}

export interface AllLists {
    tasks: Readable<TaskIn[]>;
    listFor(listId: string): List | undefined;
    release(): void;
}

export function openAll(index: Index): AllLists {
    const open = new Map<string, List>();
    const stop = new Set<() => void>();

    const tasks = readable<TaskIn[]>([], (set) => {
        let unsubTasks: (() => void) | null = null;
        const unsubLists = index.lists.subscribe((lists) => {
            // Open new lists, close removed ones.
            for (const l of lists) if (!open.has(l.id)) open.set(l.id, openList(l.id, index));
            for (const [id, l] of open) {
                if (!lists.some((x) => x.id === id)) {
                    l.release();
                    open.delete(id);
                }
            }
            unsubTasks?.();
            const metas = new Map(lists.map((l) => [l.id, l]));
            const stores = lists.map((l) => open.get(l.id)!.tasks);
            const merged = derived(stores, ($all) =>
                $all.flatMap((ts, i) => ts.map((t) => ({ ...t, list: metas.get(lists[i].id)! }))),
            );
            unsubTasks = merged.subscribe(set);
        });
        return () => {
            unsubLists();
            unsubTasks?.();
        };
    });

    return {
        tasks,
        listFor: (id) => open.get(id),
        release() {
            for (const f of stop) f();
            for (const l of open.values()) l.release();
            open.clear();
        },
    };
}

export { get };
