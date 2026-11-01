# Phase releases

Each Huginn phase gets its own PR and a Mac mini deployment. Keep the PR open for review; deployment authorization does not imply permission to merge. Deploy the exact PR commit after its checks pass and record the commit, backup location, previous image, and verification result in the PR.

The first release is the responsive workspace plus initial Phase 0 recovery/offline foundations. It does not complete all of Phase 0. Subsequent phases follow the [roadmap](../docs/huginn-apple-notes-roadmap.md).

## Publish and build

Use a branch name without slashes because the image workflow also uses the branch name as a Docker tag.

```sh
ASKPASS_REASON="Publish the Huginn phase branch for review and deployment" git push -u origin huginn-phase-1-workspace
gh pr create --repo turbineBMW/ravens --base main --head huginn-phase-1-workspace \
  --title "Huginn phase 1: responsive workspace and initial recovery foundations" \
  --body-file /tmp/huginn-phase-1-pr.md
gh workflow run build-images.yml --repo turbineBMW/ravens --ref huginn-phase-1-workspace
```

Wait for the PR checks and the dispatched workflow to succeed. Verify the workflow head SHA matches the PR head SHA. The workflow produces both architecture images, tagged with that exact SHA. Use the SHA when deploying; do not rely on a moving branch or `main` tag.

## Inspect the mini and back up

SSH uses `ASKPASS_REASON` as described in the repository's operating instructions. On the mini, Docker is `/usr/local/bin/docker`; add `/usr/local/bin` to PATH in the remote shell.

In `~/homeserver/ravens`, inspect `docker compose -f deploy/compose.yml ps` and the current Huginn image ID/revision. Tag the previous image as `ghcr.io/turbinebmw/huginn:rollback-<release-id>` before pulling anything. Preserve this image until acceptance is complete.

For a consistent backup without installing database tools in the runtime image:

1. Create a new backup directory outside the deployment tree, for example `~/homeserver/backups/ravens/<release-id>/huginn`.
2. Stop only Huginn using `docker compose -f deploy/compose.yml stop huginn`.
3. Resolve its container ID with `docker compose -f deploy/compose.yml ps -aq huginn`, then copy the entire `/data/.` directory into that new backup directory with `docker cp`. This preserves any SQLite sidecars along with the database. Check the copy succeeded and the backup contains `raven.db`.
4. Restart the existing container using `docker compose -f deploy/compose.yml start huginn`, including if backup fails. Do not deploy if backup failed.

The [backup utility](../scripts/backup-db.py) can also create and check a consistent backup wherever Python has direct access to the SQLite database. Browser edits not yet synced are not in a server backup.

## Deploy the pinned commit

Run on the mini after successful backup, substituting the verified commit SHA:

```sh
cd ~/homeserver/ravens
export PATH=/usr/local/bin:$PATH
export RAVENS_TAG=<verified-PR-commit-SHA>
docker compose -f deploy/compose.yml pull huginn
docker compose -f deploy/compose.yml up -d --no-deps --wait huginn
docker compose -f deploy/compose.yml ps huginn
curl -fsS http://127.0.0.1:8081/v1/health
```

Verify the container image revision and health response report the expected SHA. Deploy only Huginn for this release; Muninn's running image stays in place. Do not use the local-build compose override for a release intended to match the reviewed image.

Check `https://brandons-mac-mini.tail339aa4.ts.net/huginn/` through Tailscale, including a direct `/huginn/n/<id>` route, existing shopping-list editing, phone/wide layout, a Muninn item link, trash/restore, and offline relaunch after the service worker installs. Close old Huginn tabs/app windows and reopen them before relying on recovery: older clients still use hard index deletion.

If deployment or checks fail, set `RAVENS_TAG=rollback-<release-id>` and run `docker compose -f deploy/compose.yml up -d --no-deps --wait huginn`. Keep the data volume. Do not automatically restore an old database over edits made since deployment. A browser service worker may retain the newer shell until all tabs close and a subsequent online load installs the rollback worker; verify the client as well as the container.

## Release record

Record the PR URL, deployed SHA, previous image/tag, backup directory, service health, and device checks. List unverified checks explicitly. A prepared branch, image build, or local commit is not a successful deployment.
