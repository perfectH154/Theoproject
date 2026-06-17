#!/usr/bin/env bash
set -euo pipefail

conversation_id="${1:-${CONVERSATION_ID:-default}}"
env_file="${BRIDGE_V2_ENV_FILE:-/etc/companion/bridge-v2.env}"
api="${BRIDGE_V2_RESTART_URL:-http://127.0.0.1:3001/api/admin/restart-claude}"

if [[ -f "$env_file" ]]; then
  # shellcheck disable=SC1090
  set -a
  source "$env_file"
  set +a
fi

if [[ -z "${BRIDGE_TOKEN:-}" ]]; then
  echo "[restart-cc] BRIDGE_TOKEN is empty; cannot call restart endpoint" >&2
  exit 1
fi

curl -fsS --max-time 90 \
  -X POST \
  -H "Authorization: Bearer ${BRIDGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"conversation_id\":\"${conversation_id}\",\"reason\":\"manual_script\"}" \
  "$api"
echo
