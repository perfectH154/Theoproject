#!/usr/bin/env bash
set -euo pipefail

backup_dir="${1:-}"
bridge_dir="/opt/companion/bridge-v2"

if [[ "$(id -u)" != "0" ]]; then
  echo "[task-a-rollback] ERROR: please run as root" >&2
  exit 1
fi

if [[ -z "$backup_dir" ]]; then
  backup_dir="$(ls -dt /opt/companion/bridge-v2.backup.task-a.* 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
  echo "[task-a-rollback] ERROR: backup dir not found" >&2
  exit 1
fi

echo "[task-a-rollback] restoring $backup_dir -> $bridge_dir"
systemctl stop companion-bridge-v2.service || true
rm -rf "$bridge_dir"
cp -a "$backup_dir" "$bridge_dir"
systemctl start companion-bridge-v2.service
curl -fsS --max-time 10 http://127.0.0.1:3001/healthz >/dev/null
echo "[task-a-rollback] done"
