<script lang="ts">
    import '../app.css';
    import { onMount, setContext } from 'svelte';
    import { base } from '$app/paths';
    import { omarchyHint, omarchyState, omarchyThemeName, setFollowOmarchy, startOmarchy } from '@ravens/ui/omarchy';
    import type { HealthResponse, Identity } from '@ravens/ui/api';
    import { api } from '$lib/api';
    import { openIndex } from '$lib/tasks';
    import { disablePush, enablePush, pushState, refreshPushState, testPush } from '$lib/push';

    let { children } = $props();

    const index = openIndex();
    setContext('index', index);
    const status = index.doc.status;
    const synced = index.doc.synced;

    let me = $state<Identity | null>(null);
    let meError = $state('');
    let health = $state<HealthResponse | null>(null);
    let installPrompt = $state<Window['__installPrompt'] | null>(null);

    const pushHint: Record<string, string> = {
        unsupported: 'This browser cannot receive push notifications.',
        denied: 'Notifications are blocked for this site in the browser settings.',
        off: 'Get reminders on this device, even with the app closed.',
        on: 'Reminders arrive on this device.',
        working: 'One moment…',
    };
    let pushTest = $state('');

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
    <a class="brand" href="{base}/"><img src="{base}/icon-192.png" alt="" /> Muninn</a>
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
            <label class="toggle">
                <input
                    type="checkbox"
                    checked={$pushState === 'on'}
                    disabled={$pushState === 'unsupported' || $pushState === 'denied' || $pushState === 'working'}
                    onchange={(e) => void (e.currentTarget.checked ? enablePush() : disablePush())}
                />
                <span>
                    Notify on this device
                    <span class="small muted" style="display: block">{pushHint[$pushState]} {pushTest}</span>
                    {#if $pushState === 'on'}
                        <button
                            class="chip"
                            type="button"
                            onclick={() =>
                                testPush().then((ok) => (pushTest = ok ? 'Sent a test.' : 'The test failed.'))}
                            >Send a test</button
                        >
                    {/if}
                </span>
            </label>
            {#if installPrompt}
                <button class="btn" type="button" onclick={() => void install()}>Install as an app</button>
            {/if}
            <p class="small muted" style="margin: 8px 0 0">
                <a href="/huginn/">Open Huginn</a>
                {#if health}
                    · muninn-server {health.version}, schema {health.schema}
                {/if}
            </p>
        </div>
    </details>
</header>

<main>
    {@render children()}
</main>
