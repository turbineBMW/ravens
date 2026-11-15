<script lang="ts">
    /**
     * What can be done with an address, a phone number or a link that was
     * clicked or tapped in a note: open, mail, call or message it, copy it, or
     * edit a link. Opened by a tap, it leaves the editor's focus alone, so a
     * phone's keyboard doesn't come up or go away; opened from the keyboard
     * (Alt+Enter), its first action takes focus, the arrows move and Escape
     * goes back to the note.
     */
    import { onMount, tick } from 'svelte';
    import { actionsFor, copyText } from '$lib/detect';
    import { openHref, type DetectedAt } from '$lib/dataDetectors';

    let {
        found,
        byKeyboard,
        left,
        top,
        bottom,
        onclose,
        onedit,
    }: {
        found: DetectedAt;
        byKeyboard: boolean;
        left: number;
        top: number;
        bottom: number;
        /** `refocus`: put focus back in the note, as after Escape. */
        onclose: (refocus: boolean) => void;
        onedit: () => void;
    } = $props();

    const actions = $derived(
        found.kind === 'link' ? [{ label: 'Open link', href: found.href }] : actionsFor(found.kind, found.href),
    );
    const copyLabel = $derived(
        found.kind === 'email' ? 'Copy address' : found.kind === 'phone' ? 'Copy number' : 'Copy link',
    );
    let copied = $state(false);

    async function copy() {
        const text = found.kind === 'link' ? found.href : copyText(found.kind, found.href, found.text);
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
            setTimeout(() => onclose(byKeyboard), 700);
        } catch {
            copied = false;
        }
    }
    function run(href: string) {
        openHref(href);
        onclose(false);
    }

    const WIDTH = 220;
    const GAP = 4;
    let menu: HTMLDivElement;
    let height = $state(0);
    const y = $derived.by(() => {
        const visible = window.visualViewport?.height ?? innerHeight;
        const below = bottom + GAP;
        return below + height > visible - 8 && top - GAP - height > 8 ? top - GAP - height : below;
    });

    function onKey(event: KeyboardEvent) {
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape') {
            event.preventDefault();
            onclose(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const by = event.key === 'ArrowDown' ? 1 : -1;
            buttons[(at + by + buttons.length) % buttons.length]?.focus();
        } else if (event.key === 'Tab' && at >= 0) {
            // Out of the menu is back to the note.
            event.preventDefault();
            onclose(true);
        }
    }

    onMount(() => {
        if (byKeyboard) void tick().then(() => menu.querySelector('button')?.focus());
        const onPress = (event: PointerEvent) => {
            if (!menu.contains(event.target as Node)) onclose(false);
        };
        const onWindowKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !menu.contains(event.target as Node)) onclose(true);
        };
        // The press that opened it has been and gone by now.
        document.addEventListener('pointerdown', onPress, true);
        document.addEventListener('keydown', onWindowKey);
        return () => {
            document.removeEventListener('pointerdown', onPress, true);
            document.removeEventListener('keydown', onWindowKey);
        };
    });
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
    class="detected-menu"
    role="menu"
    aria-label={found.text}
    bind:this={menu}
    bind:clientHeight={height}
    style:left="{Math.max(8, Math.min(left, innerWidth - WIDTH - 8))}px"
    style:top="{y}px"
    onkeydown={onKey}
>
    <p class="detected-text small muted">{found.text}</p>
    {#each actions as action (action.label)}
        <button
            type="button"
            role="menuitem"
            onmousedown={(e) => !byKeyboard && e.preventDefault()}
            onclick={() => run(action.href)}>{action.label}</button
        >
    {/each}
    <button
        type="button"
        role="menuitem"
        onmousedown={(e) => !byKeyboard && e.preventDefault()}
        onclick={() => void copy()}>{copied ? 'Copied' : copyLabel}</button
    >
    {#if found.mark}
        <button type="button" role="menuitem" onmousedown={(e) => !byKeyboard && e.preventDefault()} onclick={onedit}
            >Edit link</button
        >
    {/if}
</div>
