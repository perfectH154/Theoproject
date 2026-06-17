set -euo pipefail
stamp="$(date +%Y%m%d-%H%M%S)"
echo "[deploy] backup $stamp"
cp /opt/companion/bridge-v2/src/websocket.js "/opt/companion/bridge-v2/src/websocket.js.backup.$stamp"
cp /opt/companion/bridge-v2/src/services/claudePty.js "/opt/companion/bridge-v2/src/services/claudePty.js.backup.$stamp"
tar -C /opt/companion -czf "/opt/companion/frontend.backup.ws-stability.$stamp.tar.gz" frontend
cp /tmp/websocket.js /opt/companion/bridge-v2/src/websocket.js
cp /tmp/claudePty.js /opt/companion/bridge-v2/src/services/claudePty.js
cd /opt/companion/bridge-v2
npm run check
rm -rf /opt/companion/frontend/*
unzip -q /tmp/frontend-ws-stability.zip -d /opt/companion/frontend
systemctl restart companion-bridge-v2.service
sleep 1
systemctl is-active companion-bridge-v2.service
curl -fsS http://127.0.0.1:3001/healthz
printf '\n[deploy] done\n'
