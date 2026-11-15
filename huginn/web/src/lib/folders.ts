/**
 * Folders as the notes list shows them, worked out from the index's folders
 * the same way on every device, whatever order changes arrived in: a folder
 * whose parent is gone sits at the top level, and so does a note whose folder
 * is gone, so nothing disappears. Storage and edits are in notes.ts.
 */

export interface Folder {
    id: string;
    name: string;
    /** The folder it's in; '' at the top level. */
    parent: string;
    created: number;
    /** Zero unless it's in Recently Deleted. */
    deletedAt: number;
    /** The folder whose deletion took this one with it (its own id for the one deleted). */
    deletedWith: string;
}

export interface FolderRow {
    folder: Folder;
    /** 0 at the top level. */
    depth: number;
}

const byName = (a: Folder, b: Folder) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id);

/**
 * Each live folder's parent as shown: its own when that is live, otherwise
 * the top level. Two devices moving folders into each other offline can make
 * a loop; the folder with the lowest id in it moves to the top level.
 */
export function shownParents(all: Folder[]): Map<string, string> {
    const live = new Map(all.filter((f) => !f.deletedAt).map((f) => [f.id, f]));
    const parent = new Map<string, string>();
    for (const f of live.values()) parent.set(f.id, live.has(f.parent) && f.parent !== f.id ? f.parent : '');
    for (const start of live.keys()) {
        const path: string[] = [];
        let at = start;
        while (at && !path.includes(at)) {
            path.push(at);
            at = parent.get(at) ?? '';
        }
        if (at) {
            const loop = path.slice(path.indexOf(at));
            parent.set(
                loop.reduce((a, b) => (a < b ? a : b)),
                '',
            );
        }
    }
    return parent;
}

/** Each live folder's subfolders as shown, by name; '' holds the top-level ones. */
export function childFolders(all: Folder[]): Map<string, Folder[]> {
    const parents = shownParents(all);
    const children = new Map<string, Folder[]>();
    for (const f of all) {
        if (f.deletedAt) continue;
        const p = parents.get(f.id) ?? '';
        children.set(p, [...(children.get(p) ?? []), f]);
    }
    for (const list of children.values()) list.sort(byName);
    return children;
}

/** The live folders in the order the drawer lists them: each followed by its subfolders, by name. */
export function folderTree(all: Folder[]): FolderRow[] {
    const children = childFolders(all);
    const rows: FolderRow[] = [];
    const visit = (parent: string, depth: number) => {
        for (const folder of children.get(parent) ?? []) {
            rows.push({ folder, depth });
            visit(folder.id, depth + 1);
        }
    };
    visit('', 0);
    return rows;
}

/** A live folder and every live folder inside it, at any depth. */
export function within(all: Folder[], id: string): Set<string> {
    const parents = shownParents(all);
    const found = new Set<string>();
    if (!parents.has(id)) return found;
    found.add(id);
    let grew = true;
    while (grew) {
        grew = false;
        for (const [f, p] of parents) {
            if (!found.has(f) && found.has(p)) {
                found.add(f);
                grew = true;
            }
        }
    }
    return found;
}

/** The folder a note shows in: its own when that is live, otherwise the top level. */
export function shownFolder(folder: string, live: Set<string>): string {
    return live.has(folder) ? folder : '';
}

/** A folder's name with the folders above it, for showing where a note is: "Work › Turbines". */
export function folderPath(all: Folder[], id: string): string {
    const parents = shownParents(all);
    const names = new Map(all.map((f) => [f.id, f.name]));
    const path: string[] = [];
    for (let at = id; at && parents.has(at); at = parents.get(at) ?? '')
        path.unshift(names.get(at) || 'Untitled folder');
    return path.join(' › ');
}
