# Stage 5：Théo PWA 前端

React + Vite PWA，路径固定为 `/chat/`，适配 Cloudflare Tunnel 指向 Bridge 的方案。

## 目录结构

```text
stage5-pwa/
  index.html
  package.json
  vite.config.js
  public/
    manifest.webmanifest
    sw.js
  src/
    main.jsx
    styles.css
    lib/
      api.js
      storage.js
  scripts/
    install_stage5_pwa.sh
```

## 安装

```bash
cd /opt/companion/stage5-pwa
sudo bash scripts/install_stage5_pwa.sh
```

## 验证

浏览器打开：

```text
https://theo.cecilexiejiuyuan.xyz/chat/
```

首次进入输入：

- Server: `https://theo.cecilexiejiuyuan.xyz`
- Token: `/etc/companion/bridge.env` 里的 `BRIDGE_TOKEN`

发送一条消息，如果 Bridge 与 Claude Code 当前没限流，会看到 assistant 气泡；如果限流，dash 里能看到状态。

## iOS PWA 注意

- Service Worker scope 是 `/chat/`。
- iOS 推送权限必须从主屏幕 PWA 内点击“开通推送”按钮触发。
- Stage 7 才会启用真正的 VAPID 订阅接口；现在按钮只做权限请求占位。
- Stage 7 已启用时，必须从主屏幕 PWA 打开，再点击“开通推送”。

## 背景图

设置页支持上传背景图，图片会保存在当前浏览器的 localStorage，不上传服务器。换设备需要重新上传。

## Read

Read tab 支持导入 `.txt` / `.md` / `.epub`：

- txt/md：直接长文阅读。
- epub：用 epub.js 在浏览器内分页渲染，当前是基础阅读器，后续可加高亮、标注、和 AI 讨论。

## Ombre Brain

Memory tab 通过 Bridge 中转 Ombre Brain HTTP MCP。需要在 VPS 配：

```bash
sudo nano /etc/companion/bridge.env
```

加入：

```bash
OMBRE_MCP_HTTP_URL=https://你的-ombre-mcp-url
```

如果有鉴权：

```bash
OMBRE_MCP_AUTH_HEADER_NAME=Authorization
OMBRE_MCP_AUTH_HEADER_VALUE=Bearer xxx
```

然后：

```bash
sudo systemctl restart companion-bridge.service
```
