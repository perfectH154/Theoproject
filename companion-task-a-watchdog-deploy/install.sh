#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[task-a] %s\n' "$*"
}

if [[ "$(id -u)" != "0" ]]; then
  echo "[task-a] ERROR: please run as root" >&2
  exit 1
fi

if [[ "$(hostname)" != "Theo" ]]; then
  echo "[task-a] ERROR: this installer is intended for hostname Theo" >&2
  exit 1
fi

bridge_dir="/opt/companion/bridge-v2"
env_file="/etc/companion/bridge-v2.env"
timestamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="/opt/companion/bridge-v2.backup.task-a.${timestamp}"

if [[ ! -d "$bridge_dir" ]]; then
  echo "[task-a] ERROR: $bridge_dir does not exist" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  echo "[task-a] ERROR: $env_file does not exist" >&2
  exit 1
fi

log "backup $bridge_dir -> $backup_dir"
cp -a "$bridge_dir" "$backup_dir"

log "install patched bridge-v2 files"
install -m 0644 bridge-v2/src/services/claudePty.js "$bridge_dir/src/services/claudePty.js"
install -m 0644 bridge-v2/src/routes/api.js "$bridge_dir/src/routes/api.js"
install -m 0755 bridge-v2/scripts/watchdog.sh "$bridge_dir/scripts/watchdog.sh"
install -m 0755 bridge-v2/scripts/restart-cc.sh "$bridge_dir/scripts/restart-cc.sh"

log "ensure CLAUDE_CHANNEL_MAX_SESSIONS=1"
if grep -q '^CLAUDE_CHANNEL_MAX_SESSIONS=' "$env_file"; then
  sed -i 's/^CLAUDE_CHANNEL_MAX_SESSIONS=.*/CLAUDE_CHANNEL_MAX_SESSIONS=1/' "$env_file"
else
  printf '\nCLAUDE_CHANNEL_MAX_SESSIONS=1\n' >> "$env_file"
fi

log "syntax check"
(cd "$bridge_dir" && npm run check)

log "restart companion-bridge-v2"
systemctl restart companion-bridge-v2.service
sleep 3

log "health check"
curl -fsS --max-time 10 http://127.0.0.1:3001/healthz >/dev/null

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
  echo "[task-a] ERROR: BRIDGE_TOKEN is empty in $env_file" >&2
  exit 1
fi

log "restart-claude convergence smoke test"
curl -fsS --max-time 90 \
  -X POST \
  -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"reason":"install_smoke_test"}' \
  http://127.0.0.1:3001/api/admin/restart-claude
echo

log "done; backup is $backup_dir"
