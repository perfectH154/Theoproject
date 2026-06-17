#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="companion-bridge.service"
BRIDGE_DIR="/opt/companion/bridge"
FRONTEND_DIR="/opt/companion/frontend"
DB_FILE="/var/lib/companion/companion.db"
ENV_FILE="/etc/companion/bridge.env"
BACKUP_MARKER="/opt/companion/.last_multiconv_backup"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_BRIDGE="$SCRIPT_DIR/stage3-bridge"
PAYLOAD_FRONTEND="$SCRIPT_DIR/stage5-pwa/dist"
TS="$(date +%Y%m%d-%H%M%S)"

log() {
  printf '[multiconv] %s\n' "$*"
}

fail() {
  printf '[multiconv] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    fail "请用 root 执行：sudo bash install.sh"
  fi
}

require_vps() {
  local host
  host="$(hostname)"
  if [ "$host" != "Theo" ]; then
    fail "hostname 不是 Theo，当前是 $host。为避免装错机器，已停止。"
  fi
  [ -d "$BRIDGE_DIR" ] || fail "$BRIDGE_DIR 不存在，活服务目录没找到。"
  [ -f "$BRIDGE_DIR/src/server.js" ] || fail "$BRIDGE_DIR/src/server.js 不存在，拒绝覆盖。"
  [ -d "$PAYLOAD_BRIDGE/src" ] || fail "包内缺少 stage3-bridge/src"
  [ -d "$PAYLOAD_FRONTEND" ] || fail "包内缺少 stage5-pwa/dist，请确认前端已经 build"
}

backup_everything() {
  BRIDGE_BACKUP="/opt/companion/bridge.backup.$TS"
  FRONTEND_BACKUP="/opt/companion/frontend.backup.$TS"
  DB_BACKUP="/var/lib/companion/companion.db.backup.$TS"

  log "备份 Bridge: $BRIDGE_BACKUP"
  cp -a "$BRIDGE_DIR" "$BRIDGE_BACKUP"

  if [ -d "$FRONTEND_DIR" ]; then
    log "备份 Frontend: $FRONTEND_BACKUP"
    cp -a "$FRONTEND_DIR" "$FRONTEND_BACKUP"
  else
    log "Frontend 目录不存在，将创建：$FRONTEND_DIR"
    mkdir -p "$FRONTEND_DIR"
    mkdir -p "$FRONTEND_BACKUP"
  fi

  if [ -f "$DB_FILE" ]; then
    log "备份数据库: $DB_BACKUP"
    cp -a "$DB_FILE" "$DB_BACKUP"
  else
    log "数据库文件还不存在，跳过 DB 备份"
    DB_BACKUP=""
  fi

  cat > "$BACKUP_MARKER" <<EOF_MARKER
BRIDGE_BACKUP='$BRIDGE_BACKUP'
FRONTEND_BACKUP='$FRONTEND_BACKUP'
DB_BACKUP='$DB_BACKUP'
TIMESTAMP='$TS'
EOF_MARKER
}

install_bridge_package_json() {
  if [ -f "$PAYLOAD_BRIDGE/package.json" ]; then
    if [ ! -f "$BRIDGE_DIR/package.json" ] || ! cmp -s "$PAYLOAD_BRIDGE/package.json" "$BRIDGE_DIR/package.json"; then
      log "package.json 有变化，复制并 npm install"
      cp -a "$PAYLOAD_BRIDGE/package.json" "$BRIDGE_DIR/package.json"
      (cd "$BRIDGE_DIR" && npm install)
    else
      log "package.json 无变化，跳过 npm install"
    fi
  else
    log "包内没有 package.json，跳过依赖检查"
  fi
}

install_bridge_src() {
  log "覆盖 Bridge src -> $BRIDGE_DIR/src"
  mkdir -p "$BRIDGE_DIR/src"
  cp -a "$PAYLOAD_BRIDGE/src/." "$BRIDGE_DIR/src/"
}

install_bridge_scripts() {
  [ -d "$PAYLOAD_BRIDGE/scripts" ] || return 0
  log "增量同步 scripts，保护 claude_turn.sh"
  mkdir -p "$BRIDGE_DIR/scripts"

  for src in "$PAYLOAD_BRIDGE"/scripts/*; do
    [ -f "$src" ] || continue
    name="$(basename "$src")"
    dest="$BRIDGE_DIR/scripts/$name"

    if [ "$name" = "claude_turn.sh" ] && [ -f "$dest" ]; then
      if cmp -s "$src" "$dest"; then
        log "claude_turn.sh 无变化"
      else
        log "claude_turn.sh 已定制，不覆盖；保存 incoming 和 diff"
        cp -a "$src" "$dest.incoming.$TS"
        diff -u "$dest" "$src" > "$dest.diff.$TS" || true
      fi
      continue
    fi

    cp -a "$src" "$dest"
    case "$name" in
      *.sh) chmod +x "$dest" ;;
    esac
  done
}

run_migration() {
  log "运行数据库 migration"
  (cd "$BRIDGE_DIR" && DOTENV_CONFIG_PATH="$ENV_FILE" node -r dotenv/config -e "require('./src/db'); console.log('migration ok')")
}

install_frontend() {
  log "覆盖前端 dist -> $FRONTEND_DIR"
  mkdir -p "$FRONTEND_DIR"
  find "$FRONTEND_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  cp -a "$PAYLOAD_FRONTEND/." "$FRONTEND_DIR/"
}

restart_and_check() {
  log "重启 Bridge"
  systemctl restart "$SERVICE_NAME"
  sleep 2

  log "健康检查 /healthz"
  curl -fsS "http://127.0.0.1:3000/healthz" >/tmp/companion-healthz.json
  cat /tmp/companion-healthz.json
  printf '\n'
}

smoke_test_conversations() {
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE 不存在，无法读取 BRIDGE_TOKEN"
  TOKEN="$(grep '^BRIDGE_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
  [ -n "${TOKEN:-}" ] || fail "BRIDGE_TOKEN 为空"

  log "多对话冒烟测试：创建 conversation"
  CREATE_JSON="$(curl -fsS -X POST "http://127.0.0.1:3000/api/conversations" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"title":"install smoke test"}')"

  CONV_ID="$(printf '%s' "$CREATE_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).conversation.id))")"
  [ -n "$CONV_ID" ] || fail "创建 conversation 后没有拿到 id"

  log "多对话冒烟测试：列表检查 $CONV_ID"
  LIST_JSON="$(curl -fsS "http://127.0.0.1:3000/api/conversations" -H "Authorization: Bearer $TOKEN")"
  printf '%s' "$LIST_JSON" | grep -q "$CONV_ID" || fail "列表里没找到刚创建的 conversation"
  log "多对话冒烟测试通过: $CONV_ID"
}

main() {
  require_root
  require_vps
  backup_everything
  install_bridge_package_json
  install_bridge_src
  install_bridge_scripts
  run_migration
  install_frontend
  restart_and_check
  smoke_test_conversations
  log "部署完成。rollback: bash $SCRIPT_DIR/rollback.sh"
}

main "$@"
