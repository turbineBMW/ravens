<script lang="ts">
    /** Choosing where something goes: the top level or any folder, nested as in the drawer. */
    import type { FolderRow } from '$lib/folders';

    let {
        rows,
        current,
        exclude = new Set<string>(),
        onpick,
    }: {
        rows: FolderRow[];
        /** Where it is now, if one place: marked, and not offered. */
        current: string | null;
        /** Folders it can't go in, such as a folder and the folders inside it. */
        exclude?: Set<string>;
        onpick: (folder: string) => void;
    } = $props();
</script>

<div class="folder-picker" role="group" aria-label="Folders">
    <button class="btn" type="button" aria-current={current === ''} disabled={current === ''} onclick={() => onpick('')}
        >No folder</button
    >
    {#each rows as { folder, depth } (folder.id)}
        <button
            class="btn"
            type="button"
            style:padding-left="{12 + depth * 16}px"
            aria-current={current === folder.id}
            disabled={current === folder.id || exclude.has(folder.id)}
            onclick={() => onpick(folder.id)}>{folder.name || 'Untitled folder'}</button
        >
    {/each}
</div>
