# Editor spike

Can Huginn get rich notes without risking the checklists? This tests Tiptap on
Yjs and a candidate format 2 in the browser, with two devices on one page. No
server and no real data.

```sh
cd spikes/editor
npm install
npm test     # builds, then drives headless Chromium (Node 22+, chromium on the PATH)
```

To try it on a device, serve the build to the tailnet and open
`http://<this machine's tailnet name or IP>:8098/`:

```sh
python3 -m http.server -d dist 8098 --bind 0.0.0.0
```

**Run checks** runs the page's own checks on that device. **Online** toggles the
link between the two editors.

## The candidate format

- `meta.format` is 2, and `meta.title` holds only an explicit title.
- `body` is a new `Y.XmlFragment` holding the rich text.
- `items` is the format 1 map, unchanged. A `checklist` block in the body only
  points at it, so items keep their IDs and fractional positions.

Migrating a format 1 note applies one update, `migrationSeed` in
`src/format2.ts`. Its Yjs client ID is a hash of the note ID, and its content is
constant, so every device produces the same operations. Applying it twice, or
after its block was edited or deleted, changes nothing.

Rejected: converting items to inline task nodes. It needs per-note conversion
that differs by device whenever they diverged offline, and XML nodes have no
move, so reordering or checked-to-bottom is a delete and a copy that loses a
concurrent edit. A check here demonstrates that loss.

## Results

All 21 checks pass, in 12 consecutive headless runs:

- Offline migration on two devices, repeat migration, a deleted block staying
  deleted, a late edit from a format 1 device, and no writes on opening the editor.
- Offline edits to prose and items, character-level merging in one paragraph,
  moving an item during a concurrent edit, and undo scoped to one device across
  prose and items.
- Formatting and tables through a reload, paste sanitising, and the title policy.
- Real keystrokes, keyboard shortcuts, typing in checklist rows, arrow keys past
  the checklist, a simulated IME composition during a remote edit, and no
  sideways overflow at 320, 390 and 640 px.

The bundle is 576 kB, 184 kB gzipped, against 70 kB gzipped for all of Huginn's
JavaScript today. It repeats libraries Huginn already ships, such as Yjs, so the
real increase is smaller and has not been measured. Load it as its own chunk.

Tiptap, its extensions and `@tiptap/y-tiptap` are all MIT.

## Not proven here

- **Hardware, partly:** on the Fold, offline edits merged, rotating and folding
  worked, and swipe typing, the Samsung keyboard and checkboxes were fine
  (reported November 1, 2026). The Surface is not yet reported.
- **Screen readers and the S Pen:** not tested, and the owner uses neither.

The rehearsal against the live server passed with no problems: 2 notes, 4 items.
It is a small sample. One note's document is empty on the server, so format 2 must
say what happens to a synced note with no title and no items.

## Limits this format accepts

- Checklist item text stays a plain string: no formatting in an item, and two
  devices editing the same item keep one version.
- Rows are ordinary inputs inside a block, so a selection can't run from prose
  through a checklist, and arrow keys step over the block rather than into its
  rows. Tab reaches them.

## Still to design

- Several checklists in one note: a new top-level map per block is the likely
  shape, with `items` staying the first.
- Deleting a checklist block should delete its items, and copying one must not
  leave two blocks sharing a map.
- New notes: created with `meta.format` 2 and their body in one transaction. Only
  a note with no format and with a title key or items is treated as format 1, so
  a note that hasn't downloaded yet is never migrated by mistake.
- The header bar's title field, its first-line placeholder, and the index's
  title and preview once the body exists.
