#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 1 验证脚本：检查服务存活，并调用 MCP tools/list、pulse、breath。
# HTTP 模式会调用 scripts/mcp_http_smoke.py。
# stdio 模式会调用 scripts/mcp_stdio_smoke.py。

ENV_FILE="${ENV_FILE:-/etc/companion/ombre-brain.env}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

log() {
  printf '[ombre-verify] %s\n' "$*"
}

fail() {
  printf '[ombre-verify] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f "${ENV_FILE}" ]] || fail "找不到 ${ENV_FILE}"
# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

: "${OMBRE_TRANSPORT:=http}"
: "${OMBRE_HEALTH_URL:=}"
: "${OMBRE_MCP_HTTP_URL:=}"
: "${OMBRE_STDIO_COMMAND:=}"
: "${OMBRE_APP_DIR:=/opt/companion/ombre-brain/app}"

if command -v systemctl >/dev/null 2>&1; then
  log "检查 systemd 服务状态"
  systemctl is-active --quiet ombre-brain.service || fail "ombre-brain.service 未处于 active 状态"
fi

if [[ -n "${OMBRE_HEALTH_URL}" ]]; then
  log "检查健康接口：${OMBRE_HEALTH_URL}"
  curl --fail --silent --show-error --max-time 5 "${OMBRE_HEALTH_URL}" >/tmp/ombre-health.out
  cat /tmp/ombre-health.out
  printf '\n'
fi

case "${OMBRE_TRANSPORT}" in
  http)
    [[ -n "${OMBRE_MCP_HTTP_URL}" ]] || fail "HTTP 模式需要 OMBRE_MCP_HTTP_URL"
    log "通过 HTTP MCP endpoint 验证 tools/list、pulse、breath：${OMBRE_MCP_HTTP_URL}"
    python3 "${SCRIPT_DIR}/mcp_http_smoke.py" "${OMBRE_MCP_HTTP_URL}"
    ;;
  stdio)
    [[ -n "${OMBRE_STDIO_COMMAND}" ]] || fail "stdio 模式需要 OMBRE_STDIO_COMMAND"
    log "通过 stdio 验证 tools/list、pulse、breath：${OMBRE_STDIO_COMMAND}"
    cd "${OMBRE_APP_DIR}"
    python3 "${SCRIPT_DIR}/mcp_stdio_smoke.py" "${OMBRE_STDIO_COMMAND}"
    ;;
  *)
    fail "未知 OMBRE_TRANSPORT=${OMBRE_TRANSPORT}，只能是 http 或 stdio"
    ;;
esac

log "验证完成"
