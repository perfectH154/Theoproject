TOKEN="$(sed -n 's/^BRIDGE_TOKEN=//p' /etc/companion/bridge-v2.env)"
timeout 150 curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"conv_08321d00d5d432fd","content":"\u6d4b\u8bd5\u901a\u9053\uff1a\u8bf7\u53ea\u56de\u590d\u4e00\u53e5\uff1a\u901a\u9053\u5df2\u6062\u590d\u3002"}' \
  http://127.0.0.1:3001/api/debug/turn
printf '\n'
