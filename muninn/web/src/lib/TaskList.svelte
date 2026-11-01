<script lang="ts">
    /**
     * A list's tasks: tap the circle to complete (it drops to the bottom),
     * drag the handle to reorder, type at the end to add, Enter for the
     * next, Backspace on an empty one to remove it. A due date and a flag
     * sit on each row; the details sheet holds the rest.
     */
    import { flip } from 'svelte/animate';
    import { tick } from 'svelte';
    import { createReorder } from '@ravens/ui/reorder';
    import { dueState, formatDue, todayIso, type List, type Task } from '$lib/tasks';

    let {
        tasks,
        list,
        /** Hide the add row and the handles: a smart view over several lists. */
        readonlyOrder = false,
        defaultDue = '',
    }: { tasks: Task[]; list: List; readonlyOrder?: boolean; defaultDue?: string } = $props();

    let draft = $state('');
    let showDone = $state(false);
    let preview = $state<string[] | null>(null);
    let detail = $state<string | null>(null);

    const open = $derived(tasks.filter((t) => !t.done));
    const done = $derived(tasks.filter((t) => t.done));
    const openOrdered = $derived.by(() => {
        if (!preview) return open;
        const byId = new Map(open.map((t) => [t.id, t]));
        const out = preview.map((id) => byId.get(id)).filter((t): t is Task => !!t);
        for (const t of open) if (!preview.includes(t.id)) out.push(t);
        return out;
    });

    const reorder = createReorder({
        order: () => open.map((t) => t.id),
        preview: (o) => (preview = o),
        commit: (id, before, after) => list.move(id, before, after),
        rows: () => [...document.querySelectorAll<HTMLElement>('ul.tasks li[data-reorder-row]:not(.done)')],
        rowId: (row) => row.dataset.task,
    });

    async function focusTask(id: string) {
        await tick();
        const el = document.querySelector<HTMLInputElement>(`[data-task="${id}"] input.text`);
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
    }

    function addFromDraft() {
        const title = draft.trim();
        if (!title) return;
        list.add(title, { due: defaultDue, allDay: true });
        draft = '';
    }

    function onKey(e: KeyboardEvent, t: Task, index: number) {
        const input = e.currentTarget as HTMLInputElement;
        if (e.key === 'Enter') {
            e.preventDefault();
            if (t.done || readonlyOrder) return;
            const id = list.add('', { afterId: t.id, parent: t.parent, due: t.due, allDay: t.allDay });
            void focusTask(id);
        } else if (e.key === 'Backspace' && input.value === '') {
            e.preventDefault();
            const prev = openOrdered[index - 1];
            list.remove(t.id);
            if (prev) void focusTask(prev.id);
        } else if (e.key === 'Tab' && !t.done && !readonlyOrder) {
            // Tab indents under the task above; Shift+Tab outdents.
            e.preventDefault();
            if (e.shiftKey) {
                if (t.parent) list.update(t.id, { parent: '' });
            } else {
                const above = openOrdered[index - 1];
                if (above && above.id !== t.parent && !above.parent) list.update(t.id, { parent: above.id });
            }
        } else if (e.key === 'Escape') {
            input.blur();
        }
    }

    const quickDue = (t: Task, which: 'today' | 'tomorrow' | 'weekend' | 'none') => {
        const now = new Date();
        const day = (n: number) => todayIso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
        const sat = (6 - now.getDay() + 7) % 7 || 7;
        list.update(t.id, {
            due: which === 'none' ? '' : which === 'today' ? day(0) : which === 'tomorrow' ? day(1) : day(sat),
            allDay: true,
        });
    };
</script>

