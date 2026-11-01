<script lang="ts">
    import '../app.css';
    import { onMount, setContext } from 'svelte';
    import { base } from '$app/paths';
    import { omarchyHint, omarchyState, omarchyThemeName, setFollowOmarchy, startOmarchy } from '@ravens/ui/omarchy';
    import type { HealthResponse, Identity } from '@ravens/ui/api';
    import { api } from '$lib/api';
    import { openIndex } from '$lib/notes';

    let { children } = $props();

    // The user's index of notes stays open for the life of the page; routes
    // pick it up from context.
    const index = openIndex();
    setContext('index', index);
    const status = index.doc.status;
    const synced = index.doc.synced;

    let me = $state<Identity | null>(null);
    let meError = $state('');
    let health = $state<HealthResponse | null>(null);
    let installPrompt = $state<Window['__installPrompt'] | null>(null);

    const statusHint: Record<string, string> = {
        online: 'Connected: changes sync as you make them.',
        connecting: 'Connecting to the server…',
        offline: 'Offline: changes are kept on this device and sync when the server is back.',
    };

    async function install() {
        await installPrompt?.prompt();
        installPrompt = null;
    }

    onMount(() => {
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

<header class="topbar">
    <a class="brand" href="{base}/"><img src="{base}/icon-192.png" alt="" /> Huginn</a>
    <span class="spacer"></span>
    <span class="sync {$status}" title={statusHint[$status]} aria-label={statusHint[$status]} role="status"></span>
    <details class="menu">
        <summary class="btn" aria-label="Settings">⋯</summary>
        <div class="sheet">
            <p class="small muted" style="margin: 0 0 8px">
                {#if me}
                    Signed in as <strong>{me.name ?? me.login}</strong> through Tailscale.
                {:else if meError}
                    Not signed in: {meError}
                {:else}
                    Signing in…
                {/if}
                <span style="display: block">{statusHint[$status]}{$synced ? '' : ' Not yet synced this session.'}</span
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
            {#if installPrompt}
                <button class="btn" type="button" onclick={() => void install()}>Install as an app</button>
            {/if}
            <p class="small muted" style="margin: 8px 0 0">
                <a href="/muninn/">Open Muninn</a>
                {#if health}
                    · huginn-server {health.version}, schema {health.schema}
                {/if}
            </p>
        </div>
    </details>
</header>

<main>
    {@render children()}
</main>
