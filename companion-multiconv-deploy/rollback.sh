#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="companion-bridge.service"
BRIDGE_DIR="/opt/companion/bridge"
FRONTEND_DIR="/opt/companion/frontend"
DB_FILE="/var/lib/companion/companion.db"
BACKUP_MARKER="/opt/companion/.last_multiconv_backup"
TS="$(date +%Y%m%d-%H%M%S)"

log() {
  printf '[rollback] %s\n' "$*"
}

fail() {
  printf '[rollback] ERROR: %s\n' "$*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "请用 root 执行：sudo bash rollback.sh"
fi

if [ ! -f "$BACKUP_MARKER" ]; then
  fail "找不到 $BACKUP_MARKER，无法知道要回滚到哪份备份。"
fi

# shellcheck disable=SC1090
source "$BACKUP_MARKER"

[ -n "${BRIDGE_BACKUP:-}" ] && [ -d "$BRIDGE_BACKUP" ] || fail "Bridge 备份不存在：${BRIDGE_BACKUP:-}"
[ -n "${FRONTEND_BACKUP:-}" ] && [ -d "$FRONTEND_BACKUP" ] || fail "Frontend 备份不存在：${FRONTEND_BACKUP:-}"

log "停止 Bridge"
systemctl stop "$SERVICE_NAME" || true

if [ -d "$BRIDGE_DIR" ]; then
  log "保留当前坏版本: $BRIDGE_DIR.failed.$TS"
  mv "$BRIDGE_DIR" "$BRIDGE_DIR.failed.$TS"
fi
log "恢复 Bridge: $BRIDGE_BACKUP -> $BRIDGE_DIR"
cp -a "$BRIDGE_BACKUP" "$BRIDGE_DIR"

if [ -d "$FRONTEND_DIR" ]; then
  log "保留当前前端: $FRONTEND_DIR.failed.$TS"
  mv "$FRONTEND_DIR" "$FRONTEND_DIR.failed.$TS"
fi
log "恢复 Frontend: $FRONTEND_BACKUP -> $FRONTEND_DIR"
cp -a "$FRONTEND_BACKUP" "$FRONTEND_DIR"

if [ -n "${DB_BACKUP:-}" ] && [ -f "$DB_BACKUP" ]; then
  log "恢复数据库: $DB_BACKUP -> $DB_FILE"
  cp -a "$DB_BACKUP" "$DB_FILE"
else
  log "没有数据库备份，跳过 DB 回滚"
fi

log "启动 Bridge"
systemctl start "$SERVICE_NAME"
sleep 2

log "健康检查 /healthz"
curl -fsS "http://127.0.0.1:3000/healthz"
printf '\n'
log "回滚完成"
