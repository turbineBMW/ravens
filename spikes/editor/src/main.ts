import { mount, type Device } from './device';
import { runChecks } from './checks';
import { FIXTURE_NOTE, formatOneNote, pair } from './fixture';
import { migrationSeed } from './format2';
import * as Y from 'yjs';

const docA = formatOneNote();
const docB = formatOneNote();
// Each device migrates on its own, before they have ever spoken.
Y.applyUpdate(docA, migrationSeed(FIXTURE_NOTE));
Y.applyUpdate(docB, migrationSeed(FIXTURE_NOTE));
const link = pair(docA, docB);
const a = mount(document.querySelector<HTMLElement>('#a')!, docA);
const b = mount(document.querySelector<HTMLElement>('#b')!, docB);

let focused: Device = a;
a.editor.on('focus', () => (focused = a));
b.editor.on('focus', () => (focused = b));

const toggle = document.querySelector<HTMLButtonElement>('#online')!;
toggle.onclick = () => {
    const online = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(online));
    toggle.textContent = online ? 'Online' : 'Offline';
    link.setOnline(online);
};
document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((button) => {
    button.onmousedown = (e) => e.preventDefault();
    button.onclick = () => {
        const chain = focused.editor.chain().focus();
        const cmd = button.dataset.cmd!;
        if (cmd === 'heading') chain.toggleHeading({ level: 2 }).run();
        else if (cmd === 'table') chain.insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
        else (chain as unknown as Record<string, () => { run(): void }>)[cmd]().run();
    };
});

const results = document.querySelector<HTMLUListElement>('#results')!;
async function run() {
    results.replaceChildren();
    const outcome = await runChecks(document.querySelector<HTMLElement>('#sandbox')!, (name, error) => {
        const li = document.createElement('li');
        li.className = error ? 'fail' : 'pass';
        li.textContent = error ? `${name}: ${error}` : name;
        results.append(li);
    });
    return outcome;
}
document.querySelector<HTMLButtonElement>('#run')!.onclick = () => void run();

Object.assign(window, { spike: { a, b, link, run, Y } });
