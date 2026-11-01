# Ravens: Huginn and Muninn

Two self-hosted apps, named for Odin's ravens, that replace Google Keep and
Apple Notes (Huginn, "thought") and Apple Reminders and Google Tasks (Muninn,
"memory") on a personal server. Separate apps that link to each other: select
a sentence in a Huginn note, tap *Remind me*, and Muninn makes a reminder that
points back at the note.

Built for a Surface Pro 11 running Omarchy (pen through iptsd) and a Galaxy Z
Fold (S Pen), served from a Mac mini over Tailscale. Pen and touch are
first-class: the pen writes, fingers scroll. Checklists sort checked items to
the bottom and drag to reorder. Ink is stored as strokes, so a drawing made on
one device is editable on the other.

## Layout

```
shared/raven-core/     Rust: the types both apps agree on (identity, links, health)
shared/raven-server/   Rust: config, SQLite + migrations, Tailscale identity, web client, health,
                       document sync (the y-websocket server end, on yrs)
shared/ui/             Svelte/TS: Omarchy theme, palette tokens, pointer helpers, API client,
                       local-first documents (Yjs + y-indexeddb + y-websocket)
huginn/server          axum binary: Huginn's schema and API on raven-server
huginn/web             SvelteKit (static, SPA) client, served under /huginn
muninn/server          same, for Muninn, plus the task mirror, links API and notifications
muninn/web             served under /muninn
muninn/agent           muninn-agent: reminders as desktop notifications (SSE → desktop notifications)
deploy/                compose for the Mac mini; tailscale serve notes
scripts/               sync-e2e.mjs (two clients through a live server), seed-demo.mjs, build-icons.sh (app icons from <app>/web/icon-source.png)
spikes/pen/            the pen-on-the-web go/no-go page
Dockerfile             one file, `--build-arg APP=huginn|muninn`
```

## Run it here

```sh
cargo test --workspace
npm install && npm run build

# API + built client for Huginn on http://127.0.0.1:8081/huginn/ as a dev user:
RAVEN_DEV_USER=$USER RAVEN_WEB_DIR=huginn/web/build cargo run -p huginn-server
# Muninn the same way on :8082 with muninn/web/build.

# Or the Vite dev server with hot reload (API from the cargo run above):
npm run dev:huginn      # http://localhost:5173/huginn/
npm run dev:muninn      # http://localhost:5174/muninn/
```

To open a dev server from the Fold, add `-- --host` and use this machine's
tailnet name.

## Working on it

The repo is github.com/turbineBMW/ravens and `main` is protected: changes
arrive by pull request, the `check` job (Rust tests, svelte-check) must pass,
history stays linear, and nobody force-pushes or deletes it, admins included.
So: branch, push, `gh pr create`, wait for the check, merge.

## Deploy

GitHub Actions builds `ghcr.io/turbinebmw/huginn` and `.../muninn` for
amd64 and arm64 on every push to main (public images, so the mini pulls
them without a token). On the Mac mini:

```sh
cd deploy && RAVENS_TAG=<commit or main> docker compose up -d
```

then publish them once with `tailscale serve` as in
[deploy/tailscale-serve.md](deploy/tailscale-serve.md).

## How data moves

Every note and each user's index of notes is a Yjs document. The browser
edits its local copy and keeps it in IndexedDB, so the app works offline and
opens instantly; y-websocket carries changes to `/v1/sync/<name>` on the
app's server, where yrs merges them, stores them in SQLite and relays them to
the other devices. Two devices editing the same list offline merge cleanly
when they reconnect. Each checklist item is its own object with a stable id,
a checked flag and a fractional-index position, which is what makes
drag-to-reorder and checked-to-the-bottom conflict-free.

```sh
node scripts/sync-e2e.mjs            # against a running huginn-server on :8081
node scripts/seed-demo.mjs           # a demo grocery list for the dev user; prints the note id
node scripts/seed-muninn.mjs ws://127.0.0.1:8082/muninn/v1/sync <note id>   # demo lists, one linked to that note
```

An app may register an `on_change` hook (see `AppSpec`) that runs after each
change to a document with the transaction and the database connection, to
mirror what it needs into tables. Muninn mirrors its lists' tasks that way
(`muninn/server/src/mirror.rs`); the documents stay the truth and the tables
can be rebuilt from them.

## Notifications

On the Surface: `muninn/agent/install.sh` builds `muninn-agent`, installs it
to `~/.local/bin` and runs it as a systemd user service following
`https://brandons-mac-mini.tail339aa4.ts.net/muninn/v1/notifications/stream`;
each reminder shows through the desktop notification daemon (omarchy-shell). On the Fold (or any browser): open Muninn,
menu, *Notify on this device*; the browser subscribes to web push and the
server (VAPID keys it generated on first start) pushes each reminder. *Send a
test* checks the path. All-day reminders fire at 09:00 in the device's time
zone (the app records the zone in the index document; the hour is the
`allDayAt` setting there).

## How identity works

There is no login. Requests arrive through `tailscale serve`, which adds
`Tailscale-User-Login`; the servers trust that header only when
`RAVEN_TRUST_IDENTITY_HEADERS=true`, which compose sets because the
containers listen on loopback alone. On a workstation `RAVEN_DEV_USER` names
the user instead.

## Following the Omarchy theme

The web clients read the desktop palette through the loopback theme bridge
from fieldhook-monitor (`tools/omarchy-theme-bridge`). Add the ravens' origin
to that service's `OMARCHY_BRIDGE_ORIGINS`, then turn on *Follow the Omarchy
theme* in either app's menu; the setting is shared by both.

## Plan

Huginn's next stages are detailed in the
[Apple Notes parity roadmap](docs/huginn-apple-notes-roadmap.md), including
the phone/two-column layout, current feature gaps, dependencies, and acceptance
criteria for each phase.

1. Pen spike (`spikes/pen`): the Surface passes; the Fold is untested (no compatible pen yet).
2. The shell: identity, theme, installable.
3. Huginn checklists on the sync layer: the Keep grocery list, done right.
4. Deployed to the Mac mini behind `tailscale serve` (2026-11-01).
5. Muninn lists, due dates, flags, subtasks, smart views; then notifications and the link. **← here**
6. Huginn rich text, then ink.
