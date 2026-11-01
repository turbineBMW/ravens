import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
    preprocess: vitePreprocess(),
    kit: {
        // A single-page app: one index.html, every route rendered in the
        // browser. huginn-server serves `build/` under /huginn and answers
        // unknown paths there with index.html.
        adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', precompress: false, strict: false }),
        paths: { base: '/huginn' }
    }
};

export default config;
