const { WebSocketServer } = require('ws');
const config = require('./config');
const logger = require('./logger');
const { authenticateRequest, checkRateLimit, getClientIp } = require('./security');
const {
  insertMessage,
  getRecentMessages,
  normalizeConversationId,
  getConversationClaudeSessionId,
  upsertConversationClaudeSessionId
} = require('./db');
const { saveImageBase64, saveAudioBase64 } = require('./services/media');
const { transcribeAudio } = require('./services/stt');
const { shouldSynthesize, synthesizeSpeech } = require('./services/tts');
const { notifyMessage } = require('./push-agent/notifier');

function send(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

// 判断指定会话当前是否还有“活着”的 WebSocket 客户端在监听。
// 移动端 PWA 被挂起/关闭后，socket 可能短时间仍显示 OPEN，但不会再回应心跳 pong，
// 因此这里同时检查 readyState 与心跳维护的 isAlive 标记。
function hasLiveClientForSession(wss, sessionId) {
  if (!wss) return false;
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.isAlive !== false && client.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}

function sanitizeText(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('消息不能为空');
  if (value.length > config.limits.maxTextChars) {
    throw new Error(`消息超过 ${config.limits.maxTextChars} 字符上限`);
  }
  return value;
}

function sanitizeModel(model) {
  const value = String(model || '').trim();
  if (!value) return '';
  if (!/^[A-Za-z0-9._:/@-]{1,120}$/.test(value)) {
    throw new Error('模型名称包含不允许的字符');
  }
  return value;
}

function buildPrompt({ type, content, meta, media }) {
  const sessionId = meta.session_id || meta.sessionId || 'default';
  const conversationId = meta.conversation_id || meta.conversationId || 'default';
  const header = [
    `[Bridge 会话: ${sessionId}]`,
    `[Conversation: ${conversationId}]`,
    '请正常回复用户。只有用户明确要求记忆、查询记忆、归档或管理记忆时，才使用 Ombre Brain 工具。'
  ];

  if (type === 'image') {
    header.push(`用户上传了一张图片，服务器路径：${media.path}，MIME：${media.mime}。`);
    if (meta.caption) header.push(`用户附言：${sanitizeText(meta.caption)}`);
    return header.join('\n');
  }

  if (type === 'audio') {
    header.push(`用户上传了一段语音，转写文本如下：${content}`);
    return header.join('\n');
  }

  return `${header.join('\n')}\n\n用户：${content}`;
}

function createWebSocketServer(server, claudeManager) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== config.wsPath) {
      socket.destroy();
      return;
    }

    const auth = authenticateRequest(req);
    if (!auth.ok) {
      socket.write(`HTTP/1.1 ${auth.status} Unauthorized\r\n\r\n`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.clientIp = auth.ip;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = url.searchParams.get('session_id') || 'default';
    const conversationId = normalizeConversationId(url.searchParams.get('conversation_id') || 'default');
    ws.sessionId = sessionId;
    ws.conversationId = conversationId;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    logger.info('WebSocket connected', { ip: ws.clientIp, sessionId, conversationId });
    send(ws, { type: 'status', content: 'connected', meta: { session_id: sessionId, conversation_id: conversationId, claude: claudeManager.status() } });
    send(ws, { type: 'status', content: 'history', meta: { conversation_id: conversationId, messages: getRecentMessages(sessionId, 50, conversationId) } });

    ws.on('message', async (raw) => {
      const limit = checkRateLimit(ws.clientIp || getClientIp(req));
      if (!limit.ok) {
        send(ws, { type: 'status', content: limit.reason, meta: {} });
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());
        await handleClientMessage(ws, msg, claudeManager, wss);
      } catch (error) {
        send(ws, { type: 'status', content: 'error', meta: { message: error.message } });
      }
    });

    ws.on('close', () => logger.info('WebSocket closed', { ip: ws.clientIp, sessionId, conversationId }));
  });

  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

