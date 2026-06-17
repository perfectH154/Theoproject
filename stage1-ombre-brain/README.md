# Stage 1：部署 Ombre Brain

本阶段只部署和接入官方 Ombre Brain MCP server，不重新实现 MCP server。当前公开搜索没有找到可确认的 Ombre Brain 官方仓库地址，所以这里把官方仓库 URL、安装命令、启动命令做成配置项；拿到官方文档后，把对应值填进 `/etc/companion/ombre-brain.env` 即可。

## 设计权衡

选择：用 systemd 直接守护官方 Ombre Brain 进程，并用独立 smoke test 验证 MCP 工具。

原因：

- Stage 1 的目标是“部署现成 MCP server”，不是引入额外 Node/Python 包装层。
- systemd 负责开机自启、崩溃重启、日志进入 journald，后续 Bridge 只需要知道 HTTP endpoint 或 stdio 启动命令。
- HTTP 和 stdio 两种 MCP transport 都保留，避免提前假设 Ombre Brain 官方实现方式。

## 目录结构

```text
stage1-ombre-brain/
  README.md
  config/
    ombre-brain.env.example
  scripts/
    install_ombre_brain.sh
    verify_ombre_brain.sh
    mcp_http_smoke.py
    mcp_stdio_smoke.py
  systemd/
    ombre-brain.service
```

## 关键文件清单

- `config/ombre-brain.env.example`：集中配置官方仓库、安装命令、启动命令、HTTP/stdio endpoint。
- `systemd/ombre-brain.service`：Ombre Brain 常驻服务，崩溃自动重启。
- `scripts/install_ombre_brain.sh`：创建用户和目录、clone 官方仓库、执行官方安装命令、安装 systemd unit。
- `scripts/verify_ombre_brain.sh`：检查服务状态，并调用 pulse / breath。
- `scripts/mcp_http_smoke.py`：HTTP MCP endpoint 验证工具。
- `scripts/mcp_stdio_smoke.py`：stdio MCP 启动命令验证工具。

## VPS 部署步骤

以下命令假设你已经把 `stage1-ombre-brain` 上传到 VPS，例如 `/opt/companion/stage1-ombre-brain`。

### 1. 准备配置

```bash
sudo install -d -m 0755 /etc/companion
sudo install -m 0640 stage1-ombre-brain/config/ombre-brain.env.example /etc/companion/ombre-brain.env
sudo nano /etc/companion/ombre-brain.env
```

把这些值改成 Ombre Brain 官方文档里的真实值：

```bash
OMBRE_REPO_URL="https://github.com/OFFICIAL/ombre-brain.git"
OMBRE_REPO_REF="main"
OMBRE_INSTALL_CMD="npm ci"
OMBRE_START_CMD="npm start"
OMBRE_TRANSPORT="http"
OMBRE_MCP_HTTP_URL="http://127.0.0.1:8765/mcp"
```

如果官方文档给的是 stdio server，把 transport 改为：

```bash
OMBRE_TRANSPORT="stdio"
OMBRE_STDIO_COMMAND="npm start"
OMBRE_START_CMD="npm start"
```

### 2. 安装并启动

```bash
cd /opt/companion/stage1-ombre-brain
sudo bash scripts/install_ombre_brain.sh
```

### 3. 查看 systemd 状态

```bash
systemctl status ombre-brain.service --no-pager --full
journalctl -u ombre-brain.service -f
```

## 验证命令

### HTTP endpoint

如果 Ombre Brain 以 HTTP MCP endpoint 暴露：

```bash
cd /opt/companion/stage1-ombre-brain
sudo bash scripts/verify_ombre_brain.sh
```

或只跑 smoke test：

```bash
python3 scripts/mcp_http_smoke.py http://127.0.0.1:8765/mcp
```

验证成功时会看到：

- `tools/list` 包含 `pulse` 和 `breath`
- `tools/call pulse` 返回系统状态和记忆桶概览
- `tools/call breath` 返回自动浮现或空结果，但不应报协议错误

### stdio 启动命令

如果 Ombre Brain 只提供 stdio：

```bash
cd /opt/companion/ombre-brain/app
python3 /opt/companion/stage1-ombre-brain/scripts/mcp_stdio_smoke.py "npm start"
```

### MCP Inspector

如果你更想用官方 Inspector 交互验证：

```bash
npx @modelcontextprotocol/inspector
```

然后按 UI 选择：

- HTTP：填入 `/etc/companion/ombre-brain.env` 里的 `OMBRE_MCP_HTTP_URL`
- stdio：填入 `OMBRE_APP_DIR` 和 `OMBRE_STDIO_COMMAND`

在 Inspector 里确认 `pulse`、`breath` 可调用。

## systemd unit 安装结果

安装完成后，服务文件位于：

```text
/etc/systemd/system/ombre-brain.service
```

配置文件位于：

```text
/etc/companion/ombre-brain.env
```

Ombre Brain 数据目录位于：

```text
/var/lib/companion/ombre-brain
```

后续 Stage 2 会把这个 MCP server 注册到 Claude Code 的 MCP 配置里。
