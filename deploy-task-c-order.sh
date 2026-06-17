set -euo pipefail
stamp="$(date +%Y%m%d-%H%M%S)"
cp /opt/companion/bridge-v2/src/services/claudePty.js "/opt/companion/bridge-v2/src/services/claudePty.js.backup.task-c-order.$stamp"
cp /tmp/claudePty.task-c2.js /opt/companion/bridge-v2/src/services/claudePty.js
cd /opt/companion/bridge-v2
npm run check
systemctl restart companion-bridge-v2.service
sleep 1
systemctl is-active companion-bridge-v2.service
curl -fsS http://127.0.0.1:3001/healthz
printf '\n[task-c] order hotfix deployed\n'
