set -euo pipefail
stamp="$(date +%Y%m%d-%H%M%S)"
# ????????? frontend????????????????????? dist?
tar -C /opt/companion -czf "/opt/companion/frontend.backup.ws-stability-retry.$stamp.tar.gz" frontend || true
rm -rf /opt/companion/frontend/*
tar -C /opt/companion/frontend -xzf /tmp/frontend-ws-stability.tar.gz
cd /opt/companion/bridge-v2
npm run check
systemctl restart companion-bridge-v2.service
sleep 1
systemctl is-active companion-bridge-v2.service
curl -fsS http://127.0.0.1:3001/healthz
printf '\n[deploy] retry done\n'
