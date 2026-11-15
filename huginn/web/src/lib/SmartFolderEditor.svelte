<script lang="ts">
    /**
     * Making or changing a Smart Folder: its name, whether notes must match all
     * of its conditions or any, and the conditions. Saved when closed with Save.
     */
    import { onMount } from 'svelte';
    import type { FolderRow } from '$lib/folders';
    import type { Index } from '$lib/notes';
    import type { Condition, SmartFolder } from '$lib/smartFolders';
    import type { TagInfo } from '$lib/tags';

    let {
        index,
        folder,
        draft,
        folders,
        tags,
        onclose,
    }: {
        index: Index;
        /** The Smart Folder being changed; none for a new one. */
        folder: SmartFolder | null;
        /** A new one's conditions to start from, such as the list's tag filter. */
        draft?: Condition[];
        folders: FolderRow[];
        tags: TagInfo[];
        onclose: () => void;
    } = $props();

    function fresh(kind: Condition['kind']): Condition {
        switch (kind) {
            case 'tag':
                return { kind, has: true, tag: tags[0]?.tag ?? '' };
            case 'folder':
                return { kind, within: true, folder: folders[0]?.folder.id ?? '' };
            case 'edited':
            case 'created':
                return { kind, within: true, days: 7 };
            case 'checklist':
                return { kind, state: 'open' };
            case 'pinned':
                return { kind, pinned: true };
        }
    }

    // svelte-ignore state_referenced_locally
    let name = $state(folder?.name ?? '');
    // svelte-ignore state_referenced_locally
    let match = $state<SmartFolder['match']>(folder?.match ?? 'all');
    // svelte-ignore state_referenced_locally
    let conditions = $state<Condition[]>(
        $state.snapshot(folder?.conditions ?? draft ?? [fresh(tags.length ? 'tag' : 'edited')]) as Condition[],
    );
    const valid = $derived(
        !!name.trim() &&
            conditions.length > 0 &&
            conditions.every(
                (c) =>
                    (c.kind !== 'tag' || c.tag) && (c.kind === 'edited' || c.kind === 'created' ? c.days >= 1 : true),
            ),
    );

    let dialog: HTMLDialogElement;
    onMount(() => dialog.showModal());

    function save(event: SubmitEvent) {
        event.preventDefault();
        if (!valid) return;
        const saved = $state.snapshot(conditions) as Condition[];
        if (folder) index.updateSmartFolder(folder.id, { name: name.trim(), match, conditions: saved });
        else index.createSmartFolder(name.trim(), match, saved);
        dialog.close();
    }
    const KINDS: [Condition['kind'], string][] = [
        ['tag', 'Tag'],
        ['folder', 'Folder'],
        ['edited', 'Edited'],
        ['created', 'Created'],
        ['checklist', 'Checklist'],
        ['pinned', 'Pinned'],
    ];
</script>

<dialog
    class="smart-editor"
    bind:this={dialog}
    {onclose}
    aria-label={folder ? 'Edit Smart Folder' : 'New Smart Folder'}
>
    <form onsubmit={save}>
        <h2>{folder ? 'Edit Smart Folder' : 'New Smart Folder'}</h2>
        <label class="smart-field">
            <span class="small muted">Name</span>
            <input bind:value={name} maxlength="100" placeholder="Smart Folder name" />
        </label>
        <label class="smart-field">
            <span class="small muted">Show notes that match</span>
            <select bind:value={match}>
                <option value="all">all of these</option>
                <option value="any">any of these</option>
            </select>
        </label>
        <ul class="smart-conditions" aria-label="Conditions">
            {#each conditions as c, i (i)}
                <li>
                    <span class="smart-condition">
                        <select
                            aria-label="Condition"
                            value={c.kind}
                            onchange={(e) => (conditions[i] = fresh(e.currentTarget.value as Condition['kind']))}
                        >
                            {#each KINDS as [kind, label] (kind)}<option value={kind}>{label}</option>{/each}
                        </select>
                        {#if c.kind === 'tag'}
                            <select aria-label="Has the tag" bind:value={c.has}>
                                <option value={true}>is</option>
                                <option value={false}>isn't</option>
                            </select>
                            <select aria-label="Tag" bind:value={c.tag} disabled={!tags.length}>
                                {#each tags as t (t.tag)}<option value={t.tag}>#{t.name}</option>{/each}
                                {#if !tags.length}<option value="">No tags yet</option>{/if}
                            </select>
                        {:else if c.kind === 'folder'}
                            <select aria-label="In the folder" bind:value={c.within}>
                                <option value={true}>is</option>
                                <option value={false}>isn't</option>
                            </select>
                            <select aria-label="Folder" bind:value={c.folder}>
                                <option value="">No folder</option>
                                {#each folders as { folder: f, depth } (f.id)}
                                    <option value={f.id}>{'  '.repeat(depth)}{f.name || 'Untitled folder'}</option>
                                {/each}
                            </select>
                        {:else if c.kind === 'edited' || c.kind === 'created'}
                            <select aria-label="In the last days" bind:value={c.within}>
                                <option value={true}>in the last</option>
                                <option value={false}>not in the last</option>
                            </select>
                            <input aria-label="Days" type="number" min="1" max="3650" bind:value={c.days} />
                            <span class="small muted">days</span>
                        {:else if c.kind === 'checklist'}
                            <select aria-label="Checklist state" bind:value={c.state}>
                                <option value="open">has unchecked items</option>
                                <option value="done">has every item checked</option>
                                <option value="none">has no items</option>
                            </select>
                        {:else if c.kind === 'pinned'}
                            <select aria-label="Pinned" bind:value={c.pinned}>
                                <option value={true}>yes</option>
                                <option value={false}>no</option>
                            </select>
                        {/if}
                    </span>
                    <button
                        class="icon-btn"
                        type="button"
                        aria-label="Remove this condition"
                        onclick={() => conditions.splice(i, 1)}>✕</button
                    >
                </li>
            {/each}
        </ul>
        <button class="btn" type="button" onclick={() => conditions.push(fresh(tags.length ? 'tag' : 'edited'))}
            >Add condition</button
        >
        <div class="smart-buttons">
            <button class="btn" type="button" onclick={() => dialog.close()}>Cancel</button>
            <button class="btn primary" type="submit" disabled={!valid}>Save</button>
        </div>
    </form>
</dialog>