<ul class="tasks" class:is-dragging={reorder.active()}>
    {#each [...openOrdered, ...(showDone ? done : [])] as t, index (t.id)}
        <li
            animate:flip={{ duration: 180 }}
            data-task={t.id}
            data-reorder-row=""
            class:done={t.done}
            class:sub={!!t.parent}
            class:open-detail={detail === t.id}
        >
            <div class="row">
                {#if !t.done && !readonlyOrder}
                    <span class="handle" use:reorder.handle={t.id} aria-hidden="true">⋮⋮</span>
                {:else}
                    <span class="handle blank" aria-hidden="true"></span>
                {/if}
                <label class="check">
                    <input
                        type="checkbox"
                        checked={t.done}
                        onchange={(e) => list.setDone(t.id, e.currentTarget.checked)}
                        aria-label={t.done ? 'Mark not done' : 'Mark done'}
                    />
                    <span class="circle p{t.priority}"></span>
                </label>
                <div class="body">
                    <input
                        class="text"
                        type="text"
                        value={t.title}
                        placeholder="New reminder"
                        autocomplete="off"
                        autocapitalize="sentences"
                        enterkeyhint="next"
                        oninput={(e) => list.update(t.id, { title: e.currentTarget.value })}
                        onkeydown={(e) => onKey(e, t, index)}
                    />
                    {#if t.due || t.notes || t.source}
                        <div class="meta small">
                            {#if t.due}<span class="due {dueState(t)}">{formatDue(t)}</span>{/if}
                            {#if t.notes}<span class="muted">{t.notes.split('\n')[0]}</span>{/if}
                            {#if t.source}<a
                                    class="src"
                                    href="/{t.source.app}/{t.source.app === 'huginn' ? 'n' : 't'}/{t.source.id}{t.source
                                        .fragment
                                        ? `#${t.source.fragment}`
                                        : ''}">from {t.source.app === 'huginn' ? 'Huginn' : 'Muninn'}</a
                                >{/if}
                        </div>
                    {/if}
                </div>
                <button
                    class="flag"
                    class:on={t.flagged}
                    type="button"
                    aria-label={t.flagged ? 'Unflag' : 'Flag'}
                    onclick={() => list.update(t.id, { flagged: !t.flagged })}>⚑</button
                >
                <button
                    class="info"
                    type="button"
                    aria-label="Details"
                    onclick={() => (detail = detail === t.id ? null : t.id)}>ⓘ</button
                >
            </div>
            {#if detail === t.id}
                <div class="detail">
                    <textarea
                        placeholder="Notes"
                        rows="2"
                        value={t.notes}
                        oninput={(e) => list.update(t.id, { notes: e.currentTarget.value })}
                    ></textarea>
                    <div class="chips">
                        <button class="chip" type="button" onclick={() => quickDue(t, 'today')}>Today</button>
                        <button class="chip" type="button" onclick={() => quickDue(t, 'tomorrow')}>Tomorrow</button>
                        <button class="chip" type="button" onclick={() => quickDue(t, 'weekend')}>Weekend</button>
                        <label class="chip">
                            Date <input
                                type="date"
                                value={t.due.slice(0, 10)}
                                onchange={(e) => list.update(t.id, { due: e.currentTarget.value, allDay: true })}
                            />
                        </label>
                        {#if t.due}
                            <label class="chip">
                                Time <input
                                    type="time"
                                    value={t.allDay ? '' : t.due.slice(11, 16)}
                                    onchange={(e) => {
                                        const time = e.currentTarget.value;
                                        const day = t.due.slice(0, 10);
                                        if (!time) list.update(t.id, { due: day, allDay: true });
                                        else {
                                            const d = new Date(`${day}T${time}:00`);
                                            const off = -d.getTimezoneOffset();
                                            const sign = off >= 0 ? '+' : '-';
                                            const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
                                            const mm = String(Math.abs(off) % 60).padStart(2, '0');
                                            list.update(t.id, {
                                                due: `${day}T${time}:00${sign}${hh}:${mm}`,
                                                allDay: false,
                                            });
                                        }
                                    }}
                                />
                            </label>
                            <button class="chip" type="button" onclick={() => quickDue(t, 'none')}>No date</button>
                        {/if}
                    </div>
                    <div class="chips">
                        <span class="small muted">Priority</span>
                        {#each [0, 1, 2, 3] as p}
                            <button
                                class="chip"
                                class:on={t.priority === p}
                                type="button"
                                onclick={() => list.update(t.id, { priority: p as 0 | 1 | 2 | 3 })}
                                >{['None', 'Low', 'Medium', 'High'][p]}</button
                            >
                        {/each}
                        <span class="spacer"></span>
                        <button class="chip danger" type="button" onclick={() => list.remove(t.id)}>Delete</button>
                    </div>
                </div>
            {/if}
        </li>
    {/each}
    {#if !readonlyOrder}
        <li class="add">
            <span class="handle blank" aria-hidden="true"></span>
            <span class="plus" aria-hidden="true">+</span>
            <input
                class="text"
                type="text"
                placeholder="New reminder"
                autocomplete="off"
                autocapitalize="sentences"
                enterkeyhint="done"
                bind:value={draft}
                onkeydown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        addFromDraft();
                    }
                }}
                onblur={addFromDraft}
            />
        </li>
    {/if}
    {#if done.length}
        <li class="divider">
            <button class="divider-btn" type="button" onclick={() => (showDone = !showDone)}>
                <span class="chev" class:open={showDone}>›</span>
                {done.length} completed
            </button>
            {#if showDone}
                <button class="chip" type="button" onclick={() => list.removeDone()}>Clear</button>
            {/if}
        </li>
    {/if}
</ul>
