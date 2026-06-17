set -euo pipefail
stamp="$(date +%Y%m%d-%H%M%S)"
echo "[task-c] backup $stamp"
cp /opt/companion/bridge-v2/src/services/claudePty.js "/opt/companion/bridge-v2/src/services/claudePty.js.backup.task-c.$stamp"
tar -C /opt/companion -czf "/opt/companion/frontend.backup.task-c.$stamp.tar.gz" frontend
cp /tmp/claudePty.task-c.js /opt/companion/bridge-v2/src/services/claudePty.js
cd /opt/companion/bridge-v2
npm run check
rm -rf /opt/companion/frontend/*
tar -C /opt/companion/frontend -xzf /tmp/frontend-task-c-thinking.tar.gz
systemctl restart companion-bridge-v2.service
sleep 1
systemctl is-active companion-bridge-v2.service
curl -fsS http://127.0.0.1:3001/healthz
printf '\n[task-c] deployed\n'
