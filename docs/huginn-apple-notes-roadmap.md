# Huginn Apple Notes parity roadmap

Reviewed November 1, 2026 against repository revision `3c8c53e` plus the current working tree. The baseline below records the initial review; implementation progress is tracked separately here.

## Current status

As of November 14, 2026, at `5ded6e8`:

| Phase | State |
| --- | --- |
| P0 Data safety | Done except purge tombstones and identity-scoped caches, deferred during alpha (see below). |
| P1 Workspace | Done. Hardware acceptance on the Surface and Fold is still open. |
| P2 Rich notes | Code complete (PRs #8–#10, format 3). Hardware acceptance is still open: touch selection, soft keyboard and IME on the Surface and Fold. |
| P5 Ink | **Done except hardware and exports**, brought ahead of P3 and P4. Drawing (PR #12, format 4), the widths, highlighter and partial eraser (PR #13), the lasso, move/resize, ruler and paper (PR #14), and thumbnails in the notes list (PR #15) passed on the Surface; the Fold is untested. Ink in exports waits for P4. See [Phase 5](#phase-5--editable-ink-for-surface-and-fold). |
| P3 Organization | **In progress.** Full-text search (PR #16) passed on the Surface; folders are next. See [Phase 3](#phase-3--organization-and-finding-things). |
| P4, P6–P9 | Not started. |

The increment notes below are a history of what each step shipped; this table is the summary.

## First implementation increment

Implemented in the working tree on November 1, 2026:

- Responsive one-pane/two-pane workspace at 760 CSS px, persistent list, independent scrolling, selected rows, compact Back navigation, library dialog, and adjustable desktop list width in Settings.
- Title search, pin/unpin, keyboard navigation between note links, and Alt+Up/Down checklist reordering. Existing note URLs and item IDs are preserved.
- Soft deletion and restoration through Recently Deleted. No automatic expiry or permanent purge yet. Notes deleted by the old app before this change are not automatically reconstructed.
- Active-note connection feedback and explicit local loading/unavailable states. This reports connection state, not a server persistence acknowledgment.
- Versioned offline app-shell caching, including deep-link fallback; identity/API responses are excluded. New worker versions wait for old tabs to close rather than replacing a running editor.
- A SQLite backup utility and regression tests for recovery/concurrent edits and the built service worker.

Validation passed: `npm run check` with no errors or warnings in either app, production builds for both apps, 19 Rust tests, `node scripts/huginn-model-test.cjs`, and `node scripts/huginn-shell-test.mjs`. An isolated WAL database backup/restore test also passed, including refusal to overwrite an existing backup.

Browser and live server validation could not run in the editing sandbox: Chromium and the server both encountered denied socket operations. Before deployment, verify actual layout at 320/390/760/900/1280 CSS px, focus while resizing, touch/soft keyboard, Back/Forward, Muninn item links, trash/restore across devices, and an offline close/relaunch after the service worker has installed. The service-worker test uses a simulated worker environment; it does not prove browser installation or IndexedDB durability.

Phase 0 remains incomplete: identity-scoped browser caches and purge tombstones still need implementation. Phase 1 needs hardware acceptance; per-note scroll restoration and remembered startup selection remain follow-up polish. Phases 2–9 have not started. Reload old clients before relying on recovery: an old client still uses hard index deletion and does not understand Recently Deleted.

## Pre-Phase 2 increment

Implemented on the `huginn-pre-phase-2` branch, November 1, 2026:

- **Save confirmation.** After storing changes in SQLite, the server reports the stored state vector to clients at version 1 or later, and the note header says "Saved" only when that covers everything on the device. A failed store reports an error and is retried as a full snapshot before anything is claimed. This confirms the server's copy; a failed write to the browser's IndexedDB is still not detected.
- **Old-client guard.** Clients send `CLIENT_VERSION` when connecting, and a server closes those below its app's `min_client` with code 4426 before they can read or write. Both apps run with `min_client: 0`, so nobody is turned away yet, and clients that predate this report 0. A note's `meta.format` (absent means 1) above `NOTE_FORMAT` shows as unavailable, and that client's edits to it do nothing. **When Phase 2 changes the format, raise `NOTE_FORMAT`, `CLIENT_VERSION` and Huginn's `min_client` together.**
- **Format 1 fixtures.** `scripts/fixtures/huginn-format-1.json` freezes format 1 documents in the shape shipped clients wrote. They are synthetic, because this repository must not hold personal notes. Rehearse the real migration on a copy of a server backup too. Never regenerate the fixtures.
- **Index repair.** Once a note has synced, it corrects its index entry without changing the edit date. This happens when a note is opened; entries for notes never opened stay as they are, and an entry with no content on the device is left alone.
- **Late subscribers.** Yjs stores and the synced flag now re-read on first subscription. Before this, a note could open blank on a fresh device if server data arrived before local storage finished loading.
- **Narrow list position.** The list returns to its scroll position after visiting a note.

`scripts/huginn-browser-test.mjs` covers save states through a server outage, a second device, focus through resizing, 320/390/640 CSS px without overflow, list position, Back/Forward/deep links, and an outdated client. It runs locally rather than in CI. Touch, soft keyboard, pen, and fold behavior still need the actual Surface and Fold.

Deliberately deferred: purge tombstones, which matter once notes can be permanently deleted, so they ship with trash expiry; and identity-scoped local caches, which matter when accounts change or sharing arrives.

To back up a server database, run `python3 scripts/backup-db.py SOURCE.db NEW-BACKUP.db` where the database is accessible. The utility includes committed WAL data and verifies SQLite integrity. To rehearse recovery, point a separate server instance at a copy of the backup using `RAVEN_DB_PATH`, a different `RAVEN_LISTEN_ADDR`, and the matching `RAVEN_DEV_USER`; do not replace a running production database. A database backup does not include browser edits that have not reached the server.

**Alpha (from November 2, 2026):** there is no real data yet, so new work skips migrations, backups and version gates; see [Releases](../deploy/phase-releases.md). The safety work recorded above stays in place for when real data arrives.

Huginn should become a general notes app with fast capture, mixed content, reliable offline editing, and a layout that follows the available space. Keep the existing shopping-list experience as a useful part of that app. The first major milestone is a dependable everyday Notes replacement; advanced handwriting, collaboration, and intelligence extend it afterward.

The target devices remain the Surface Pro 11 on Omarchy and the Galaxy Z Fold, with the Mac mini hosting the service. Apple Notes is the functional reference, while Huginn keeps its own theme, self-hosting, and Muninn integration.

## Scope of parity

The inventory covers the main Notes workflows documented for iPhone, iPad, and Mac: capture, editing, organization, search, media, ink, sharing, security, portability, and integrations. Apple documentation currently includes version 27 pages as well as version 26 pages; newer items such as divider lines and section links are included explicitly. Features vary by device, account, language, and OS. This is a documentation and source-code review, not a hands-on audit of every Apple device or the deployed Huginn instance.

Apple's Mac layout can show folders, a notes list, and an editor. Huginn's requested default is **two columns: notes list and editor**, with folders in a drawer. A third persistent folder column is optional later, not necessary for the initial experience. [Apple's Mac navigation](https://support.apple.com/en-gb/guide/notes/apd8b73d28be/mac)

Three completion levels keep the target concrete:

- **Everyday parity:** responsive navigation, rich notes, organization, search, attachments, editable ink, recovery, and useful import/export. Phases 0–5.
- **Extended parity:** scans, PDF markup, audio, note locks, and collaboration. Phases 6–8.
- **Advanced parity or platform equivalents:** handwriting intelligence, Math Notes, writing assistance, and native capture integrations. Phase 9. These require separate feasibility decisions.

## Baseline before implementation

| Area | Evidence in the repository | Implication |
| --- | --- | --- |
| Notes UI | `huginn/web/src/routes/+page.svelte` creates only checklists; `NoteEditor.svelte` always renders `Checklist` | The `text` kind exists in the type but has no text editor or body. |
| Layout | Home is an auto-fitting card grid; `/n/[id]` replaces it with the editor; the editor is capped at 640px | Responsive cards exist, but simultaneous list/editor navigation does not. |
| Checklists | Stable item IDs, fractional positions, checked state, checked-to-bottom, reordering, uncheck all, delete checked | Preserve these working behaviors through migration. |
| Pinning | `notes.ts` stores and sorts `pinned`; no pin control in the reviewed UI | Data support is partial implementation, not a shipped feature. |
| Local data and sync | Yjs, IndexedDB, WebSocket transport, Rust yrs persistence | A strong starting point, but convergence alone does not establish good editing semantics. |
| Concurrent text | Item text and title are scalar values in Y.Map | Two devices changing the same field resolve at field level; character-level rich text needs a text-aware shared structure. |
| Metadata | Title and preview are copied into a separate index document | Note and index updates are not atomic together; previews need reconciliation. |
| Deletion | `Index.remove` deletes the index entry; note data remains separately stored | No Recently Deleted, restore, retention, or complete purge workflow. |
| Offline launch | Huginn has a web manifest but no `src/service-worker.ts` | Locally stored documents do not guarantee that a closed app can launch without the server. |
| Sync feedback | Root layout displays the index document's connection and sync state | A connected index does not prove that the active note is persisted locally or saved remotely. |
| Identity | Server scopes document names by owner; browser storage key uses app path and document name | Preserve server isolation and address local identity changes before broader sharing. |
| Backend | Huginn-specific router is empty and `on_change` is absent | The SQL `notes` table is not an implemented search/catalog service; synced documents are the active data path. |
| Pen | Standalone pen spike; README records Surface pass and Fold untested | Ink is not integrated. Fold pen capability still needs a real device check. |
| Muninn | Note/item reminder links and related reminders are implemented | Keep existing URLs and item IDs valid; later support selected rich text. |
| Existing validation | Rust tests and `scripts/sync-e2e.mjs` | The script exercises relay and reconnect, not browser offline launch, migration, or simultaneous rich editing. |

Primary implementation references: [note model](../huginn/web/src/lib/notes.ts), [editor](../huginn/web/src/lib/NoteEditor.svelte), [app layout](../huginn/web/src/routes/+layout.svelte), [sync client](../shared/ui/src/sync.ts), [sync server](../shared/raven-server/src/sync.rs), and [pen spike](../spikes/pen/README.md).

## Apple Notes feature inventory and Huginn mapping

“Missing” means no implementation was found in the reviewed Huginn code. Phase numbers refer to the plan below. Apple behavior appears in the first column; the proposed Huginn treatment appears in the last.

| Apple Notes capability | Huginn today | Planned delivery |
| --- | --- | --- |
| Phone navigation; wider list/editor workspace | Separate card and editor routes | P1: one pane when narrow, two when wide |
| List and gallery views; date grouping | Card grid and updated-date ordering | P1 list; P3 gallery, grouping, view preferences |
| Folders and nested folders; move notes | Missing | P3: folder tree, move, rename, batch actions |
| Pinning; title/created/edited sorting | Pin field only; edited sort | P1 pin control; P3 complete sort options |
| Rich text, headings, emphasis, highlights, lists, tables | Checklist only | P2: mixed rich document |
| Collapsible headings; divider lines | Missing | P2: stable section IDs and local collapse state |
| Checklists alongside prose | Standalone checklist | P2: inline checklists; preserve shopping mode |
| Web links, note links, automatic titles, section links | Muninn links only | P2 basic web links; P3 note/section linking |
| Actionable addresses, phone numbers, dates | Missing | P3 basic detection; P9 broader platform actions |
| Tags and tag browser | Missing | P3: tags, rename/delete, include/exclude filtering |
| Smart Folders with any/all conditions | Missing | P3: saved predicates; expand with later metadata |
| Search notes; find within a note | Missing | P1 title search; P3 full text and in-note find |
| Search handwriting, scans, image contents, transcripts | Missing | P6 OCR; P7 transcripts; P9 handwriting and image recognition |
| Attachment browser | Missing | P4: attachment types and jump to source note |
| Photos, videos, files, previews, drag/drop | Missing | P4: attachment storage and content blocks |
| Camera capture and document scanning | Missing | P4 photo capture; P6 multipage scans |
| PDF viewing and page navigation | Missing | P4 basic viewer; P6 advanced PDF workflow |
| PDF/scanned-page markup and edits | Missing | P6: editable annotations and page operations |
| Drawings, handwriting, ruler, colors, erasing, lasso | Spike only | P5: editable stroke model and tools |
| Lines/grids and ink area sizing | Missing | P5: paper preferences and resizable ink regions |
| Handwriting selection, recognition, Scribble | Missing | P9: recognition and handwriting-to-text exploration |
| Smart Script refinement, spelling, reflow, paste as handwriting | Missing | P9 research track; do not promise Apple-level fidelity |
| Audio recording, playback, transcription | Missing | P7: resilient audio and transcript pipeline |
| Transcript search, jump-to-audio, copy/add to note | Missing | P7: timestamped searchable segments |
| Math calculations, variables, handwritten math, graphs | Missing | P9: typed math first; handwriting later |
| Send a copy; export or print | Missing | P2 text export; P4 PDF/Markdown; P8 richer sharing |
| Import text, Markdown, HTML, rich text, Evernote files | Missing | P4 Markdown/text first; P6 selected legacy formats |
| Recently Deleted and recovery | Index removal only | P0: trash/restore; later explicit purge policy |
| Cross-device notes with account boundaries | Same-user CRDT sync | P0 hardening; P8 explicit shared access |
| Shared notes and folders; view/edit permissions | Missing | P8: server-authorized sharing and revocation |
| Collaboration activity, highlights, mentions | Missing | P8: attributed events and notifications |
| Locked notes with password/device authentication | Tailscale access only | P8: actual encrypted content and key handling |
| Quick Note, share-sheet capture, context links | Missing | P4 capture inbox; P9 deeper OS integrations |
| Lock-screen capture, widgets, Siri, Shortcuts, Handoff | Missing | P9 platform equivalents or explicit exclusions |
| Local-device accounts and other account providers | Tailscale user namespace | P9 evaluate a device-only notebook; provider sync deferred |
| Writing Tools, summaries, Image Wand | Missing | P9 opt-in provider-backed equivalents |
| Keyboard shortcuts and view/settings preferences | Limited standard controls and theme | P1 navigation/accessibility; preferences grow with each feature |

Apple sources for the inventory:

- Formatting, tables, collapsing sections, and divider lines: [create and format notes](https://support.apple.com/en-md/guide/ipad/ipad99e3f0bb/ipados).
- Folder operations, pinning, sorting, and grouping: [organize folders](https://support.apple.com/en-sg/guide/ipad/ipadc44c8c4a/ipados). Tags and saved filters: [tags](https://support.apple.com/en-ie/guide/iphone/iphedddbfdf9/26/ios/26), [Smart Folders](https://support.apple.com/en-euro/guide/ipad/ipad0a267d6e/27/ipados/27).
- Search, image contents, scanned text, and attachments: [use Notes](https://support.apple.com/en-ie/118442). Note and section links: [add links](https://support.apple.com/en-hk/guide/ipad/ipad03a11b57/ipados).
- Capture and embedded media: [get started](https://support.apple.com/guide/ipad/get-started-with-notes-ipadfeea407c/27/ipados/27), [scan text and documents](https://support.apple.com/en-gb/guide/iphone/iph653f28965/27/ios/27), [PDF workflows](https://support.apple.com/en-by/guide/ipad/ipad6c8f7f84/ipados).
- Ink, handwriting, Smart Script, and Image Wand: [drawings and handwriting](https://support.apple.com/en-by/guide/ipad/-ipada87a6078/ipados). Calculations and graphs: [formulas and equations](https://support.apple.com/guide/ipad/enter-formulas-and-equations-ipad10f28bec/ipados).
- Recording and transcript operations: [audio](https://support.apple.com/guide/ipad/record-and-transcribe-audio-ipadd0bde806/27/ipados/27). Writing assistance: [formatting and Writing Tools](https://support.apple.com/en-euro/guide/ipad/ipad99e3f0bb/ipados).
- Import formats: [import notes](https://support.apple.com/en-us/102223). PDF and Markdown export: [Mac import/export](https://support.apple.com/guide/notes/import-export-and-print-notes-not201900c07/4.13/mac/26).
- Recovery: [delete and recover](https://support.apple.com/guide/ipad/delete-and-recover-notes-ipad143d0bd0/ipados). Access: [locking](https://support.apple.com/guide/ipad/lock-notes-ipadcee11420/ipados), [collaboration](https://support.apple.com/en-ie/guide/ipad/ipad8c7b03b9/27/ipados/27).
- Capture integration and preferences: [Quick Notes](https://support.apple.com/guide/ipad/use-quick-notes-ipad5d91fd88/ipados), [Notes settings](https://support.apple.com/en-euro/guide/ipad/ipaddf4ef746/ipados).

## Responsive layout contract

Choose the layout from the **app's available CSS width**, never the device name. A narrow desktop window should behave like a phone, and an unfolded Fold should use two panes only when both remain usable.

| Space | Proposed behavior |
| --- | --- |
| Under 760 CSS px | One screen at a time: folders → notes → editor. Visible Back control, browser Back support, full-width editor. |
| 760 CSS px and above | Notes list on the left, selected note on the right. Start with a 280px list and at least 440px of editor space. |
| Larger windows | Resizable list, normally 280–360px; editor consumes remaining width, with readable prose measure. Media and ink can use more width. |
| Optional later mode | Pin the folder drawer as a third pane only when requested and enough space remains; default stays two columns. |

The 760px threshold is a starting design value, not an Apple specification. Validate it on actual Fold display scaling and Surface window sizes. Collapse earlier if text enlargement or pane sizing leaves insufficient editor space.

```text
Narrow: one of these screens             Wide: persistent two-pane workspace
┌───────────────────────┐               ┌──────────────────┬─────────────────────────┐
│ ‹ Notes       Actions │               │ Folders  Search  │ Note actions            │
│ Note title            │               │ New note         │ Note title              │
│ Text / list / media   │               │ Selected note    │ Text / list / media     │
│                       │               │ Another note     │                         │
│ Editing tools         │               │ More notes       │ Editing tools           │
└───────────────────────┘               └──────────────────┴─────────────────────────┘
```

Required behavior:

- Keep `/huginn/n/<id>` stable. Selection follows the URL, including deep links, Back, Forward, and Muninn links. Folder/filter state can live in query parameters.
- Keep a single editor instance for the selected note across resizing. Preserve composition, selection, undo, scroll, and unsent edits when folding or rotating.
- Scroll list and editor independently. Return to the previous list position when backing out on a phone.
- Folder drawer closes after choosing a folder on compact screens. Wide screens retain the selected note when it remains in scope; otherwise show a deliberate selection/empty state.
- Treat a soft keyboard as reduced vertical space. Keep the caret and editing toolbar visible using dynamic viewport sizing and safe-area insets; do not switch modes just because keyboard height changes.
- Provide touch controls of at least 44 CSS px, visible keyboard focus, accessible pane labels, and non-drag alternatives for move/reorder operations.
- Do not autofocus an existing note and open the phone keyboard just because it was selected. Creating a note may focus the editor intentionally.
- Use context-sensitive toolbars for text, checklist, attachment, and ink. Keep infrequent actions in a menu.
- Handle empty folders, loading local data, missing notes, deleted notes, offline notes not downloaded, and permission failures as distinct states.

## Architecture decisions that prevent rework

1. **One note supports mixed content.** Introduce a versioned document schema with rich text plus stable IDs for checklists, tables, attachments, and ink regions. Evaluate a mature ProseMirror/Tiptap-family Yjs editor in a short spike; adoption depends on touch, IME, accessibility, licensing, and custom-node behavior. Do not make serialized HTML or Markdown the authoritative synced document.
2. **Preserve checklist semantics and IDs.** A shopping-list presentation can be a note preference or checklist block mode. Checked-item movement must stay inside that checklist, not reorder unrelated prose. Avoid duplicating checklist truth between legacy maps and editor nodes.
3. **Design migration for two offline devices.** Use a schema version, deterministic migration, backups, and old-client compatibility rules. Two clients migrating the same note must not duplicate its content. Old clients must not silently overwrite the new format. Rollback means restoring a known snapshot, not hoping a downgrade understands new nodes.
4. **Separate canonical content from projections.** Titles, previews, tags, attachment counts, and search text are rebuildable projections. Title policy: a note's title is its first line unless the user has set a title. `meta.title` holds only that explicit title, and clearing it returns the note to its first line. Existing non-empty titles stay explicit and are not moved into the body. The index mirrors the resulting title, with deterministic repair when a note and its index disagree. Avoid treating the current unused SQL catalog as already authoritative.
5. **Keep binary assets out of CRDT updates.** Use authenticated blob storage with IDs, hashes, metadata, upload state, and local cache. Refer to blobs from notes; support retries and prevent collection while a trash/recovery reference still exists.
6. **Treat durability as several states.** Locally loaded, locally persisted, connected, pending remote changes, and server-confirmed persistence are different. Do not label a note “saved” merely because WebSocket connected. Define persistence acknowledgments before making that promise.
7. **Security choices affect storage.** Before attachments ship, decide how encrypted notes will wrap blob keys and exclude plaintext previews/search. Before sharing, introduce server-owned permissions; permission changes cannot be trusted solely because they arrived inside an editable CRDT.
8. **Keep personal view state local.** Pane width, caret, scroll, and collapsed sections should not make another device jump. Sync actual document edits and intentional shared preferences.

## Phased delivery

Size is relative engineering complexity: S small, M medium, L large, XL a substantial subsystem. These are not calendar promises. Each phase should ship in reviewable increments.

### Phase 0 — Data safety and an honest offline foundation

**Size M. Dependency: none.** Establish the safety contract before changing note format; P1 layout work can proceed alongside it.

- Add trash/restore with deletion timestamps and explicit purge semantics. Apple offers a 30-day recovery window; use that as the proposed default once expiry is enforced safely. Keep a small tombstone after purge so stale clients cannot resurrect a deleted note.
- Establish a backup/restore procedure for document storage and test a restore into an isolated instance. Add version metadata and migration fixtures for existing lists.
- Cache Huginn's app shell for offline launch. Define which notes are downloaded, distinguish unavailable offline content, and handle storage quota failures.
- Scope local storage to verified identity, with an explicit account-change/cache transition. Preserve intentional offline access for the last verified identity without mixing users.
- Track active-note local persistence and remote sync separately from index connectivity. Repair stale previews and title projections.
- Add conflict scenarios for same-item edits, concurrent reorders, equal position ties, delete-versus-edit, and server persistence failure. Document scalar-field limitations until P2.

**Exit:** create and edit an existing-format note, close the app, relaunch offline, reconnect two devices, delete/restore, and restore a server backup without losing content. A reconnecting stale client cannot undo a permanent deletion.

### Phase 1 — The responsive Notes workspace

**Size M. Dependency: existing checklist model; P0 gates release confidence.** Make the app feel right immediately without waiting for the rich editor.

- Extract a reusable notes list and workspace shell from the home/detail routes. Implement the layout contract above with the current checklist editor.
- Add selected-row styling, title/preview/date rows, pin/unpin, title search, and a new-note action. Until P2, creation still produces an honestly labeled checklist.
- Implement compact Back navigation, remembered selection/scroll, accessible drawer and menus, keyboard navigation, and useful empty/error states.
- Scope shell sizing changes to Huginn; shared `main` styles currently also affect Muninn.

**Exit:** the same open checklist survives 390 → 900 → 1280 → 390 CSS px resizing with text and focus intact. Deep links, Back/Forward, keyboard operation, and touch scrolling work. Verify 320px width and 200% zoom too; no horizontal page overflow.

### Phase 2 — Real notes and mixed content

**Spike result:** [spikes/editor](../spikes/editor/README.md) chose Tiptap on Yjs and a format 2 that keeps the format 1 `items` map and adds a rich `body` referencing it. It passed on the Fold and the Surface, and the migration rehearsal against the live server's 2 notes found no problems. Accepted limits: checklist items stay plain text, one version wins when two devices edit the same item, and a selection can't run through a checklist.

**First increment, on the `huginn-phase-2` branch:** format 2 with its migration, `NOTE_FORMAT` and `CLIENT_VERSION` 2, and Huginn's `min_client` 2. New notes start as text. The editor has text styles, bold, italic, underline, strikethrough, highlight, monospaced text, links, bulleted and numbered lists with indenting, tables with row and column operations, divider lines, one checklist block per note, undo, and plain text export. The title is the first line unless one is set.

**Several checklists, on the `huginn-several-checklists` branch:** each new checklist block names its own `items:<id>` map, and format 1 notes keep `items`. A note becomes format 3 when it first gets one, `NOTE_FORMAT` and `CLIENT_VERSION` are 3, and Huginn's `min_client` is 3. Removing a block leaves its items stored but out of the note's text and counts; undo brings them back during the session.

**Sections, reminders and paste (PR #10):** headings get a stable section ID that syncs. Collapsing a section hides everything up to the next heading at its level or above; that is view state, so it stays on the device and is remembered per note. *Remind me* turns the selected text into a Muninn reminder that links back to its section, and opening the link expands the section. *Paste text* pastes the clipboard as plain text.

Phase 2's code is complete. Still open: the exit checks on hardware, meaning touch selection, the soft keyboard and IME composition on the Surface and Fold, and two offline devices reconnecting. Moving to format 2 cannot be undone by downgrading: rollback means restoring a backup.

**Size L. Dependency: P0 schema/migration contract, P1 shell.** This is the largest early product improvement.

- First deliver the editor spike and migration design. Then ship paragraphs, title/heading/subheading styles, bold/italic/underline/strikethrough, highlights, monospaced text, web links, bullets/numbering, and indentation.
- Add inline checklists, tables with row/column operations, collapsible sections, and divider lines. Give sections stable IDs for future links.
- Preserve shopping mode, checked-to-bottom preference, item IDs, reorder, and existing Muninn reminders. Add selected-text-to-reminder with a stable note link.
- Implement local undo/redo scoped to the user's edits, clipboard sanitization, rich/plain paste, keyboard formatting, IME composition, and touch selection.
- Add plain text export early so newly entered prose has an escape route.

**Exit:** a meeting note can contain headings, prose, a table, links, and a checklist. Two offline clients can edit different parts and reconnect without losing either edit. Existing grocery lists migrate once with item IDs and reminder links intact. Undo does not erase another client's edits.

### Phase 3 — Organization and finding things

**Size L. Dependency: P2 structured content.** A notes replacement must remain usable after hundreds of notes.

- Folders/subfolders, rename/move/delete, batch move/delete, pinned section, gallery/list choice, date grouping, and title/created/edited sort options.
- Tags with rename/delete and include/exclude filters. Smart Folders store any/all predicates; initially support tags, dates, folders, and checklist state. Add attachment, sharing, and mention predicates as those capabilities land.
- Full-text search across downloaded content, highlighted snippets, folder scope, and find-in-note. Add a server search projection for content not cached locally; show the offline scope clearly.
- Note and section links with title-following or custom labels, missing-target states, and a picker. Backlinks are a useful Huginn extension, not required for the Apple baseline.
- Basic email/URL/phone detection; route reminder actions to Muninn without duplicating its task system.

**Exit:** find a phrase deep in a long note, navigate directly to its section, move the note, and retain working links. Renaming tags updates saved filters predictably. Folder deletion has a clear recovery path. Exercise a representative 1,000-note library and measure search/list latency before setting release budgets.

**Started November 14, 2026, with search, ahead of folders:** search only matched titles, and notes reach a device only when opened there, so a search of local content alone would miss most notes on a new device. Search therefore starts with the server projection, and the client falls back to titles offline.

**First increment, PR #16:** the server mirrors each note's text into SQLite (`note_lines`, FTS5 over it, `unicode61` with diacritics removed) on every change, one row per line with the section it's under: the set title, then the body as `textLines` reads it, with every checklist item, checked or not, and tables cell by cell. Notes stored before this are indexed in the background at startup; `note_search_state` records which notes are indexed and by which version of the extraction, and a new version indexes everything again. `GET /v1/search?q=` finds the user's notes holding every word somewhere, the last word as a prefix, and returns each note's best line, preferring a line with every word, cut to the words around the match with the matches marked. The notes list's search box (*Search*) shows title matches at once, then notes whose text matches, most relevant first, with the matched line highlighted in place of the preview; a hit opens the note at its section, expanded, including in the note already open. Offline, or if the server can't search, it says it is matching titles only. No format change and nothing new in the documents.

Measured with `cargo test -p huginn-server --release -- --ignored --nocapture` (1,000 notes of 40 lines, on the development machine): indexing all of them takes 2.2 s, re-indexing a changed note under 1 ms, and a search 14–27 ms, or up to 130 ms for a word in nearly every line of every note. Not yet measured on the mini.

**Surface Pro 11, November 14, 2026, deployed to the mini:** passed. Startup indexed the mini's 3 existing notes.

Still to do in this phase: folders, tags and Smart Folders, find-in-note, list options (gallery, date grouping, sort), note links, and detecting emails, URLs and phone numbers.

### Phase 4 — Attachments, capture, and portability

**Size L. Dependency: P2 nodes, P0 persistence; P3 for attachment browsing.** Turn notes into a place for reference material.

- Authenticated uploads/downloads, resumable or safely retryable transfers, local attachment queue, quota controls, thumbnails, and retention-aware garbage collection.
- Images, camera photos, videos, general files, URL previews, drag/drop and paste. Include alt text and attachment status. Fetch preview URLs with network restrictions appropriate to a self-hosted server.
- PDF attachment viewing with pages, zoom, and open/download actions. More advanced markup follows in P6.
- Attachment browser with type filters and navigation back to the containing note.
- Markdown/text import, Markdown/HTML/PDF output and printing, plus a complete Huginn archive containing original assets and metadata. Show unsupported formatting in an import/export report; Markdown alone cannot preserve editable ink or every rich structure.
- Quick capture route/inbox and share-target support where the browser permits it, with paste/file-picker fallback. Capture source URLs along with content.

**Exit:** paste an image offline, restart, reconnect, and open it on the other device. Cancel/retry a large upload without creating duplicate attachments. Export a representative library and reimport into a fresh profile with assets accounted for. Verify print output with long notes and page breaks.

### Phase 5 — Editable ink for Surface and Fold

**Size L. Dependency: P2 ink nodes; P4 for image-backed ink and exports.** Prioritize this before advanced collaboration because pen use is central to the project.

**Next, chosen November 10, 2026, ahead of P3 and P4.** P2 did not add an ink node, so this phase starts by adding one. Image-backed ink and ink in exports wait for P4. Suggested first increments:

1. An ink region block in the note body that names its own stroke map, as checklist blocks name `items:<id>`: stroke IDs, points with pressure, tool, width and colour. It raises `NOTE_FORMAT`, `CLIENT_VERSION` and Huginn's `min_client`.
2. Pen drawing in that block with finger scrolling kept separate, drawn from the `spikes/pen` findings, plus a canvas renderer that is separate from storage. This includes a mouse and finger drawing mode for when no pen is available.
3. Eraser, undo/redo and width/colour, then lasso, move/resize, ruler and paper styles.

The Fold has not yet been tested with a pen. Run `spikes/pen` on it before relying on the S Pen path.

**First increment, PR #12:** the *Drawing* tool adds an `ink` block naming its own `strokes:<id>` map (format 4; `NOTE_FORMAT`, `CLIENT_VERSION` and Huginn's `min_client` are 4). The pen and the mouse draw, and pressure sets the width. Fingers scroll the note unless *Draw with finger* is on, a choice kept on each device. The pen's eraser end, or the *Eraser* tool, removes whole strokes. There are four colours that follow the theme, and undo covers strokes along with the rest of the note. A drawing is 1000 units wide and scales to the column, and it grows as you draw near its bottom edge. A stroke is stored when the pen lifts, so other devices see finished strokes, not strokes in progress. Plain text export shows `[Drawing]` in its place.

**Surface Pro 11, November 11, 2026, deployed to the mini:** passed. The pen draws without scrolling the note, the palm is fully rejected, the eraser end erases, a finger scrolls over a drawing, a second device shows the drawing, and no lag is noticeable.

**Second increment, PR #13:** pen and highlighter each have fine, medium and bold widths and their own colour, and yellow joins the palette. The highlighter draws one see-through path of even width. *Eraser* cuts away only what it touches, replacing a stroke with the pieces left, which keep its depth. *Stroke eraser* removes whole strokes, and the pen's eraser end does whichever was chosen last. An eraser gesture is stored as one change when it lifts. Tool choices are remembered on each device. The note format is unchanged: a format 4 client from before this draws a highlighter as an opaque pen stroke. Accepted limit: if two offline devices erase parts of the same stroke, the pieces from both survive, so part of one device's erasing comes back.

**Surface Pro 11, November 14, 2026:** the second increment passed.

**Third increment, PR #14:** *Lasso* selects the strokes at least half inside the loop it draws. Dragging the selection moves it, and its corner handle resizes it in proportion, widths included; it stays within the drawing's width and can't go above its top, and moving it down grows the drawing. *Delete selection* removes it. A move or resize is stored when the pointer lifts, sets each stroke's points and width in place so it keeps its id and depth, and is one undo step. *Ruler* shows a ruler on this device only. A finger or the mouse drags it, and two fingers or its end knobs turn it; it settles on multiples of 15° within 2° and shows its angle. A stroke from the pen or mouse that starts on the ruler, or within 40 units of an edge, draws straight along that edge, and the pen draws, erases and lassos straight through the ruler as if it weren't there. *Paper* (plain, lines, grid, dots) is kept for each drawing in the top-level `paper` map and scales with the drawing. The note format is unchanged: a format 4 client from before this shows moved strokes where they now are, and plain paper. Accepted limit: if one device moves a stroke while another erases it offline, the erase wins.

**Surface Pro 11, November 14, 2026, deployed to the mini:** the third increment passed.

**Fourth increment, PR #15:** a note with a drawing shows its first drawing as a thumbnail at the right of its row in the notes list. The index entry keeps a `sketch` of it, so the list draws it without opening the note: cropped to the ink, its longer side 255 units with one byte per coordinate, each stroke simplified (Douglas-Peucker) and stored with its tool, colour and width. A busy drawing is simplified harder until it fits in 3000 bytes, then keeps its oldest strokes that fit. The device that edits the drawing writes the sketch, only when it changed; opening a note repairs a missing or stale one, so drawings made before this get theirs when next opened. The thumbnail is SVG in the theme's colours, with no line thinner than 1.25 px. The note format is unchanged; older clients ignore `sketch`.

**Surface Pro 11, November 14, 2026, deployed to the mini:** the fourth increment passed.

Still to do in this phase: the same checks on the Fold with an S Pen (it has not been tested with a pen at all), and ink in exports.

- Integrate the existing pen spike findings. Confirm actual Fold model and pen support using the spike; retain finger/mouse drawing when pen hardware is unavailable.
- Stable stroke IDs and pressure-aware samples, rendering separate from storage, pen/highlighter/eraser, width/color, undo/redo, lasso selection, move/resize, ruler/straight lines, and paper lines/grids.
- Separate pen drawing from finger scrolling, with explicit finger-drawing mode. Test palm behavior and coalesced pointer events on actual devices.
- Store ink regions in mixed notes; render readable thumbnails and export previews without throwing away editable strokes.

**Exit:** draw on Surface, continue editing the same strokes on the second supported device, erase a selected stroke, undo, and reconnect concurrent drawings. Folding/resizing must not distort coordinates. Measure input latency and long-session memory on hardware.

**Milestone:** phases 0–5 deliver the proposed everyday replacement. This is a usable release even if the later specialist capabilities take longer.

### Phase 6 — Scans, OCR, and advanced PDFs

**Size L. Dependency: P4 assets, P5 annotation tools.** Capture paper and make it findable.

- Multipage camera capture, manual corner adjustment, rotation, crop, filters, page order, and PDF assembly. Add automatic edge detection after manual capture works reliably.
- Text extraction/OCR jobs with language selection, progress/retry, searchable results, and references to source pages. OCR results supplement originals rather than replace them.
- PDF thumbnails, search, editable ink/text annotations, signatures, supported page operations, and annotated export. Distinguish edits that apply only to scanned pages.
- Add HTML/RTF/RTFD/ENEX import in separately scoped increments based on real migration samples, preserving original files and reporting losses.

**Exit:** scan a multipage receipt/document, find it by extracted text, annotate a page on another device, and export a readable PDF. Test rotated pages, OCR failure, large files, and partial imports.

### Phase 7 — Audio and transcripts

**Size L. Dependency: P4 assets; P3 search.** Build recording integrity before speech intelligence.

- Microphone capture, pause/resume, playback, rename, download, and durable chunk storage. Recover interrupted sessions where possible; explicitly test browser background/suspend behavior.
- Timestamped transcription jobs, language/capability indicators, transcript correction, search, tap-to-seek, and copy/add-to-note.
- Optional summaries remain separate generated content, linked to the recording. A user can retain audio without enabling transcription or AI.

**Exit:** interrupt a recording with a network failure, recover its saved audio, reconnect for transcription, and navigate from a search result to the correct time. Do not promise native call recording from the web app; importing a recording is the initial equivalent.

### Phase 8 — Private notes and collaboration

**Size XL. Dependency: P0 identity and durability, P2 schema, P4 asset permissions.** These are two substantial deliverables, not one toolbar feature. Their architecture must be decided earlier even though the UI ships here.

- **8A Private notes:** define the threat model, encrypted note/asset storage, key derivation and wrapping, unlock lifetime, lost-key behavior, and backup/restore. Keep locked content out of plaintext index previews, OCR, notifications, exports, and server search. Existing Yjs/yrs server inspection will need an alternate path for encrypted documents. Device authentication is a convenience only if the target browser provides suitable key handling.
- **8B Sharing:** introduce server-managed note/folder permissions, invitations, read-only/edit access, revocation, and authenticated attachment access. Current `(owner, document)` isolation is not a shared-document namespace; sharing requires an explicit ownership/access model.
- Add presence, attribution/activity, change highlights, mentions, notification preferences, and folder activity. Folder inheritance and moving a note between private/shared folders require explicit rules.
- Define offline revocation behavior honestly: prevent future access and writes, but previously downloaded plaintext cannot be recalled. Default to disallowing locked-note collaboration until a shared-key protocol exists.

**Exit:** an uninvited user cannot read documents or assets by guessed ID. Read-only users cannot write through WebSocket messages. Revocation affects active connections and future sync. Locked content remains unreadable in server storage and search. Two authorized users can edit a shared note and inspect attributable activity.

### Phase 9 — Advanced Notes capabilities and platform integration

**Size XL, several independent tracks. Dependency: the relevant earlier content types.** Prioritize these by actual use after everyday parity is established.

| Track | First useful increment | Later / feasibility boundary |
| --- | --- | --- |
| Handwriting | Search and copy recognized handwriting | Word selection, refinement, spelling, reflow, and generated handwriting need models and real handwriting evaluation. |
| Math | Safe typed arithmetic and variables with explicit errors | Graphs, handwritten equations, and layout interpretation are separate projects; never execute note text as code. |
| Writing assistance | Opt-in proofreading, rewrite, summaries with preview/accept/undo | Provider choice, privacy, model costs, and offline behavior are explicit settings. |
| Image intelligence | Optional semantic image indexing | Image Wand-style generation is a separate optional integration. |
| Quick capture | Launcher action, keyboard shortcut, capture window, browser extension | OS-wide overlays, lock-screen entry, widgets, and share receivers may require native companions. |
| Context continuity | Save source URL and selection | Automatic resurfacing on revisiting a page requires browser integration. |
| Account scope | Evaluate a true device-only notebook | Gmail/Exchange/iCloud interoperability is not implied by self-hosted sync; assess supported APIs separately. |
| System integration | Muninn actions and explicit automation endpoints | Siri, Handoff, Apple Pencil-specific gestures, FaceTime recording, and direct Pages handoff are Apple integrations, not portable web features. |

**Exit:** each track has its own device/language matrix and acceptance corpus. No advanced feature is called parity merely because a button invokes a model.

## Recommended implementation sequence and review gates

Start with **P0 safety plus P1 responsive shell**, then **P2 rich notes**. Ship P3 and P4 before broad migration from Apple Notes. Bring P5 ink forward as soon as the mixed-content schema is stable. That point came with format 3, so the order is now P5, then P3 and P4. P6 and P7 can be scheduled independently after their dependencies; P8 requires earlier design work but does not need to block a personal everyday release.

The first reviewable implementation slices should be:

1. Workspace shell and reusable notes list, preserving current checklist behavior and routes.
2. Trash/restore and active-note persistence feedback, with backup and offline-launch checks.
3. Rich-editor spike with a real existing-list migration and a two-client offline edit demonstration.
4. Ship the rich note model and core formatting; then tables/section tools and organization.

For implementation changes, run the relevant Rust tests, `npm run check`, and the production build. Extend sync tests for the changed behavior rather than treating the current relay test as proof of all offline behavior. Use browser tests for route transitions, reloads, migration, and upload recovery. Validate touch, soft keyboard, pen, and fold transitions on hardware.

Release review must include: current shopping-list regression checks; old/new client compatibility; offline restart and reconnect; data export/restore; keyboard and screen-reader use; oversized content; and missing/failed assets. Shared library changes must also be checked in Muninn.

Before selecting dates, complete the rich-editor and Fold pen spikes and measure a representative library. The biggest uncertainty is editor/migration behavior, followed by media durability, encryption/sharing, and advanced handwriting. The responsive shell is comparatively contained and should be the first visible improvement.
