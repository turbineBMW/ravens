# Publishing the ravens on the tailnet

The Mac mini runs `tailscale serve`, which terminates HTTPS with a certificate
for `brandons-mac-mini.tail339aa4.ts.net`, proxies by path to the two
loopback-only containers, and adds the identity headers the servers trust
(`Tailscale-User-Login`, `Tailscale-User-Name`). No passwords anywhere.

Done once on the Mac mini on 2026-11-01 (HTTPS certificates and MagicDNS were
already on for the tailnet; `/` on 443 stays Immich, the ravens are paths
beside it). The CLI lives at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`:

```sh
tailscale serve --bg --set-path /huginn http://127.0.0.1:8081
tailscale serve --bg --set-path /muninn http://127.0.0.1:8082
tailscale serve status
```

Then `https://brandons-mac-mini.tail339aa4.ts.net/huginn/` and `/muninn/`
open on any device signed into the tailnet, including the Fold, and each can
be installed as an app from the browser's menu (the manifests scope them to
their paths, so a link from one raven to the other opens the other installed
app on Android).

Serve strips the mount path before proxying: a request for
`/huginn/v1/health` reaches the container as `/v1/health`, and the web
client's `/huginn/_app/...` files arrive as `/_app/...`. The servers answer
both shapes (the API and the web client at the root and under the base), so
the same image also works behind a proxy that keeps the prefix, such as the
Vite dev server.

To share lists with someone, invite them to the tailnet (the personal plan
allows three users). Their login then arrives in the same header and owns
their own records.

Removing: `tailscale serve --set-path /huginn off` (same for `/muninn`).

## Deploying from this checkout

Until the GitHub images exist, the mini builds the images itself from a copy
of the tree (OrbStack's Docker is at `/usr/local/bin/docker`, which the
non-interactive shell does not have on its PATH):

```sh
rsync -az --delete --exclude target --exclude node_modules --exclude .svelte-kit \
      --exclude '/*/web/build' --exclude .git --exclude '*.db*' \
      ./ brandons-mac-mini.tail339aa4.ts.net:homeserver/ravens/
ssh brandons-mac-mini.tail339aa4.ts.net 'cd homeserver/ravens && export PATH=/usr/local/bin:$PATH && \
      docker compose -f deploy/compose.yml -f deploy/compose.local.yml up -d --build'
```

The stacks live under `~/homeserver/<name>` on the mini, next to immich,
seafile and vaultwarden; the compose project is `ravens`.
