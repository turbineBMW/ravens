#!/usr/bin/env bash
# Build muninn-agent and run it as a systemd user service (or remove it with --uninstall).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
unit_dir="$HOME/.config/systemd/user"
if [[ "${1:-}" == "--uninstall" ]]; then
    systemctl --user disable --now muninn-agent.service 2>/dev/null || true
    rm -f "$unit_dir/muninn-agent.service" "$HOME/.local/bin/muninn-agent"
    systemctl --user daemon-reload
    echo "Removed muninn-agent."
    exit 0
fi
(cd "$here/../.." && cargo build --release -p muninn-agent)
install -Dm755 "$here/../../target/release/muninn-agent" "$HOME/.local/bin/muninn-agent"
install -Dm644 "$here/systemd/muninn-agent.service" "$unit_dir/muninn-agent.service"
systemctl --user daemon-reload
systemctl --user enable --now muninn-agent.service
systemctl --user restart muninn-agent.service
echo "muninn-agent is following ${MUNINN_URL:-the server in the unit file}."
