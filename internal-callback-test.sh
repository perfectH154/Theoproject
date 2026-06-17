#!/usr/bin/env bash
set -euo pipefail
TOKEN="$(sed -n 's/^CHANNEL_INTERNAL_TOKEN=//p' /etc/companion/bridge-v2.env)"
echo "token_len=${#TOKEN}"
curl -sS -i -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"conv_08321d00d5d432fd","text":"manual callback test"}' \
  http://127.0.0.1:3001/internal/channel/reply
echo
