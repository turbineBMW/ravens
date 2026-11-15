/**
 * The whole library in one file, and back. A Huginn archive is a zip of:
 *
 * - `manifest.json`: `{ format: 'huginn-archive', version: 1, exported, notes, files }`,
 *   each note's title, folder and dates, each file's media type and size;
 * - `index.yjs`: the index document (notes, folders, Smart Folders), as a Yjs update;
 * - `notes/<id>.yjs`: every note, Recently Deleted included, as a Yjs update,
 *   so nothing about it is lost, its history of edits included;
 * - `files/<id>`: every attachment and thumbnail, as it was stored.
 *
 * Importing merges it into this library, as another device's edits would:
 * Yjs updates combine, so importing an archive twice, or into the library it
 * came from, changes nothing, and files keep their ids (the server already
 * has any it stored before). A zip that isn't an archive, such as a note
 * exported as Markdown with its attachments, is imported as Markdown.
 */
import { get, type Readable } from 'svelte/store';
import { unzipSync, zipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import * as Y from 'yjs';
import { base } from '$app/paths';
import { openDoc } from '@ravens/ui/sync';
import { addFile, fileBlob } from '$lib/files';
import { importText, type ImportReport } from '$lib/importText';
import type { Index } from '$lib/notes';

const FORMAT = 'huginn-archive';
const VERSION = 1;
/** How long to wait for a note's copy on the server before leaving it out. */
const FETCH_MS = 15_000;

interface Manifest {
    format: string;
    version: number;
    exported: number;
    notes: { id: string; title: string; folder: string; created: number; updated: number; deleted: boolean }[];
    files: Record<string, { type: string; size: number }>;
}

function whenTrue(store: Readable<boolean>, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
        let stop = () => {};
        const timer = setTimeout(() => {
            stop();
            resolve(false);
        }, ms);
        stop = store.subscribe((value) => {
            if (!value) return;
            clearTimeout(timer);
            queueMicrotask(() => stop());
            resolve(true);
        });
    });
}

/** Every file a note's body refers to: attachments and their thumbnails. */
function filesIn(doc: Y.Doc): string[] {
    const ids: string[] = [];
    const visit = (node: Y.XmlElement | Y.XmlFragment) => {
        for (const child of node.toArray()) {
            if (!(child instanceof Y.XmlElement)) continue;
            if (child.nodeName === 'attachment' && child.getAttribute('kind') !== 'link') {
                for (const key of ['blob', 'thumb']) {
                    const id = String(child.getAttribute(key) ?? '');
                    if (id) ids.push(id);
                }
            } else if (child.nodeName === 'attachment') {
                const thumb = String(child.getAttribute('thumb') ?? '');
                if (thumb) ids.push(thumb);
            }
            visit(child);
        }
    };
    visit(doc.getXmlFragment('body'));
    return ids;
}

export interface ArchiveReport {
    name: string;
    bytes: Uint8Array;
    notes: number;
    files: number;
    /** Notes or files that couldn't be had, in words. */
    missing: string[];
}

