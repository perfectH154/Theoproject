#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 2 验证：
# 1. Claude Code 已安装并登录
# 2. 能看到 ombre-brain MCP server
# 3. 普通对话不触发 Ombre Brain tool_use
# 4. 明确“记一下”触发 hold
# 5. 明确“查一下之前”触发 breath

ENV_FILE="${ENV_FILE:-/etc/companion/claude-code.env}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

log() {
  printf '[claude-verify] %s\n' "$*" >&2
}

fail() {
  printf '[claude-verify] ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f "${ENV_FILE}" ]] || fail "找不到 ${ENV_FILE}"
# shellcheck disable=SC1090
set -a
source "${ENV_FILE}"
set +a

: "${COMPANION_CLAUDE_DIR:=/opt/companion/claude}"
: "${MCP_CONFIG_PATH:=${COMPANION_CLAUDE_DIR}/.mcp.json}"

START_SCRIPT="${COMPANION_CLAUDE_DIR}/start_claude.sh"
[[ -x "${START_SCRIPT}" ]] || START_SCRIPT="${SCRIPT_DIR}/start_claude.sh"

log "检查 Claude Code 版本"
claude --version

log "检查 Claude Code 登录状态"
claude auth status --text

log "列出 MCP server"
(
  cd "${COMPANION_CLAUDE_DIR}"
  claude mcp list
) || true

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

run_case() {
  local name="$1"
  local prompt="$2"
  local out="${TMP_DIR}/${name}.jsonl"

  log "运行用例：${name}"
  bash "${START_SCRIPT}" "${prompt}" > "${out}"
  printf '%s\n' "${out}"
}

ordinary_out="$(run_case ordinary '我们随便聊两句：今天晚饭吃什么比较舒服？请只给三个建议，不要使用任何工具。')"
memory_hold_out="$(run_case hold '记一下：今天她跟我说了，见面时想先去湖边散步。')"
memory_breath_out="$(run_case breath '查一下之前我们聊过的湖边散步相关内容。')"

log "断言普通对话不触发 Ombre Brain 工具"
if grep -E '"name"[[:space:]]*:[[:space:]]*"mcp__ombre-brain__(pulse|breath|hold|grow|trace)"|"name"[[:space:]]*:[[:space:]]*"(pulse|breath|hold|grow|trace)"' "${ordinary_out}" >/dev/null; then
  fail "普通对话触发了 Ombre Brain 工具，请检查 CLAUDE.md 约束。输出文件：${ordinary_out}"
fi

log "断言“记一下”触发 hold"
if ! grep -E '"name"[[:space:]]*:[[:space:]]*"mcp__ombre-brain__hold"|"name"[[:space:]]*:[[:space:]]*"hold"' "${memory_hold_out}" >/dev/null; then
  fail "没有检测到 hold 工具调用。输出文件：${memory_hold_out}"
fi

log "断言“查一下之前”触发 breath"
if ! grep -E '"name"[[:space:]]*:[[:space:]]*"mcp__ombre-brain__breath"|"name"[[:space:]]*:[[:space:]]*"breath"' "${memory_breath_out}" >/dev/null; then
  fail "没有检测到 breath 工具调用。输出文件：${memory_breath_out}"
fi

log "验证完成"
