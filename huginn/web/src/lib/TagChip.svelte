<script lang="ts">
    /**
     * One tag in the notes list's filter: notes with it, or without it. Its
     * menu switches between the two, renames or deletes the tag in every note,
     * or takes it out of the filter.
     */
    import { dismiss } from '$lib/dismiss';
    import type { Index } from '$lib/notes';
    import { renameTag } from '$lib/tagEdits';
    import { cleanTag, tagFilter, tagsFresh, type TagInfo } from '$lib/tags';

    let { index, tag, info, excluded }: { index: Index; tag: string; info: TagInfo | undefined; excluded: boolean } =
        $props();

    let menu: HTMLDetailsElement;
    let mode = $state<'menu' | 'rename' | 'delete' | 'working'>('menu');
    let name = $state('');
    let message = $state('');
    const label = $derived(`#${info?.name ?? tag}`);
    const count = $derived(info?.notes.length ?? 0);
    const notes = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`;
    const focus = (input: HTMLInputElement) => input.focus();

    function close() {
        // A rename or delete can take this chip out of the filter, and the page, before it finishes.
        if (menu) menu.open = false;
        mode = 'menu';
    }
    function flip() {
        tagFilter.update((f) =>
            excluded
                ? { include: [...f.include, tag], exclude: f.exclude.filter((t) => t !== tag) }
                : { include: f.include.filter((t) => t !== tag), exclude: [...f.exclude, tag] },
        );
        close();
    }
    function remove() {
        tagFilter.update((f) => ({
            include: f.include.filter((t) => t !== tag),
            exclude: f.exclude.filter((t) => t !== tag),
        }));
        close();
    }
    async function apply(to: string) {
        if (!info) return;
        mode = 'working';
        const { changed, missed } = await renameTag(index, info, to);
        message = missed
            ? `Changed in ${notes(changed)}. ${notes(missed)} couldn't be reached and still have ${label}; try again when connected.`
            : '';
        mode = 'menu';
        if (!missed) close();
    }
    function submit(event: SubmitEvent) {
        event.preventDefault();
        const to = cleanTag(name);
        if (to) void apply(to);
    }
</script>

<details
    class="menu tag-chip"
    bind:this={menu}
    use:dismiss
    ontoggle={(e) => !e.currentTarget.open && mode !== 'working' && (mode = 'menu')}
>
    <summary class="chip" class:excluded aria-label="{excluded ? 'Notes without' : 'Notes with'} {label}"
        >{excluded ? 'not ' : ''}{label}</summary
    >
    <div class="sheet actions">
        {#if mode === 'rename'}
            <form class="folder-form" onsubmit={submit}>
                <input bind:value={name} aria-label="New tag name" maxlength="65" use:focus />
                <button class="btn primary" type="submit" disabled={!cleanTag(name)}>Rename</button>
                <button class="btn" type="button" onclick={() => (mode = 'menu')}>Cancel</button>
            </form>
            <p class="small muted menu-note">Changes {label} in {notes(count)}.</p>
        {:else if mode === 'delete'}
            <p class="small menu-note">
                Take {label} out of {notes(count)}? The word stays: {label} becomes {label.slice(1)}.
            </p>
            <button class="btn danger" type="button" onclick={() => void apply('')}>Delete tag</button>
            <button class="btn" type="button" onclick={() => (mode = 'menu')}>Keep it</button>
        {:else if mode === 'working'}
            <p class="small menu-note" role="status">Changing {notes(count)}…</p>
        {:else}
            {#if message}<p class="small menu-note" role="alert">{message}</p>{/if}
            <button class="btn" type="button" onclick={flip}
                >{excluded ? 'Show notes with it' : 'Show notes without it'}</button
            >
            {#if info && $tagsFresh}
                <button
                    class="btn"
                    type="button"
                    onclick={() => {
                        name = info.name;
                        mode = 'rename';
                    }}>Rename tag…</button
                >
                <button class="btn" type="button" onclick={() => (mode = 'delete')}>Delete tag…</button>
            {:else}
                <p class="small muted menu-note">Renaming and deleting tags need a connection.</p>
            {/if}
            <button class="btn" type="button" onclick={remove}>Remove from filter</button>
        {/if}
    </div>
</details>
