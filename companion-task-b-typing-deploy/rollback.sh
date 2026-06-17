#!/usr/bin/env bash
set -euo pipefail

bridge_backup="${1:-$(ls -dt /opt/companion/bridge-v2.backup.task-b.* 2>/dev/null | head -n 1 || true)}"
frontend_backup="${2:-$(ls -dt /opt/companion/frontend.backup.task-b.* 2>/dev/null | head -n 1 || true)}"

if [[ "$(id -u)" != "0" ]]; then
  echo "[task-b-rollback] ERROR: please run as root" >&2
  exit 1
fi

[[ -d "$bridge_backup" ]] || { echo "[task-b-rollback] ERROR: bridge backup not found" >&2; exit 1; }
[[ -d "$frontend_backup" ]] || { echo "[task-b-rollback] ERROR: frontend backup not found" >&2; exit 1; }

echo "[task-b-rollback] restoring bridge from $bridge_backup"
systemctl stop companion-bridge-v2.service || true
rm -rf /opt/companion/bridge-v2
cp -a "$bridge_backup" /opt/companion/bridge-v2

echo "[task-b-rollback] restoring frontend from $frontend_backup"
rm -rf /opt/companion/frontend
cp -a "$frontend_backup" /opt/companion/frontend

systemctl start companion-bridge-v2.service
curl -fsS --max-time 10 http://127.0.0.1:3001/healthz >/dev/null
echo "[task-b-rollback] done"