/** The library as an archive. Notes not on this device are fetched first. */
export async function exportLibrary(index: Index, progress: (text: string) => void): Promise<ArchiveReport> {
    const all = get(index.notes);
    const manifest: Manifest = { format: FORMAT, version: VERSION, exported: Date.now(), notes: [], files: {} };
    const entries: Zippable = {};
    entries['index.yjs'] = [Y.encodeStateAsUpdate(index.doc.doc), { level: 6 }];
    const fileIds = new Set<string>();
    let missedNotes = 0;
    for (const [i, n] of all.entries()) {
        progress(`Reading note ${i + 1} of ${all.length}…`);
        const doc = openDoc(base, `note:${n.id}`);
        try {
            await doc.whenLocal;
            const local = doc.doc.getMap('meta').size > 0 || doc.doc.getXmlFragment('body').length > 0;
            if (!local && !(await whenTrue(doc.synced, FETCH_MS))) {
                missedNotes++;
                continue;
            }
            entries[`notes/${n.id}.yjs`] = [Y.encodeStateAsUpdate(doc.doc), { level: 6 }];
            for (const id of filesIn(doc.doc)) fileIds.add(id);
            manifest.notes.push({
                id: n.id,
                title: n.title,
                folder: n.folder,
                created: n.created,
                updated: n.updated,
                deleted: !!n.deletedAt,
            });
        } finally {
            doc.release();
        }
    }
    let missedFiles = 0;
    let done = 0;
    for (const id of fileIds) {
        progress(`Reading attachment ${++done} of ${fileIds.size}…`);
        const blob = await fileBlob(id);
        if (!blob) {
            missedFiles++;
            continue;
        }
        manifest.files[id] = { type: blob.type || 'application/octet-stream', size: blob.size };
        // Stored: photos and PDFs are compressed already.
        entries[`files/${id}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
    }
    entries['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
    progress('Writing the archive…');
    const missing = [
        ...(missedNotes
            ? [
                  `${missedNotes} ${missedNotes === 1 ? 'note' : 'notes'} not on this device, and the server couldn’t be reached`,
              ]
            : []),
        ...(missedFiles
            ? [
                  `${missedFiles} ${missedFiles === 1 ? 'attachment' : 'attachments'} not on this device or the server yet`,
              ]
            : []),
    ];
    const day = new Date().toISOString().slice(0, 10);
    return {
        name: `Huginn archive ${day}.zip`,
        bytes: zipSync(entries),
        notes: manifest.notes.length,
        files: Object.keys(manifest.files).length,
        missing,
    };
}

/** Apply a Yjs update to a stored document, waiting until this device has it. */
async function merge(name: string, update: Uint8Array) {
    const doc = openDoc(base, name);
    try {
        await doc.whenLocal;
        Y.applyUpdate(doc.doc, update);
    } finally {
        // It lingers open, connected, long enough to sync to the server.
        doc.release();
    }
}

/**
 * Files into the library: Markdown and text files as new notes, a Huginn
 * archive merged in, and other zips searched for Markdown and text, with the
 * images they refer to. `folder`: where new notes go.
 */
export async function importFiles(
    index: Index,
    files: File[],
    progress: (text: string) => void,
    folder = '',
): Promise<ImportReport> {
    const report: ImportReport = { notes: 0, files: 0, lost: [] };
    const lost = new Set<string>();
    for (const file of files) {
        if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
            progress(`Opening ${file.name}…`);
            let entries: Record<string, Uint8Array>;
            try {
                entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
            } catch {
                lost.add(`“${file.name}” isn’t a zip that can be read`);
                continue;
            }
            const manifest = entries['manifest.json']
                ? (JSON.parse(strFromU8(entries['manifest.json'])) as Manifest)
                : null;
            if (manifest?.format === FORMAT) {
                if (manifest.version > VERSION) {
                    lost.add(`“${file.name}” is from a newer Huginn; update this one first`);
                    continue;
                }
                if (entries['index.yjs']) Y.applyUpdate(index.doc.doc, entries['index.yjs']);
                const notes = Object.keys(entries).filter((k) => /^notes\/[^/]+\.yjs$/.test(k));
                for (const [i, key] of notes.entries()) {
                    progress(`Importing note ${i + 1} of ${notes.length}…`);
                    await merge(`note:${key.slice('notes/'.length, -'.yjs'.length)}`, entries[key]);
                    report.notes++;
                }
                const blobs = Object.keys(entries).filter((k) => k.startsWith('files/'));
                for (const [i, key] of blobs.entries()) {
                    progress(`Importing attachment ${i + 1} of ${blobs.length}…`);
                    const id = key.slice('files/'.length);
                    const type = manifest.files[id]?.type ?? 'application/octet-stream';
                    try {
                        await addFile(new Blob([entries[key] as BlobPart], { type }), id);
                        report.files++;
                    } catch {
                        lost.add('Attachments that couldn’t be stored on this device');
                    }
                }
                continue;
            }
            // A zip of Markdown, with what it refers to beside it.
            const assets = new Map<string, Blob>();
            for (const [path, bytes] of Object.entries(entries)) {
                if (!/\.(md|markdown|txt)$/i.test(path))
                    assets.set(path, new Blob([bytes as BlobPart], { type: mediaType(path) }));
            }
            const texts = Object.keys(entries).filter(
                (p) => /\.(md|markdown|txt)$/i.test(p) && !p.startsWith('__MACOSX/'),
            );
            if (!texts.length) lost.add(`“${file.name}” has no notes in it`);
            for (const path of texts) {
                progress(`Importing ${path}…`);
                const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
                const relative = new Map([...assets].map(([p, b]) => [p.startsWith(dir) ? p.slice(dir.length) : p, b]));
                const out = await importText(index, path, strFromU8(entries[path]), relative, folder);
                out.lost.forEach((l) => lost.add(l));
                report.notes++;
            }
            continue;
        }
        if (/\.(md|markdown|txt)$/i.test(file.name) || file.type.startsWith('text/')) {
            progress(`Importing ${file.name}…`);
            const out = await importText(index, file.name, await file.text(), new Map(), folder);
            out.lost.forEach((l) => lost.add(l));
            report.notes++;
            continue;
        }
        lost.add(`“${file.name}”: only Markdown, text and zips can be imported`);
    }
    report.lost = [...lost];
    return report;
}

/** A media type from a file's extension, for files inside a zip. */
function mediaType(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return (
        {
            png: 'image/png',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            gif: 'image/gif',
            webp: 'image/webp',
            svg: 'image/svg+xml',
            pdf: 'application/pdf',
            mp4: 'video/mp4',
            webm: 'video/webm',
            mov: 'video/quicktime',
        }[ext] ?? 'application/octet-stream'
    );
}
