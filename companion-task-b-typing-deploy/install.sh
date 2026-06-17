#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[task-b] %s\n' "$*"
}

if [[ "$(id -u)" != "0" ]]; then
  echo "[task-b] ERROR: please run as root" >&2
  exit 1
fi

if [[ "$(hostname)" != "Theo" ]]; then
  echo "[task-b] ERROR: this installer is intended for hostname Theo" >&2
  exit 1
fi

bridge_dir="/opt/companion/bridge-v2"
frontend_dir="/opt/companion/frontend"
timestamp="$(date +%Y%m%d-%H%M%S)"
bridge_backup="/opt/companion/bridge-v2.backup.task-b.${timestamp}"
frontend_backup="/opt/companion/frontend.backup.task-b.${timestamp}"

[[ -d "$bridge_dir" ]] || { echo "[task-b] ERROR: $bridge_dir does not exist" >&2; exit 1; }
[[ -d "$frontend_dir" ]] || { echo "[task-b] ERROR: $frontend_dir does not exist" >&2; exit 1; }

log "backup bridge -> $bridge_backup"
cp -a "$bridge_dir" "$bridge_backup"
log "backup frontend -> $frontend_backup"
cp -a "$frontend_dir" "$frontend_backup"

log "install backend split-message support"
install -m 0644 bridge-v2/src/services/claudePty.js "$bridge_dir/src/services/claudePty.js"

log "install frontend dist"
find "$frontend_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a stage5-pwa/dist/. "$frontend_dir/"

log "syntax check"
(cd "$bridge_dir" && npm run check)

log "restart bridge-v2"
systemctl restart companion-bridge-v2.service
sleep 3

log "health checks"
curl -fsS --max-time 10 http://127.0.0.1:3001/healthz >/dev/null
curl -fsS --max-time 20 -o /dev/null -w '[task-b] public /chat status: %{http_code}\n' https://theo.cecilexiejiuyuan.xyz/chat/

log "done"
log "bridge backup: $bridge_backup"
log "frontend backup: $frontend_backup"
