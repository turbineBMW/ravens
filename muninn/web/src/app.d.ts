// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
    namespace App {}
    interface Window {
        __installPrompt?: Event & { prompt: () => Promise<void> };
    }
}

export {};
