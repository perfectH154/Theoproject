# Stage 3：Bridge 服务

本阶段交付 Node.js Bridge：只监听 `127.0.0.1:3000`，通过 WebSocket 接 PWA，通过 `node-pty` 管理 Claude Code 调用，并提前建立 Stage 7 会复用的 SQLite 三张表。

## 设计权衡

选择：Bridge 内部保持一个常驻 PTY worker，但每轮用户消息由 worker 串行执行 `claude -p --output-format stream-json`。

原因：

- Claude Code 的 `stream-json` 输出最适合可靠拆出 `text` / `thinking` / `tool_use`。
- 纯交互式 Claude Code 更像终端 UI，不保证每段输出都是 JSONL，前端难以稳定渲染。
- 常驻 PTY worker 仍满足进程管理、崩溃重启、行缓冲和串行会话控制；后续 Stage 5 前端会收到稳定事件流。

浏览器原生 WebSocket 不能设置 `Authorization` header，所以 Bridge 同时支持：

- 标准方式：`Authorization: Bearer <token>`
- 浏览器方式：`ws://127.0.0.1:3000/ws?token=<token>&session_id=default`

## 目录结构

```text
stage3-bridge/
  README.md
  package.json
  .env.example
  src/
    config.js
    db.js
    logger.js
    security.js
    server.js
    websocket.js
    routes/
      api.js
    services/
      claudeParser.js
      claudePty.js
      media.js
      stt.js
    utils/
      fs.js
      json.js
  scripts/
    claude_turn.sh
    generate_token.js
    install_stage3_bridge.sh
  systemd/
    companion-bridge.service
```

## 关键文件清单

- `src/server.js`：Express + HTTP server + WebSocket upgrade 入口。
- `src/websocket.js`：`/ws` 协议、历史下发、消息入库、Claude 输出转发。
- `src/services/claudePty.js`：常驻 PTY worker、Claude Code 单轮执行、JSONL 行解析。
- `src/services/claudeParser.js`：把 Claude Code stream-json 拆成 `text` / `thinking` / `tool_use` / `status`。
- `src/db.js`：SQLite 初始化和消息读写，包含 `messages`、`push_subscriptions`、`dream_events`。
- `src/security.js`：Bearer token / query token 鉴权、单 IP 限流、失败 ban。
- `src/services/media.js`：图片 base64 白名单校验和保存，音频保存。
- `src/services/stt.js`：`openai` / `whispercpp` 两种 STT 入口，默认关闭。
- `systemd/companion-bridge.service`：Stage 3 服务单元，root 运行以复用 Stage 2 Claude Code 登录态。

## VPS 部署步骤

把 `stage3-bridge` 上传到 VPS，例如 `/opt/companion/stage3-bridge`。

```bash
cd /opt/companion/stage3-bridge
sudo bash scripts/install_stage3_bridge.sh
```

安装脚本会：

- 生成 `/etc/companion/bridge.env`
- 自动生成 `BRIDGE_TOKEN`
- 复制项目到 `/opt/companion/bridge`
- 执行 `npm install --omit=dev`
- 安装并启动 `companion-bridge.service`

如果你想手动配置：

```bash
sudo install -d -m 0755 /etc/companion
sudo install -m 0640 .env.example /etc/companion/bridge.env
node scripts/generate_token.js
sudo nano /etc/companion/bridge.env
```

确认这些字段：

```bash
HOST=127.0.0.1
PORT=3000
BRIDGE_TOKEN=<32-byte-random-token>
CLAUDE_WORKDIR=/opt/companion/claude
CLAUDE_TURN_SCRIPT=/opt/companion/bridge/scripts/claude_turn.sh
CLAUDE_MCP_CONFIG=/opt/companion/claude/.mcp.json
DB_PATH=/var/lib/companion/companion.db
```

## WebSocket 协议

上行：

```json
{"type":"text","content":"你好 Theo","meta":{"session_id":"default","tts":false}}
```

图片：

```json
{"type":"image","content":"data:image/png;base64,...","meta":{"session_id":"default","caption":"看看这个"}}
```

音频：

```json
{"type":"audio","content":"data:audio/webm;base64,...","meta":{"session_id":"default","mime":"audio/webm"}}
```

下行：

```json
{"type":"text","content":"...","meta":{"session_id":"default"}}
{"type":"thinking","content":"...","meta":{"session_id":"default"}}
{"type":"tool_use","content":"hold","meta":{"session_id":"default","name":"hold","input":{}}}
{"type":"status","content":"history","meta":{"messages":[]}}
```

