#!/usr/bin/env bash
set -Eeuo pipefail

# Bridge 后续会用 node-pty 启动这个脚本。
# 无参数时进入交互式 Claude Code；有参数时进入一次性 print 模式，便于 smoke test。

ENV_FILE="${ENV_FILE:-/etc/companion/claude-code.env}"

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a
fi

: "${COMPANION_CLAUDE_DIR:=/opt/companion/claude}"
: "${MCP_CONFIG_PATH:=${COMPANION_CLAUDE_DIR}/.mcp.json}"
: "${CLAUDE_SESSION_NAME:=companion-claude}"
: "${CLAUDE_VERBOSE:=1}"

cd "${COMPANION_CLAUDE_DIR}"

verbose_args=()
if [[ "${CLAUDE_VERBOSE}" == "1" ]]; then
  verbose_args+=(--verbose)
fi

if [[ $# -gt 0 ]]; then
  # 单轮验证模式：输出 stream-json，方便脚本检查是否发生了 tool_use。
  exec claude \
    -p \
    --output-format stream-json \
    --mcp-config "${MCP_CONFIG_PATH}" \
    "${verbose_args[@]}" \
    "$*"
fi

# 交互模式：stdin/stdout 交给 PTY，Stage 3 的 Bridge 会保持该进程常驻。
exec claude \
  --mcp-config "${MCP_CONFIG_PATH}" \
  --name "${CLAUDE_SESSION_NAME}" \
  --permission-mode default \
  "${verbose_args[@]}"
