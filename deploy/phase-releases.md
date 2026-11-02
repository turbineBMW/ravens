# Releases

Ravens is alpha: there are no real notes or reminders, and the Mac mini's
instance can be overwritten. Releases are kept light until that changes.

1. Branch from `main` and open a PR. `main` is protected, so the `check` job must
   pass before merging.
2. Run the automated suites once: `npm run check`, `npm run build`,
   `cargo test --workspace`, `node scripts/huginn-model-test.cjs`,
   `node scripts/huginn-shell-test.mjs` and `node scripts/huginn-browser-test.mjs`.
3. Deploy the branch with `scripts/deploy-mini.sh --dry-run`, then
   `scripts/deploy-mini.sh`. It builds both images on the mini, restarts them and
   confirms the new version is live.

No migrations: a format change may break existing documents, and wiping the
mini's data is fine. To wipe it, remove the `huginn_data` or `muninn_data` volume
on the mini.

When real data arrives, bring back backups before each deploy, migrations for
format changes, and the version gate (`NOTE_FORMAT`, `CLIENT_VERSION` and each
app's `min_client`).
