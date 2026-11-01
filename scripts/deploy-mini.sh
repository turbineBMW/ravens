#!/usr/bin/env bash
# Deploy this checkout to the Mac mini: copy it over, build both images there,
# restart the containers and confirm the new version is live. Data lives in
# Docker volumes, which a deploy does not touch.
#
#   scripts/deploy-mini.sh            deploy (uncommitted work included, version marked -dirty)
#   scripts/deploy-mini.sh --dry-run  show what would change on the mini, then stop
#   scripts/deploy-mini.sh --force    deploy even if behind origin/main or removing many files
#
# It works from any directory and copies only files git tracks or would track,
# so it can't send anything but this repo. It refuses a target folder that holds
# something other than the repo; --force does not override that.
#
# RAVENS_DEPLOY_HOST and RAVENS_DEPLOY_DIR (relative to the remote home) override
# the defaults.
set -euo pipefail

host="${RAVENS_DEPLOY_HOST:-brandons-mac-mini.tail339aa4.ts.net}"
dir="${RAVENS_DEPLOY_DIR:-homeserver/ravens}"
max_deletions=50
health_timeout=120

dry_run=false
force=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) dry_run=true ;;
        --force) force=true ;;
        -h | --help)
            sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown option: $arg (try --help)" >&2
            exit 2
            ;;
    esac
done

say() { printf '\n==> %s\n' "$*"; }
die() {
    printf '\nDeploy stopped: %s\n' "$*" >&2
    exit 1
}

case "$dir" in
    '' | /* | *..*) die "RAVENS_DEPLOY_DIR must be a path inside the remote home, not '$dir'." ;;
esac

root="$(git -C "$(dirname "$(readlink -f "$0")")" rev-parse --show-toplevel)"
[[ -f "$root/Cargo.toml" && -f "$root/deploy/compose.local.yml" ]] || die "$root is not the Ravens repo."

# Everything below prompts at most once: the commands share one SSH connection.
# The socket path has a short length limit, so this ignores TMPDIR.
work="$(mktemp -d /tmp/ravens-deploy.XXXXXX)"
ssh_opts=(-o ControlMaster=auto -o "ControlPath=$work/ssh" -o ControlPersist=300 -o ConnectTimeout=15)
cleanup() {
    ssh "${ssh_opts[@]}" -O exit "$host" 2>/dev/null || true
    rm -rf "$work"
}
trap cleanup EXIT
export ASKPASS_REASON="${ASKPASS_REASON:-Deploy Ravens to the Mac mini: copy the repo, rebuild its containers and restart them}"
remote() { ssh "${ssh_opts[@]}" "$host" "$@"; }

# What is being deployed
version="$(git -C "$root" rev-parse HEAD)"
if [[ -n "$(git -C "$root" status --porcelain)" ]]; then
    version="$version-dirty"
    echo "Warning: uncommitted changes will be deployed."
fi
echo "Deploying $version"
echo "       to $host:$dir"

# Deploying a checkout that is missing merged work would quietly roll the server back.
if git -C "$root" fetch -q origin main 2>/dev/null; then
    behind="$(git -C "$root" rev-list --count HEAD..origin/main)"
    if [[ "$behind" != 0 ]]; then
        $force || $dry_run || die "this checkout is $behind commit(s) behind origin/main, so deploying would roll the server back. Pull, or use --force."
        echo "Warning: this checkout is $behind commit(s) behind origin/main."
    fi
else
    echo "Warning: couldn't reach GitHub to check whether this checkout is up to date."
fi

# The target must be missing, empty, or already the repo.
say "Checking the target folder"
state="$(remote "if [ ! -e '$dir' ]; then echo missing
    elif [ ! -d '$dir' ]; then echo other
    elif [ -z \"\$(ls -A '$dir')\" ]; then echo empty
    elif [ -f '$dir/Cargo.toml' ] && [ -f '$dir/deploy/compose.yml' ]; then echo repo
    else echo other; fi")" || die "couldn't connect to $host."
case "$state" in
    repo) echo "It holds the repo." ;;
    missing | empty) echo "It's $state, so this will be a fresh copy." ;;
    *) die "$host:$dir exists but isn't the Ravens repo. Look at it by hand; this script won't overwrite it." ;;
esac

# A clean tree of exactly what git knows about, so ignored files (databases,
# .env, build output) can't travel and the copy below needs no exclude list.
tree="$work/tree"
mkdir "$tree"
git -C "$root" ls-files -z --cached --others --exclude-standard |
    rsync -a --from0 --files-from=- --ignore-missing-args "$root/" "$tree/"

# --checksum: file times differ after any checkout, so compare contents.
sync_tree() { rsync -az --checksum --delete -e "ssh ${ssh_opts[*]}" "$@" "$tree/" "$host:$dir/"; }

say "Comparing with the mini"
if [[ "$state" == repo ]]; then
    sync_tree --dry-run --itemize-changes >"$work/plan"
    # Codes starting < or c are new or changed contents; the rest are only timestamps.
    grep -E '^(<|c)' "$work/plan" | grep -v '/$' | awk '{print "  update  " $2}' || true
    grep '^\*deleting' "$work/plan" | awk '{print "  DELETE  " $2}' || true
    deletions="$(grep -c '^\*deleting' "$work/plan" || true)"
else
    echo "  $(find "$tree" -type f | wc -l) files to copy"
    deletions=0
fi
echo "$deletions file(s) would be deleted."

if $dry_run; then
    say "Dry run: nothing changed on the mini."
    exit 0
fi
if ((deletions > max_deletions)) && ! $force; then
    die "this would delete $deletions files on the mini (limit $max_deletions). Check the list above, then use --force if it's right."
fi

say "Copying"
[[ "$state" == missing ]] && remote "mkdir -p '$dir'"
sync_tree

# --force-recreate: without it, compose has left a container on its old image
# after a rebuild.
say "Building and restarting (a Rust change can take several minutes)"
remote "cd '$dir' && export PATH=/usr/local/bin:\$PATH RAVEN_VERSION='$version' &&
    docker compose -f deploy/compose.yml -f deploy/compose.local.yml up -d --build --force-recreate" ||
    die "the build or restart failed. The output above has the reason."

say "Waiting for both apps to report healthy"
remote "export PATH=/usr/local/bin:\$PATH
    end=\$((\$(date +%s) + $health_timeout))
    for app in huginn muninn; do
        while :; do
            s=\$(docker inspect -f '{{.State.Health.Status}}' ravens-\$app-1 2>/dev/null || echo missing)
            [ \"\$s\" = healthy ] && { echo \"\$app healthy\"; break; }
            if [ \$(date +%s) -ge \$end ]; then
                echo \"\$app is '\$s' after ${health_timeout}s. Its latest logs:\"
                docker logs --tail 20 ravens-\$app-1 2>&1
                exit 1
            fi
            sleep 2
        done
    done" || die "a container didn't become healthy."

# Through tailscale serve, the same way a device reaches them.
say "Checking the live version"
for app in huginn muninn; do
    url="https://$host/$app/v1/health"
    live="$(curl -fsS -m 15 "$url")" || die "$url didn't respond. Is 'tailscale serve' still running on the mini?"
    grep -qF "\"version\":\"$version\"" <<<"$live" || die "$url reports the wrong version: $live"
    echo "$app is live: $live"
done

say "Deployed $version"
echo "Reload any open tabs and installed apps to pick up the new client."