## SQLite schema

服务启动自动创建：

```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source TEXT DEFAULT 'chat',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  ts INTEGER NOT NULL,
  meta TEXT,
  keepalive_consumed INTEGER DEFAULT 0
);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_fail_at INTEGER,
  fail_count INTEGER DEFAULT 0
);

CREATE TABLE dream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  value TEXT,
  created_at INTEGER NOT NULL,
  state TEXT
);
```

## 验证命令

服务状态：

```bash
systemctl status companion-bridge.service --no-pager --full
journalctl -u companion-bridge.service -f
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

鉴权接口：

```bash
TOKEN="$(grep '^BRIDGE_TOKEN=' /etc/companion/bridge.env | cut -d= -f2-)"
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/status
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:3000/api/history?session_id=default"
```

WebSocket 文本消息：

```bash
npm install -g wscat
TOKEN="$(grep '^BRIDGE_TOKEN=' /etc/companion/bridge.env | cut -d= -f2-)"
wscat -c "ws://127.0.0.1:3000/ws?token=$TOKEN&session_id=default"
```

连接后发送：

```json
{"type":"text","content":"你好 Theo，简单回我一句。","meta":{"session_id":"default"}}
```

数据库检查：

```bash
sqlite3 /var/lib/companion/companion.db '.tables'
sqlite3 /var/lib/companion/companion.db 'select id, session_id, source, role, substr(content,1,60), ts from messages order by id desc limit 5;'
```

监听地址检查：

```bash
ss -ltnp | grep 3000
```

应该只看到 `127.0.0.1:3000`，不应该监听 `0.0.0.0:3000`。

## Stage 4：TTS 验证

配置 ElevenLabs：

```bash
sudo nano /etc/companion/bridge.env
```

加入或修改：

```bash
TTS_MODE=on_demand
ELEVENLABS_API_KEY=<你的 ElevenLabs key>
VOICE_ID=<你的 voice_id>
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
PUBLIC_BASE_URL=
```

重启：

```bash
sudo systemctl restart companion-bridge.service
```

WebSocket 里发送：

```json
{"type":"text","content":"Theo，用一句话回我，并且生成语音。","meta":{"session_id":"default","tts":true}}
```

预期下行会多一条：

```json
{"type":"audio","content":"/audio/<hash>.mp3?token=<token>","meta":{"provider":"elevenlabs","cached":false}}
```

复制 `content` 里的路径测试：

```bash
TOKEN="$(grep '^BRIDGE_TOKEN=' /etc/companion/bridge.env | cut -d= -f2-)"
curl -L "http://127.0.0.1:3000/audio/<hash>.mp3?token=$TOKEN" -o /tmp/theo.mp3
ls -lh /tmp/theo.mp3
```

同一段文本第二次合成应返回 `"cached":true`，不会重复扣 ElevenLabs 额度。

## Stage 7：push-agent 验证

配置：

```bash
sudo nano /etc/companion/bridge.env
```

至少填写：

```bash
OPENROUTER_API_KEY=<你的 OpenRouter key>
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
PUSH_MODEL=anthropic/claude-haiku-4.5
PUSH_ENABLED=true
PUSH_TIMES=07:30,12:30,15:00,19:00,22:30
PUSH_TIMEZONE=Asia/Shanghai
VAPID_SUBJECT=mailto:<你的邮箱>
```

安装脚本会自动生成缺失的：

```bash
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
DREAM_EVENTS_TOKEN
```

重启：

```bash
sudo systemctl restart companion-bridge.service
```

iPhone：

1. 打开 `https://theo.cecilexiejiuyuan.xyz/chat/`
2. 分享 → 添加到主屏幕
3. 从主屏幕图标打开
4. 设置 → 开通推送

手动触发一条 push：

```bash
TOKEN="$(grep '^BRIDGE_TOKEN=' /etc/companion/bridge.env | cut -d= -f2-)"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"manual-test"}' \
  https://theo.cecilexiejiuyuan.xyz/api/push/trigger
```

iOS 快捷指令活动上报：

```bash
DREAM="$(grep '^DREAM_EVENTS_TOKEN=' /etc/companion/bridge.env | cut -d= -f2-)"
curl "https://theo.cecilexiejiuyuan.xyz/api/dream/events?type=test&value=hello&token=$DREAM"
```

查看主动消息是否写入：

```bash
sqlite3 /var/lib/companion/companion.db \
  "select id,source,role,substr(content,1,80) from messages order by id desc limit 10;"
```
