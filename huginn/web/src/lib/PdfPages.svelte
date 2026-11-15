<script lang="ts">
    /**
     * A PDF's pages, one under another, drawn as they scroll into view, at the
     * column's width times the zoom. Markup waits for Phase 6.
     */
    import { onMount } from 'svelte';
    import type { PDFDocumentProxy } from 'pdfjs-dist';
    import { openPdf, renderPage } from '$lib/pdf';

    let { blob }: { blob: Blob } = $props();

    let pdf = $state.raw<PDFDocumentProxy | null>(null);
    let close: (() => Promise<void>) | null = null;
    let problem = $state('');
    let zoom = $state(1);
    let width = $state(0);
    let current = $state(1);
    let host: HTMLDivElement;
    const pageWidth = $derived(Math.max(200, Math.round((width - 32) * zoom)));

    onMount(() => {
        let gone = false;
        void (async () => {
            try {
                const opened = await openPdf(await blob.arrayBuffer());
                if (gone) return void opened.close();
                close = opened.close;
                pdf = opened.pdf;
            } catch {
                problem = "This PDF can't be shown here. Download it to open it in another app.";
            }
        })();
        return () => {
            gone = true;
            void close?.();
        };
    });

    /** Draw a page when it comes near, again when the zoom changes. */
    function page(canvas: HTMLCanvasElement, number: number) {
        let drawnAt = 0;
        let near = false;
        const draw = () => {
            if (!pdf || !near || drawnAt === pageWidth) return;
            drawnAt = pageWidth;
            void renderPage(pdf, number, canvas, pageWidth).catch(() => {});
        };
        const watch = new IntersectionObserver(
            (entries) => {
                near = entries.some((e) => e.isIntersecting);
                if (entries.some((e) => e.intersectionRatio > 0.5)) current = number;
                draw();
            },
            { root: host, rootMargin: '800px 0px', threshold: [0, 0.5] },
        );
        watch.observe(canvas);
        const off = $effect.root(() => {
            $effect(() => {
                void pageWidth;
                draw();
            });
        });
        return { destroy: () => (watch.disconnect(), off()) };
    }
</script>

<div class="pdf-tools">
    <span class="small muted" role="status"
        >{pdf ? `Page ${current} of ${pdf.numPages}` : problem ? '' : 'Opening…'}</span
    >
    <button
        class="btn"
        type="button"
        aria-label="Zoom out"
        disabled={zoom <= 0.5}
        onclick={() => (zoom = Math.max(0.5, zoom - 0.25))}>−</button
    >
    <button class="btn" type="button" onclick={() => (zoom = 1)}>{Math.round(zoom * 100)}%</button>
    <button
        class="btn"
        type="button"
        aria-label="Zoom in"
        disabled={zoom >= 4}
        onclick={() => (zoom = Math.min(4, zoom + 0.25))}>+</button
    >
</div>
<div class="pdf-pages" bind:this={host} bind:clientWidth={width}>
    {#if problem}
        <p class="muted">{problem}</p>
    {:else if pdf}
        {#each Array.from({ length: pdf.numPages }, (_, i) => i + 1) as n (n)}
            <canvas
                class="pdf-page"
                use:page={n}
                aria-label="Page {n}"
                style:width="{pageWidth}px"
                style:aspect-ratio="0.7727"
            ></canvas>
        {/each}
    {/if}
</div>
