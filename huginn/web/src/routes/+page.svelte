<script lang="ts">
    import { getContext } from 'svelte';
    import { goto } from '$app/navigation';
    import { base } from '$app/paths';
    import type { Index } from '$lib/notes';

    const index = getContext<Index>('index');
    const notes = index.notes;

    function newList() {
        const id = index.create('checklist');
        void goto(`${base}/n/${id}`);
    }

    function when(ms: number): string {
        const d = new Date(ms);
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        return sameDay
            ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
</script>

{#if $notes.length === 0}
    <section class="card empty">
        <h1 style="margin-top: 0">Nothing here yet</h1>
        <p class="muted">Start with a shopping list. Checked items drop to the bottom; drag the handle to reorder.</p>
        <button class="btn primary" type="button" onclick={newList}>New list</button>
    </section>
{:else}
    <div class="notes">
        {#each $notes as n (n.id)}
            <a class="card note-card" href="{base}/n/{n.id}">
                <h2>{n.title || 'Untitled list'}</h2>
                {#if n.preview}
                    <ul class="preview">
                        {#each n.preview.split('\n') as line}
                            <li>{line || '…'}</li>
                        {/each}
                        {#if n.open > 4}
                            <li class="more">+{n.open - 4} more</li>
                        {/if}
                    </ul>
                {/if}
                <p class="small muted meta">
                    {#if n.done}{n.done} of {n.open + n.done} done ·
                    {/if}{when(n.updated)}
                </p>
            </a>
        {/each}
    </div>
    <button class="fab" type="button" onclick={newList} aria-label="New list">+</button>
{/if}
