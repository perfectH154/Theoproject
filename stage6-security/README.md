# Stage 6：Cloudflare Tunnel + 安全准备

本包只做 VPS 侧准备：

- 安装 `cloudflared`
- 开启 `ufw`，入站只允许 `22/tcp`
- 安装每日 `/var/lib/companion/companion.db` 备份，保留 30 天
- 安装状态检查脚本

Tunnel token 必须由 Cloudflare 后台生成，不能写进包里。

## VPS 一键命令

```bash
cd /opt/companion/stage6-security
sudo bash scripts/stage6_prepare.sh
```

## Cloudflare 后台步骤

1. 进入 Cloudflare Zero Trust。
2. Networks → Tunnels → Create a tunnel。
3. 选择 Cloudflared。
4. Tunnel name 填 `theo-vps`。
5. 选择 Debian/Ubuntu，复制后台给出的 `sudo cloudflared service install <TOKEN>`，在 VPS 执行。
6. Public Hostname:
   - Subdomain: `theo`
   - Domain: `cecilexiejiuyuan.xyz`
   - Type: `HTTP`
   - URL: `http://localhost:3000`
7. 保存。

## Access 后台步骤

1. Zero Trust → Access → Applications → Add an application。
2. 选择 Self-hosted。
3. Application name: `Theo`
4. Application domain: `theo.cecilexiejiuyuan.xyz`
5. Policy:
   - Action: Allow
   - Include: Emails
   - 填你的 Google 邮箱
6. Session duration: `30 days`
7. 保存。

之后 Stage 7 需要给 `/api/dream/events` 单独 bypass。现在 Stage 6 先不加，因为 push-agent 还没上线。

## 验证

```bash
sudo /usr/local/sbin/companion-stage6-check.sh
curl -I https://theo.cecilexiejiuyuan.xyz/healthz
```

浏览器访问 `https://theo.cecilexiejiuyuan.xyz` 应该跳 Cloudflare Access 登录。
