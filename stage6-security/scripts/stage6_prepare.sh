#!/usr/bin/env bash
set -Eeuo pipefail

# Stage 6 基础准备：
# - 安装 cloudflared
# - ufw 只允许 SSH 入站
# - 安装 companion.db 每日备份
# - 确认 Bridge 只监听 127.0.0.1:3000
#
# Cloudflare Tunnel 本身需要你在 Zero Trust 后台生成 tunnel token，
# 生成后运行：sudo cloudflared service install <TOKEN>

log() {
  printf '[stage6] %s\n' "$*"
}

fail() {
  printf '[stage6] ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "请用 root 运行：sudo bash scripts/stage6_prepare.sh"
fi

log "安装基础工具"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gpg ufw sqlite3 tar

if ! command -v cloudflared >/dev/null 2>&1; then
  log "安装 cloudflared 官方 apt 源"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y cloudflared
else
  log "cloudflared 已安装：$(cloudflared --version)"
fi

log "配置 ufw：默认拒绝入站，只允许 SSH"
ufw allow 22/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable

log "创建备份目录"
install -d -m 0750 /var/backups/companion

log "安装每日数据库备份脚本"
cat >/usr/local/sbin/companion-backup.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

DB="/var/lib/companion/companion.db"
DEST="/var/backups/companion"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$DEST"
if [[ ! -f "$DB" ]]; then
  echo "companion.db not found: $DB" >&2
  exit 0
fi

sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
tar -C /var/lib/companion -czf "$DEST/companion-db-$STAMP.tar.gz" companion.db companion.db-wal companion.db-shm 2>/dev/null || \
  tar -C /var/lib/companion -czf "$DEST/companion-db-$STAMP.tar.gz" companion.db

find "$DEST" -type f -name 'companion-db-*.tar.gz' -mtime +30 -delete
EOF
chmod 0750 /usr/local/sbin/companion-backup.sh

cat >/etc/cron.d/companion-backup <<'EOF'
17 3 * * * root /usr/local/sbin/companion-backup.sh >/var/log/companion-backup.log 2>&1
EOF

log "安装 Stage 6 状态检查脚本"
cat >/usr/local/sbin/companion-stage6-check.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

echo "== bridge =="
systemctl is-active companion-bridge.service || true
curl -fsS http://127.0.0.1:3000/healthz || true
echo

echo "== listen 3000 =="
ss -ltnp | grep ':3000' || true
echo

echo "== ufw =="
ufw status verbose || true
echo

echo "== cloudflared =="
cloudflared --version || true
systemctl is-active cloudflared || true
systemctl status cloudflared --no-pager --full || true
EOF
chmod 0750 /usr/local/sbin/companion-stage6-check.sh

log "立即跑一次备份"
/usr/local/sbin/companion-backup.sh || true

log "检查 Bridge 监听地址"
if ss -ltnp | grep -q '0\.0\.0\.0:3000'; then
  fail "Bridge 正在监听 0.0.0.0:3000，请先把 HOST 改回 127.0.0.1"
fi

log "Stage 6 基础准备完成"
printf '\n下一步：去 Cloudflare Zero Trust 创建 Tunnel，然后在本 VPS 运行后台给出的：\n\n'
printf '  sudo cloudflared service install <TOKEN>\n\n'
printf '最后运行：\n\n'
printf '  sudo /usr/local/sbin/companion-stage6-check.sh\n\n'
