# Stage 2：Claude Code 配置

本阶段把 Claude Code 配成个人 AI 伴侣系统里的 LLM 宿主，并注册 Stage 1 部署好的 Ombre Brain MCP server。

## 设计权衡

选择：使用用户级 `~/.claude/CLAUDE.md` 放人格与记忆工具约束，使用项目级 `/opt/companion/claude/.mcp.json` 注册 Ombre Brain，并通过 `start_claude.sh` 统一启动。

原因：

- 用户级 `CLAUDE.md` 会覆盖所有 Claude Code 会话，适合长期人格和记忆调用约束。
- 项目级 `.mcp.json` 只绑定 companion 运行目录，避免影响服务器上其他 Claude Code 项目。
- `start_claude.sh` 后续可直接给 Stage 3 Bridge 的 `node-pty` 启动，保持 stdin/stdout 可控。
- 验证脚本使用 `claude -p --output-format stream-json --verbose`，可以检查 tool_use 事件，而不是靠肉眼猜。

## 目录结构

```text
stage2-claude-code/
  README.md
  config/
    CLAUDE.md
    claude-code.env.example
    mcp.http.json.example
    mcp.http.with-header.json.example
    mcp.stdio.json.example
  scripts/
    install_stage2_claude_code.sh
    start_claude.sh
    verify_stage2.sh
```

## 关键文件清单

- `config/CLAUDE.md`：人格系统提示，明确“只有用户明确要求时才调用 Ombre Brain”。
- `config/claude-code.env.example`：集中配置 Claude Code、MCP、Ombre Brain endpoint。
- `config/mcp.http.json.example`：HTTP MCP 注册模板。
- `config/mcp.stdio.json.example`：stdio MCP 注册模板。
- `scripts/install_stage2_claude_code.sh`：安装 Claude Code、复制配置、生成运行目录。
- `scripts/start_claude.sh`：Bridge 后续使用的 Claude Code 启动入口。
- `scripts/verify_stage2.sh`：验证登录、MCP 列表、普通对话不触发工具、明确记忆意图触发工具。

## VPS 执行步骤

把 `stage2-claude-code` 上传到 VPS，例如 `/opt/companion/stage2-claude-code`。

### 1. 准备配置

```bash
sudo install -d -m 0755 /etc/companion
sudo install -m 0640 stage2-claude-code/config/claude-code.env.example /etc/companion/claude-code.env
sudo nano /etc/companion/claude-code.env
```

如果 Stage 1 的 Ombre Brain 是 HTTP MCP endpoint：

```bash
CLAUDE_RUN_USER="root"
CLAUDE_HOME="/root/.claude"
CLAUDE_USER_PROMPT_PATH="/root/.claude/CLAUDE.md"
OMBRE_TRANSPORT="http"
OMBRE_MCP_HTTP_URL="http://127.0.0.1:8765/mcp"
```

如果 Stage 1 是 stdio：

```bash
OMBRE_TRANSPORT="stdio"
OMBRE_APP_DIR="/opt/companion/ombre-brain/app"
OMBRE_STDIO_COMMAND="npm"
OMBRE_STDIO_ARGS="start"
```

### 2. 安装 Claude Code 和配置

```bash
cd /opt/companion/stage2-claude-code
sudo bash scripts/install_stage2_claude_code.sh
```

### 3. 登录 Claude Code

```bash
sudo -u root -H claude auth login
```

如果 VPS 无浏览器，按 Claude Code 提示复制登录链接到本地浏览器完成登录。

注意：后续 Stage 3 的 Bridge 必须用同一个 `CLAUDE_RUN_USER` 启动 Claude Code，否则会读不到这里的登录态。

### 4. 手动检查 MCP

```bash
cd /opt/companion/claude
claude mcp list
claude
```

进入 Claude Code 后运行：

```text
/mcp
```

确认能看到 `ombre-brain`，且工具列表包含 `pulse`、`breath`、`hold`、`grow`、`trace`。

## 验证命令

```bash
cd /opt/companion/stage2-claude-code
sudo -u root -H bash scripts/verify_stage2.sh
```

验证目标：

- `claude --version` 正常。
- `claude auth status --text` 显示已登录。
- `claude mcp list` 能看到 `ombre-brain`。
- 普通对话不会触发 `pulse` / `breath` / `hold` / `grow` / `trace`。
- “记一下……”会触发 `hold`。
- “查一下之前……”会触发 `breath`。

## Bridge 启动入口

Stage 3 Bridge 后续直接启动：

```bash
/opt/companion/claude/start_claude.sh
```

这个命令会进入交互式 Claude Code，适合 `node-pty` 常驻进程管理。

单轮 smoke test 可以传入 prompt：

```bash
/opt/companion/claude/start_claude.sh "普通聊天，不要使用工具：今天适合听什么音乐？"
```

它会输出 `stream-json`，方便 Bridge 或验证脚本解析 thinking / tool_use / text。

## 官方文档依据

- Claude Code 支持用户级 `~/.claude/CLAUDE.md` 和项目级 `./CLAUDE.md`，并会在会话开始时加载。
- Claude Code 支持通过 `.mcp.json`、`~/.claude.json` 或 `claude mcp add-json` 配置 MCP server。
- HTTP MCP server 可用 `type: "http"`；stdio MCP server 可用 `command` / `args`。
- `claude -p --output-format stream-json --verbose` 可用于脚本化验证输出流。
