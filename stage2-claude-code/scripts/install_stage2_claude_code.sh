#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 2 安装脚本：
# 1. 安装 Claude Code CLI（Ubuntu/Debian 默认使用官方 apt 仓库 stable/latest）
# 2. 安装用户级 CLAUDE.md
# 3. 安装项目级 .mcp.json
# 4. 生成可被 Bridge 调用的 start_claude.sh

ENV_FILE="${ENV_FILE:-/etc/companion/claude-code.env}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

log() {
  printf '[claude-stage2] %s\n' "$*"
}

fail() {
  printf '[claude-stage2] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "请用 root 运行：sudo bash scripts/install_stage2_claude_code.sh"
  fi
}

load_env() {
  [[ -f "${ENV_FILE}" ]] || fail "找不到 ${ENV_FILE}。请先复制 config/claude-code.env.example。"
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a

  : "${COMPANION_CLAUDE_DIR:=/opt/companion/claude}"
  : "${CLAUDE_RUN_USER:=root}"
  : "${CLAUDE_HOME:=/root/.claude}"
  : "${CLAUDE_USER_PROMPT_PATH:=${CLAUDE_HOME}/CLAUDE.md}"
  : "${MCP_CONFIG_PATH:=${COMPANION_CLAUDE_DIR}/.mcp.json}"
  : "${OMBRE_TRANSPORT:=http}"
  : "${CLAUDE_CODE_CHANNEL:=stable}"

  id "${CLAUDE_RUN_USER}" >/dev/null 2>&1 || fail "CLAUDE_RUN_USER=${CLAUDE_RUN_USER} 不存在"
}

install_claude_code() {
  if command -v claude >/dev/null 2>&1; then
    log "Claude Code 已安装：$(claude --version || true)"
    return
  fi

  log "安装 Claude Code CLI，通道：${CLAUDE_CODE_CHANNEL}"
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg

  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o /etc/apt/keyrings/claude-code.asc

  local fingerprint
  fingerprint="$(gpg --show-keys --with-colons /etc/apt/keyrings/claude-code.asc | awk -F: '/^fpr:/ {print $10; exit}')"
  if [[ "${fingerprint}" != "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE" ]]; then
    fail "Claude Code apt key fingerprint 不匹配：${fingerprint}"
  fi

  if [[ "${CLAUDE_CODE_CHANNEL}" != "stable" && "${CLAUDE_CODE_CHANNEL}" != "latest" ]]; then
    fail "CLAUDE_CODE_CHANNEL 只能是 stable 或 latest"
  fi

  printf 'deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/%s %s main\n' \
    "${CLAUDE_CODE_CHANNEL}" "${CLAUDE_CODE_CHANNEL}" \
    > /etc/apt/sources.list.d/claude-code.list

  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y claude-code
  claude --version
}

install_config() {
  log "创建 Claude Code 工作目录：${COMPANION_CLAUDE_DIR}"
  install -d -m 0755 "${COMPANION_CLAUDE_DIR}"
  install -d -m 0700 "$(dirname "${CLAUDE_USER_PROMPT_PATH}")"
  chown "${CLAUDE_RUN_USER}:" "${COMPANION_CLAUDE_DIR}" "$(dirname "${CLAUDE_USER_PROMPT_PATH}")"

  log "安装用户级人格提示：${CLAUDE_USER_PROMPT_PATH}"
  install -m 0600 "${PROJECT_DIR}/config/CLAUDE.md" "${CLAUDE_USER_PROMPT_PATH}"
  chown "${CLAUDE_RUN_USER}:" "${CLAUDE_USER_PROMPT_PATH}"

  log "安装 MCP 配置：${MCP_CONFIG_PATH}"
  case "${OMBRE_TRANSPORT}" in
    http)
      if [[ -n "${OMBRE_MCP_AUTH_HEADER_NAME:-}" && -n "${OMBRE_MCP_AUTH_HEADER_VALUE:-}" ]]; then
        python3 - "${MCP_CONFIG_PATH}" <<'PY'
import json
import os
import sys

target = sys.argv[1]
header_name = os.environ["OMBRE_MCP_AUTH_HEADER_NAME"]
header_value = os.environ["OMBRE_MCP_AUTH_HEADER_VALUE"]
url = os.environ.get("OMBRE_MCP_HTTP_URL", "http://127.0.0.1:8765/mcp")
config = {
    "mcpServers": {
        "ombre-brain": {
            "type": "http",
            "url": url,
            "headers": {header_name: header_value},
            "timeout": 120000,
        }
    }
}
with open(target, "w", encoding="utf-8") as f:
    json.dump(config, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
        chmod 0600 "${MCP_CONFIG_PATH}"
      else
        install -m 0600 "${PROJECT_DIR}/config/mcp.http.json.example" "${MCP_CONFIG_PATH}"
      fi
      ;;
    stdio)
      install -m 0600 "${PROJECT_DIR}/config/mcp.stdio.json.example" "${MCP_CONFIG_PATH}"
      ;;
    *)
      fail "未知 OMBRE_TRANSPORT=${OMBRE_TRANSPORT}，只能是 http 或 stdio"
      ;;
  esac
  chown "${CLAUDE_RUN_USER}:" "${MCP_CONFIG_PATH}"

  log "安装启动脚本：${COMPANION_CLAUDE_DIR}/start_claude.sh"
  install -m 0755 "${PROJECT_DIR}/scripts/start_claude.sh" "${COMPANION_CLAUDE_DIR}/start_claude.sh"
  chown "${CLAUDE_RUN_USER}:" "${COMPANION_CLAUDE_DIR}/start_claude.sh"
}

print_next_steps() {
  log "Stage 2 配置完成。下一步请登录 Claude Code："
  printf '\n  sudo -u %s -H claude auth login\n\n' "${CLAUDE_RUN_USER}"
  log "登录后运行验证："
  printf '\n  sudo -u %s -H bash %s/scripts/verify_stage2.sh\n\n' "${CLAUDE_RUN_USER}" "${PROJECT_DIR}"
}

main() {
  require_root
  load_env
  install_claude_code
  install_config
  print_next_steps
}

main "$@"
