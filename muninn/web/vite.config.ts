import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/** RAVEN_DEV_API from the environment, without needing Node's types here. */
function devApi(): string | undefined {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    return g.process?.env?.RAVEN_DEV_API;
}

export default defineConfig({
    plugins: [sveltekit()],
    server: {
        // `npm run dev`: the page is at http://localhost:5174/muninn/ and its API
        // calls go to a muninn-server on this machine (cargo run -p muninn-server),
        // which answers under /muninn/v1 as well as /v1. Open from the Fold over
        // Tailscale with --host.
        port: 5174,
        strictPort: true,
        proxy: {
            '/muninn/v1': { target: devApi() ?? 'http://127.0.0.1:8082', changeOrigin: false, ws: true }
        }
    }
});
