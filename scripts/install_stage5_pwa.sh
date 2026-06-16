#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 5 安装脚本：
# - 构建 React/Vite PWA
# - 发布到 /opt/companion/frontend
# - 确保 Bridge env 有 FRONTEND_DIR
# - 重启 companion-bridge

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FRONTEND_DIR="${FRONTEND_DIR:-/opt/companion/frontend}"
BRIDGE_ENV="${BRIDGE_ENV:-/etc/companion/bridge.env}"

log() {
  printf '[stage5] %s\n' "$*"
}

fail() {
  printf '[stage5] ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "请用 root 运行：sudo bash scripts/install_stage5_pwa.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "未找到 node，请先安装 Node 20+"
fi

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${node_major}" -lt 20 ]]; then
  fail "当前 Node 版本是 $(node -v)，需要 Node 20+"
fi

log "安装前端依赖"
cd "${APP_DIR}"
npm install

log "构建 PWA"
npm run build

log "发布到 ${FRONTEND_DIR}"
rm -rf "${FRONTEND_DIR}.new"
install -d -m 0755 "${FRONTEND_DIR}.new"
cp -a dist/. "${FRONTEND_DIR}.new/"

if [[ -d "${FRONTEND_DIR}" ]]; then
  rm -rf "${FRONTEND_DIR}.old"
  mv "${FRONTEND_DIR}" "${FRONTEND_DIR}.old"
fi
mv "${FRONTEND_DIR}.new" "${FRONTEND_DIR}"

if [[ -f "${BRIDGE_ENV}" ]] && ! grep -q '^FRONTEND_DIR=' "${BRIDGE_ENV}"; then
  log "写入 FRONTEND_DIR 到 ${BRIDGE_ENV}"
  printf '\nFRONTEND_DIR=%s\n' "${FRONTEND_DIR}" >> "${BRIDGE_ENV}"
fi

log "重启 Bridge"
systemctl restart companion-bridge.service

log "Stage 5 完成：打开 https://theo.cecilexiejiuyuan.xyz/chat/"
