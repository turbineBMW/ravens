<script lang="ts">
    import '../app.css';
    import { onMount, setContext } from 'svelte';
    import { omarchyHint, omarchyState, omarchyThemeName, setFollowOmarchy, startOmarchy } from '@ravens/ui/omarchy';
    import type { HealthResponse, Identity } from '@ravens/ui/api';
    import { api } from '$lib/api';
    import { openIndex } from '$lib/notes';
    import { page } from '$app/state';
    import NotesList from '$lib/NotesList.svelte';

    let { children } = $props();

    // The user's index of notes stays open for the life of the page; routes
    // pick it up from context.
    const index = openIndex();
    setContext('index', index);
    const status = index.doc.status;
    const synced = index.doc.synced;
    const outdated = index.doc.outdated;

    let listWidth = $state(300);
    function saveWidth(value: string) {
        listWidth = Number(value);
        try {
            localStorage.setItem('huginn-list-width', value);
        } catch {
            /* Storage may be unavailable. */
        }
    }

    let me = $state<Identity | null>(null);
    let meError = $state('');
    let health = $state<HealthResponse | null>(null);
    let installPrompt = $state<Window['__installPrompt'] | null>(null);

    const statusHint: Record<string, string> = {
        online: 'Library connected to the server.',
        connecting: 'Connecting to the server…',
        offline: 'Library offline. Reconnect to sync with other devices.',
    };

    async function install() {
        await installPrompt?.prompt();
        installPrompt = null;
    }

    onMount(() => {
        try {
            const stored = Number(localStorage.getItem('huginn-list-width'));
            if (stored >= 280 && stored <= 360) listWidth = stored;
        } catch {
            /* Use the default width. */
        }
        api.me().then(
            (id) => (me = id),
            (e) => (meError = e instanceof Error ? e.message : String(e)),
        );
        api.health().then(
            (h) => (health = h),
            () => undefined,
        );
        const stopOmarchy = startOmarchy();
        const onInstallable = () => (installPrompt = window.__installPrompt ?? null);
        onInstallable();
        window.addEventListener('ravens-installable', onInstallable);
        return () => {
            stopOmarchy();
            window.removeEventListener('ravens-installable', onInstallable);
        };
    });
</script>

<main style:--list-width={`${listWidth}px`} class="workspace" class:has-selection={!!page.params.id}>
    <aside class="notes-pane" aria-label="Notes library">
        <NotesList {index}>
            {#snippet settings()}
                <p class="small muted menu-note">
                    {#if me}
                        Signed in as <strong>{me.name ?? me.login}</strong> through Tailscale.
                    {:else if meError}
                        Not signed in: {meError}
                    {:else}
                        Signing in…
                    {/if}
                    <span style="display: block"
                        >{$outdated
                            ? 'Update required: close and reopen Huginn.'
                            : statusHint[$status] + ($synced ? '' : ' Not yet synced this session.')}</span
                    >
                </p>
                <label class="toggle">
                    <input
                        type="checkbox"
                        checked={$omarchyState !== 'off'}
                        onchange={(e) => setFollowOmarchy(e.currentTarget.checked)}
                    />
                    <span>
                        Follow the Omarchy theme
                        <span class="small muted" style="display: block">
                            {$omarchyState === 'on' && $omarchyThemeName
                                ? `Following ${$omarchyThemeName}.`
                                : omarchyHint[$omarchyState]}
                        </span>
                    </span>
                </label>
                <label class="wide-setting small"
                    >Notes list width
                    <input
                        type="range"
                        min="280"
                        max="360"
                        step="10"
                        value={listWidth}
                        oninput={(e) => saveWidth(e.currentTarget.value)}
                    />
                </label>
                {#if installPrompt}
                    <button class="btn" type="button" onclick={() => void install()}>Install as an app</button>
                {/if}
                <p class="small muted menu-note">
                    <a href="/muninn/">Open Muninn</a>
                    {#if health}
                        · huginn-server {health.version}, schema {health.schema}
                    {/if}
                </p>
            {/snippet}
        </NotesList>
    </aside>
    <section class="editor-pane" aria-label="Selected note">
        {@render children()}
    </section>
</main>
