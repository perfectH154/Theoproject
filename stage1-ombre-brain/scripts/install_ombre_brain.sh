#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 1 安装脚本：只部署官方 Ombre Brain 仓库，不实现或改写 MCP server。
# 用法：
#   sudo install -m 0640 config/ombre-brain.env.example /etc/companion/ombre-brain.env
#   sudo editor /etc/companion/ombre-brain.env
#   sudo bash scripts/install_ombre_brain.sh

ENV_FILE="${ENV_FILE:-/etc/companion/ombre-brain.env}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
UNIT_SOURCE="${PROJECT_DIR}/systemd/ombre-brain.service"
UNIT_TARGET="/etc/systemd/system/ombre-brain.service"

log() {
  printf '[ombre-stage1] %s\n' "$*"
}

fail() {
  printf '[ombre-stage1] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "请用 root 运行：sudo bash scripts/install_ombre_brain.sh"
  fi
}

load_env() {
  [[ -f "${ENV_FILE}" ]] || fail "找不到配置文件 ${ENV_FILE}。请先复制 config/ombre-brain.env.example 并填写官方仓库信息。"
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a

  : "${OMBRE_REPO_URL:?请在 ${ENV_FILE} 设置 OMBRE_REPO_URL}"
  : "${OMBRE_REPO_REF:=main}"
  : "${OMBRE_APP_DIR:=/opt/companion/ombre-brain/app}"
  : "${OMBRE_DATA_DIR:=/var/lib/companion/ombre-brain}"
  : "${OMBRE_LOG_DIR:=/var/log/companion}"
  : "${OMBRE_USER:=companion}"
  : "${OMBRE_GROUP:=companion}"
  : "${OMBRE_INSTALL_CMD:?请在 ${ENV_FILE} 设置 OMBRE_INSTALL_CMD}"
  : "${OMBRE_START_CMD:?请在 ${ENV_FILE} 设置 OMBRE_START_CMD}"

  if [[ "${OMBRE_REPO_URL}" == *"OWNER/ombre-brain.git"* ]]; then
    fail "OMBRE_REPO_URL 还是示例值。请改成 Ombre Brain 官方仓库 URL。"
  fi
}

install_base_packages() {
  log "安装基础依赖：git、curl、ca-certificates、bash"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates bash
}

ensure_user_and_dirs() {
  if ! getent group "${OMBRE_GROUP}" >/dev/null; then
    log "创建系统组 ${OMBRE_GROUP}"
    groupadd --system "${OMBRE_GROUP}"
  fi

  if ! id -u "${OMBRE_USER}" >/dev/null 2>&1; then
    log "创建系统用户 ${OMBRE_USER}"
    useradd --system --gid "${OMBRE_GROUP}" --home-dir /nonexistent --shell /usr/sbin/nologin "${OMBRE_USER}"
  fi

  log "创建部署目录和数据目录"
  install -d -m 0755 -o "${OMBRE_USER}" -g "${OMBRE_GROUP}" "$(dirname "${OMBRE_APP_DIR}")"
  install -d -m 0750 -o "${OMBRE_USER}" -g "${OMBRE_GROUP}" "${OMBRE_DATA_DIR}"
  install -d -m 0755 -o "${OMBRE_USER}" -g "${OMBRE_GROUP}" "${OMBRE_LOG_DIR}"
}

sync_repo() {
  if [[ -d "${OMBRE_APP_DIR}/.git" ]]; then
    log "更新现有仓库 ${OMBRE_APP_DIR}"
    runuser -u "${OMBRE_USER}" -- git -C "${OMBRE_APP_DIR}" fetch --tags --prune origin
  else
    log "克隆官方仓库 ${OMBRE_REPO_URL}"
    rm -rf "${OMBRE_APP_DIR}"
    runuser -u "${OMBRE_USER}" -- git clone "${OMBRE_REPO_URL}" "${OMBRE_APP_DIR}"
  fi

  log "切换到版本 ${OMBRE_REPO_REF}"
  runuser -u "${OMBRE_USER}" -- git -C "${OMBRE_APP_DIR}" checkout "${OMBRE_REPO_REF}"
}

install_ombre_dependencies() {
  log "按官方文档执行安装命令：${OMBRE_INSTALL_CMD}"
  runuser -u "${OMBRE_USER}" -- bash -lc "cd '${OMBRE_APP_DIR}' && ${OMBRE_INSTALL_CMD}"
}

install_unit() {
  [[ -f "${UNIT_SOURCE}" ]] || fail "找不到 systemd unit 模板：${UNIT_SOURCE}"
  log "安装 systemd unit 到 ${UNIT_TARGET}"
  install -m 0644 "${UNIT_SOURCE}" "${UNIT_TARGET}"

  # 将 unit 中的默认用户、路径替换为 env 中的实际值，方便非默认部署路径。
  sed -i \
    -e "s#User=companion#User=${OMBRE_USER}#g" \
    -e "s#Group=companion#Group=${OMBRE_GROUP}#g" \
    -e "s#WorkingDirectory=/opt/companion/ombre-brain/app#WorkingDirectory=${OMBRE_APP_DIR}#g" \
    -e "s#ReadWritePaths=/var/lib/companion/ombre-brain /var/log/companion /opt/companion/ombre-brain/app#ReadWritePaths=${OMBRE_DATA_DIR} ${OMBRE_LOG_DIR} ${OMBRE_APP_DIR}#g" \
    "${UNIT_TARGET}"

  systemctl daemon-reload
  systemctl enable --now ombre-brain.service
}

print_status() {
  log "服务状态："
  systemctl --no-pager --full status ombre-brain.service || true
  log "下一步：运行 scripts/verify_ombre_brain.sh 验证 pulse / breath。"
}

main() {
  require_root
  load_env
  install_base_packages
  ensure_user_and_dirs
  sync_repo
  install_ombre_dependencies
  install_unit
  print_status
}

main "$@"
