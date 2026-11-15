/**
 * What a note shows of an attachment before (and instead of) the whole file:
 * its kind, its size, and a small image of it, made here on the device that
 * adds it, since the server never reads attachments (see files.ts).
 */
import { openPdf, renderPage } from '$lib/pdf';

export type AttachmentKind = 'image' | 'video' | 'pdf' | 'file' | 'link';

/** The longest side of a thumbnail, in pixels: sharp at twice the size it's usually shown. */
export const THUMB_SIZE = 960;

export interface Made {
    kind: AttachmentKind;
    width: number;
    height: number;
    /** A PDF's pages. */
    pages: number;
    /** A small image of it, or null when the original is small enough to show itself, or none can be made. */
    thumb: Blob | null;
}

export function kindOf(type: string, name: string): AttachmentKind {
    if (/^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(type)) return 'image';
    if (/^video\//.test(type)) return 'video';
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
    return 'file';
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => {
        canvas.toBlob(
            (b) => {
                // WebP where the browser writes it, otherwise JPEG.
                if (b && b.type === 'image/webp') resolve(b);
                else canvas.toBlob((j) => resolve(j), 'image/jpeg', 0.85);
            },
            'image/webp',
            0.85,
        );
    });
}

function scaled(width: number, height: number, max = THUMB_SIZE) {
    const s = Math.min(1, max / Math.max(width, height, 1));
    return { w: Math.max(1, Math.round(width * s)), h: Math.max(1, Math.round(height * s)) };
}

async function imageThumb(file: Blob): Promise<Made> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        // A format this browser can't draw (HEIC, say): kept as a file.
        return { kind: 'file', width: 0, height: 0, pages: 0, thumb: null };
    }
    const { width, height } = bitmap;
    // Small enough already, and not animated or vector: the original is its own thumbnail.
    if (Math.max(width, height) <= THUMB_SIZE && file.size < 400_000) {
        bitmap.close();
        return { kind: 'image', width, height, pages: 0, thumb: null };
    }
    const { w, h } = scaled(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return { kind: 'image', width, height, pages: 0, thumb: await canvasBlob(canvas) };
}

function videoThumb(file: Blob): Promise<Made> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.playsInline = true;
        let settled = false;
        const done = (made: Made) => {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(url);
            video.removeAttribute('src');
            video.load();
            resolve(made);
        };
        const none = () =>
            done({ kind: 'video', width: video.videoWidth, height: video.videoHeight, pages: 0, thumb: null });
        video.onloadedmetadata = () => {
            // A frame a little way in, which is less often black than the first.
            video.currentTime = Math.min(1, (video.duration || 0) / 2);
        };
        video.onseeked = async () => {
            const { w, h } = scaled(video.videoWidth, video.videoHeight);
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            try {
                canvas.getContext('2d')!.drawImage(video, 0, 0, w, h);
                done({
                    kind: 'video',
                    width: video.videoWidth,
                    height: video.videoHeight,
                    pages: 0,
                    thumb: await canvasBlob(canvas),
                });
            } catch {
                none();
            }
        };
        video.onerror = none;
        setTimeout(none, 10_000);
        video.src = url;
    });
}

async function pdfThumb(file: Blob): Promise<Made> {
    try {
        const { pdf, close } = await openPdf(await file.arrayBuffer());
        const first = await pdf.getPage(1);
        const view = first.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        // renderPage sizes for the screen's density; a thumbnail wants fixed pixels.
        const width = Math.round(THUMB_SIZE / 2 / Math.min(devicePixelRatio || 1, 3));
        await renderPage(pdf, 1, canvas, width);
        const made: Made = {
            kind: 'pdf',
            width: Math.round(view.width),
            height: Math.round(view.height),
            pages: pdf.numPages,
            thumb: await canvasBlob(canvas),
        };
        await close();
        return made;
    } catch {
        // Damaged, or protected: still a PDF, shown by its name.
        return { kind: 'pdf', width: 0, height: 0, pages: 0, thumb: null };
    }
}

/** What to show for a file being added. Never throws: at worst it's a file with a name. */
export async function describe(file: File | Blob, name: string): Promise<Made> {
    const kind = kindOf(file.type, name);
    try {
        if (kind === 'image') return await imageThumb(file);
        if (kind === 'video') return await videoThumb(file);
        if (kind === 'pdf') return await pdfThumb(file);
    } catch {
        /* Fall through. */
    }
    return { kind, width: 0, height: 0, pages: 0, thumb: null };
}