async function handleClientMessage(ws, msg, claudeManager, wss) {
  const type = msg.type;
  const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
  const sessionId = meta.session_id || meta.sessionId || ws.sessionId || 'default';
  const conversationId = normalizeConversationId(meta.conversation_id || meta.conversationId || ws.conversationId || 'default');
  const requestedModel = sanitizeModel(meta.model);
  let content = msg.content;
  let media = null;

  if (type === 'ping' || type === 'heartbeat') {
    send(ws, {
      type: 'status',
      content: 'pong',
      meta: {
        session_id: sessionId,
        conversation_id: conversationId,
        ts: Date.now()
      }
    });
    return;
  }

  if (!['text', 'image', 'audio'].includes(type)) {
    throw new Error('未知消息类型');
  }

  if (type === 'text') {
    content = sanitizeText(content);
  } else if (type === 'image') {
    media = saveImageBase64(String(content || ''));
    content = meta.caption ? sanitizeText(meta.caption) : `[图片] ${media.path}`;
  } else if (type === 'audio') {
    media = saveAudioBase64(String(content || ''), meta);
    content = sanitizeText(await transcribeAudio(media.path));
  }

  insertMessage({
    sessionId,
    conversationId,
    source: 'chat',
    role: 'user',
    content,
    meta: { type, media }
  });
  send(ws, { type: 'status', content: 'user_message_saved', meta: { session_id: sessionId, conversation_id: conversationId } });

  const prompt = buildPrompt({ type, content, meta: { ...meta, session_id: sessionId, conversation_id: conversationId }, media });
  const resumeSessionId = getConversationClaudeSessionId(conversationId);
  if (resumeSessionId) {
    logger.info('Claude Code 续会话', { sessionId, conversationId, claudeSessionId: resumeSessionId });
  } else {
    logger.info('Claude Code 新会话', { sessionId, conversationId });
  }

  const result = await claudeManager.runTurn(prompt, { model: requestedModel, resumeSessionId }, {
    onStatus: (event) => send(ws, event),
    onEvent: (event) => send(ws, { ...event, meta: { ...event.meta, session_id: sessionId, conversation_id: conversationId } })
  });

  if (result.claudeSessionId) {
    upsertConversationClaudeSessionId(conversationId, result.claudeSessionId);
    logger.info('Claude Code session_id 已保存', {
      sessionId,
      conversationId,
      claudeSessionId: result.claudeSessionId,
      resumedFrom: result.resumedFrom || null
    });
  }

  const assistantContent = result.text || '[无文本回复]';
  insertMessage({
    sessionId,
    conversationId,
    source: 'chat',
    role: 'assistant',
    content: assistantContent,
    model: requestedModel || 'claude-code',
    meta: {
      thinking: result.thinking,
      tool_use: result.tools,
      raw_event_count: result.raw.length,
      model: requestedModel || null,
      claude_session_id: result.claudeSessionId || null,
      resumed_from: result.resumedFrom || null
    }
  });

  send(ws, {
    type: 'status',
    content: 'assistant_message_saved',
    meta: { session_id: sessionId, conversation_id: conversationId }
  });

  // 关键修复：当本会话已经没有“活着”的 WebSocket 客户端时（例如 PWA 被切到后台/关闭，
  // 或发完消息后锁屏导致连接被挂起），回复无法通过 WS 送达，改用 Web Push 通知，
  // 这样 PWA 关闭状态下也能收到新消息（网页端保持标签页常连，所以一直正常）。
  if (!hasLiveClientForSession(wss, sessionId)) {
    notifyMessage({ text: assistantContent, conversationId }).catch((error) => {
      logger.warn('Web Push 推送新消息失败', { sessionId, conversationId, message: error.message });
    });
  }

  if (shouldSynthesize(meta)) {
    try {
      const audio = await synthesizeSpeech(assistantContent, { token: config.bridgeToken });
      if (audio) {
        send(ws, {
          type: 'audio',
          content: audio.url,
          meta: {
            session_id: sessionId,
            conversation_id: conversationId,
            path: audio.path,
            cached: audio.cached,
            provider: 'elevenlabs'
          }
        });
      }
    } catch (error) {
      send(ws, {
        type: 'status',
        content: 'tts_error',
        meta: { session_id: sessionId, message: error.message }
      });
    }
  }
}

module.exports = { createWebSocketServer };
