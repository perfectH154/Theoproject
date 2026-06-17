set -euo pipefail
TOKEN="$(sed -n 's/^BRIDGE_TOKEN=//p' /etc/companion/bridge-v2.env)"
curl -fsS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"conv_08321d00d5d432fd","reason":"task_c_order_hotfix"}' \
  http://127.0.0.1:3001/api/admin/restart-claude
printf '\n'
