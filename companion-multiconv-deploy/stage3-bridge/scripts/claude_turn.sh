#!/usr/bin/env bash
set -Eeuo pipefail

# 单轮 Claude Code 调用脚本。
# Bridge 的常驻 PTY worker 会调用它，并解析 stream-json 输出。

PROMPT_FILE="${1:?usage: claude_turn.sh <prompt-file>}"
: "${CLAUDE_MCP_CONFIG:=/opt/companion/claude/.mcp.json}"
: "${CLAUDE_MODEL:=}"
: "${CLAUDE_RESUME_SESSION_ID:=}"
: "${CLAUDE_VERBOSE:=1}"
: "${CLAUDE_PERMISSION_MODE:=default}"

prompt="$(cat "${PROMPT_FILE}")"

args=(
  -p
  --output-format stream-json
  --mcp-config "${CLAUDE_MCP_CONFIG}"
  --permission-mode "${CLAUDE_PERMISSION_MODE}"
)

if [[ "${CLAUDE_VERBOSE}" == "1" ]]; then
  args+=(--verbose)
fi

if [[ -n "${CLAUDE_MODEL}" ]]; then
  args+=(--model "${CLAUDE_MODEL}")
fi

if [[ -n "${CLAUDE_RESUME_SESSION_ID}" ]]; then
  args+=(--resume "${CLAUDE_RESUME_SESSION_ID}")
fi

exec claude "${args[@]}" "${prompt}"
