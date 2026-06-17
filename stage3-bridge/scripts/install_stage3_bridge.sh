#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 3 安装脚本：复制 Bridge 项目、安装依赖、安装 systemd unit。
# 用法：
#   sudo bash scripts/install_stage3_bridge.sh

ENV_TARGET="${ENV_TARGET:-/etc/companion/bridge.env}"
APP_DIR="${APP_DIR:-/opt/companion/bridge}"
DATA_DIR="${DATA_DIR:-/var/lib/companion}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

log() {
  printf '[bridge-stage3] %s\n' "$*"
}

fail() {
  printf '[bridge-stage3] ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "请用 root 运行：sudo bash scripts/install_stage3_bridge.sh"
fi

log "安装 Node native 依赖构建工具"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates build-essential python3 make g++

if ! command -v node >/dev/null 2>&1; then
  fail "未找到 node。请先安装 Node 20：curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${node_major}" -lt 20 ]]; then
  fail "当前 Node 版本是 $(node -v)，Bridge 需要 Node 20+。请先升级 Node 20。"
fi

log "创建目录"
install -d -m 0755 /etc/companion
install -d -m 0755 /opt/companion
install -d -m 0750 "${DATA_DIR}" "${DATA_DIR}/uploads" "${DATA_DIR}/audio" "${DATA_DIR}/tmp"

if [[ ! -f "${ENV_TARGET}" ]]; then
  log "生成 ${ENV_TARGET}"
  install -m 0640 "${PROJECT_DIR}/.env.example" "${ENV_TARGET}"
  token="$(node "${PROJECT_DIR}/scripts/generate_token.js")"
  sed -i "s#BRIDGE_TOKEN=replace-with-32-byte-random-token#BRIDGE_TOKEN=${token}#g" "${ENV_TARGET}"
  log "已生成 BRIDGE_TOKEN，请保存：${token}"
else
  log "${ENV_TARGET} 已存在，保留现有配置"
fi

ensure_env_line() {
  local key="$1"
  local value="$2"
  if ! grep -q "^${key}=" "${ENV_TARGET}" 2>/dev/null; then
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_TARGET}"
  fi
}

log "复制 Bridge 项目到 ${APP_DIR}"
rm -rf "${APP_DIR}.new"
install -d -m 0755 "${APP_DIR}.new"
cp -a "${PROJECT_DIR}/." "${APP_DIR}.new/"
rm -rf "${APP_DIR}.new/node_modules"
if [[ -d "${APP_DIR}" ]]; then
  rm -rf "${APP_DIR}.old"
  mv "${APP_DIR}" "${APP_DIR}.old"
fi
mv "${APP_DIR}.new" "${APP_DIR}"

log "安装 npm 依赖"
cd "${APP_DIR}"
npm install --omit=dev
npm run check
chmod +x "${APP_DIR}/scripts/claude_turn.sh"

ensure_env_line "OPENROUTER_API_KEY" ""
ensure_env_line "CLAUDE_MODEL" ""
ensure_env_line "OPENROUTER_BASE_URL" "https://openrouter.ai/api/v1"
ensure_env_line "PUSH_MODEL" "anthropic/claude-haiku-4.5"
ensure_env_line "PUSH_ENABLED" "false"
ensure_env_line "PUSH_SESSION_ID" "default"
ensure_env_line "PUSH_TIMES" "07:30,12:30,15:00,19:00,22:30"
ensure_env_line "PUSH_TIMEZONE" "Asia/Shanghai"
ensure_env_line "PUSH_MIN_GAP_MINUTES" "120"
ensure_env_line "PUSH_DECIDER_MAX_TOKENS" "5"
ensure_env_line "PUSH_GENERATOR_MAX_TOKENS" "200"
ensure_env_line "CLAUDE_PERSONA_PATH" "/root/.claude/CLAUDE.md"
ensure_env_line "DREAM_EVENTS_TOKEN" "replace-with-32-byte-random-token"
ensure_env_line "VAPID_PUBLIC_KEY" ""
ensure_env_line "VAPID_PRIVATE_KEY" ""
ensure_env_line "VAPID_SUBJECT" "mailto:you@example.com"
ensure_env_line "DEFAULT_APPROVED_MCP_TOOLS" "MCP_OMBRE_PULSE,MCP_OMBRE_BREATH"

if grep -q '^VAPID_PUBLIC_KEY=$' "${ENV_TARGET}" 2>/dev/null || ! grep -q '^VAPID_PUBLIC_KEY=' "${ENV_TARGET}" 2>/dev/null; then
  log "生成 VAPID key"
  vapid_json="$(node "${APP_DIR}/scripts/generate_vapid.js")"
  public_key="$(printf '%s' "${vapid_json}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).publicKey))")"
  private_key="$(printf '%s' "${vapid_json}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).privateKey))")"
  if grep -q '^VAPID_PUBLIC_KEY=' "${ENV_TARGET}"; then
    sed -i "s#^VAPID_PUBLIC_KEY=.*#VAPID_PUBLIC_KEY=${public_key}#g" "${ENV_TARGET}"
  else
    printf '\nVAPID_PUBLIC_KEY=%s\n' "${public_key}" >> "${ENV_TARGET}"
  fi
  if grep -q '^VAPID_PRIVATE_KEY=' "${ENV_TARGET}"; then
    sed -i "s#^VAPID_PRIVATE_KEY=.*#VAPID_PRIVATE_KEY=${private_key}#g" "${ENV_TARGET}"
  else
    printf 'VAPID_PRIVATE_KEY=%s\n' "${private_key}" >> "${ENV_TARGET}"
  fi
fi

if grep -q '^DREAM_EVENTS_TOKEN=replace-with-32-byte-random-token$' "${ENV_TARGET}" 2>/dev/null || grep -q '^DREAM_EVENTS_TOKEN=$' "${ENV_TARGET}" 2>/dev/null; then
  log "生成 DREAM_EVENTS_TOKEN"
  dream_token="$(node "${APP_DIR}/scripts/generate_token.js")"
  sed -i "s#^DREAM_EVENTS_TOKEN=.*#DREAM_EVENTS_TOKEN=${dream_token}#g" "${ENV_TARGET}"
fi

log "安装 systemd unit"
install -m 0644 "${APP_DIR}/systemd/companion-bridge.service" /etc/systemd/system/companion-bridge.service
systemctl daemon-reload
systemctl enable --now companion-bridge.service

log "安装完成。查看状态：systemctl status companion-bridge.service --no-pager --full"
