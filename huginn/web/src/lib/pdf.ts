/**
 * PDFs, through pdf.js, loaded only when a PDF is shown or added: it's a large
 * library, and most notes never need it.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';

let loading: Promise<typeof import('pdfjs-dist')> | null = null;

export function pdfjs() {
    loading ??= (async () => {
        const lib = await import('pdfjs-dist');
        const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
        lib.GlobalWorkerOptions.workerSrc = worker.default;
        return lib;
    })();
    return loading;
}

export interface OpenedPdf {
    pdf: PDFDocumentProxy;
    /** Let go of the document and its worker's copy. */
    close: () => Promise<void>;
}

export async function openPdf(bytes: ArrayBuffer): Promise<OpenedPdf> {
    const lib = await pdfjs();
    // pdf.js may take the buffer over, so it gets a copy. Its scripting is off by default.
    const task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
    const pdf = await task.promise;
    return { pdf, close: () => task.destroy() };
}

/** Draw a page into a canvas `width` CSS pixels wide, sharp at this screen's density. */
export async function renderPage(pdf: PDFDocumentProxy, number: number, canvas: HTMLCanvasElement, width: number) {
    const page = await pdf.getPage(number);
    const unscaled = page.getViewport({ scale: 1 });
    const ratio = Math.min(devicePixelRatio || 1, 3);
    const viewport = page.getViewport({ scale: (width / unscaled.width) * ratio });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${(viewport.height / viewport.width) * width}px`;
    await page.render({ canvas, viewport }).promise;
    page.cleanup();
}
