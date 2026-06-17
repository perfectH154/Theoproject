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
const { saveImageBase64, saveAudioBase64, buildAttachmentPrompt } = require('./services/media');
const { transcribeAudio } = require('./services/stt');
const { shouldSynthesize, synthesizeSpeech } = require('./services/tts');
const { partsFromTurnResult } = require('./services/messageParts');

const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

function send(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
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

function buildPrompt({ type, content, meta, media, attachmentPrompt = '' }) {
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
    if (attachmentPrompt) header.push(`附件内容：\n${attachmentPrompt}`);
    return header.join('\n');
  }

  if (type === 'audio') {
    header.push(`用户上传了一段语音，转写文本如下：${content}`);
    if (attachmentPrompt) header.push(`附件内容：\n${attachmentPrompt}`);
    return header.join('\n');
  }

  if (attachmentPrompt) header.push(`附件内容：\n${attachmentPrompt}`);
  return `${header.join('\n')}\n\n用户：${content}`;
}

function createWebSocketServer(server, claudeManager) {
  const wss = new WebSocketServer({ noServer: true });
  const activeSockets = new Map();
  let socketSeq = 0;

  const socketKeyFor = (sessionId, conversationId) => `${sessionId}:${conversationId}`;
  const activeSocketCount = () => activeSockets.size;
  const sendToActive = (sessionId, conversationId, payload) => {
    const normalized = String(conversationId || 'default').trim() || 'default';
    const socketKey = socketKeyFor(sessionId || 'default', normalized);
    const active = activeSockets.get(socketKey);
    if (active && active.readyState === 1) {
      send(active, payload);
      return true;
    }
    logger.warn('WebSocket active socket not found for outbound event', {
      sessionId,
      conversationId: normalized,
      type: payload?.type,
      content: payload?.content,
      activeSocketCount: activeSocketCount()
    });
    return false;
  };

  if (typeof claudeManager.setConversationActiveChecker === 'function') {
    claudeManager.setConversationActiveChecker((conversationId) => {
      const normalized = normalizeConversationId(conversationId || 'default');
      for (const ws of activeSockets.values()) {
        if (ws.conversationId === normalized && ws.readyState === 1) return true;
      }
      return false;
    });
  }

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
    const socketKey = socketKeyFor(sessionId, conversationId);
    const socketId = `${Date.now().toString(36)}-${++socketSeq}`;
    const oldSocket = activeSockets.get(socketKey);
    if (oldSocket && oldSocket !== ws && (oldSocket.readyState === 0 || oldSocket.readyState === 1)) {
      logger.info('WebSocket replacing active socket', {
        ip: ws.clientIp,
        sessionId,
        conversationId,
        oldSocketId: oldSocket.socketId,
        socketId,
        activeSocketCount: activeSocketCount()
      });
      oldSocket.close(4002, 'replaced by newer connection');
    }

    ws.sessionId = sessionId;
    ws.conversationId = conversationId;
    ws.socketKey = socketKey;
    ws.socketId = socketId;
    ws.isAlive = true;
    ws.lastPongAt = Date.now();
    activeSockets.set(socketKey, ws);
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
    });

    logger.info('WebSocket connected', {
      ip: ws.clientIp,
      sessionId,
      conversationId,
      socketId,
      activeSocketCount: activeSocketCount()
    });
    send(ws, { type: 'status', content: 'connected', meta: { session_id: sessionId, conversation_id: conversationId, claude: claudeManager.status() } });
    send(ws, { type: 'status', content: 'history', meta: { conversation_id: conversationId, messages: getRecentMessages(sessionId, 50, conversationId) } });

    ws.on('message', async (raw) => {
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
      const limit = checkRateLimit(ws.clientIp || getClientIp(req));
      if (!limit.ok) {
        send(ws, { type: 'status', content: limit.reason, meta: {} });
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());
        await handleClientMessage(ws, msg, claudeManager, { sendToActive });
      } catch (error) {
        send(ws, { type: 'status', content: 'error', meta: { message: error.message } });
      }
    });

    ws.on('close', (code, reasonBuffer) => {
      if (activeSockets.get(socketKey) === ws) {
        activeSockets.delete(socketKey);
      }
      logger.info('WebSocket closed', {
        ip: ws.clientIp,
        sessionId,
        conversationId,
        socketId,
        code,
        reason: reasonBuffer ? reasonBuffer.toString() : '',
        activeSocketCount: activeSocketCount()
      });
    });
  });

  const interval = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - (ws.lastPongAt || 0) > HEARTBEAT_TIMEOUT_MS) {
        logger.warn('WebSocket heartbeat timeout', {
          ip: ws.clientIp,
          sessionId: ws.sessionId,
          conversationId: ws.conversationId,
          socketId: ws.socketId,
          lastPongAt: ws.lastPongAt,
          activeSocketCount: activeSocketCount()
        });
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(interval));

  return wss;
}

async function handleClientMessage(ws, msg, claudeManager, helpers = {}) {
  const type = msg.type;
  const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
  const sessionId = meta.session_id || meta.sessionId || ws.sessionId || 'default';
  const conversationId = normalizeConversationId(meta.conversation_id || meta.conversationId || ws.conversationId || 'default');
  const sendCurrent = (payload) => {
    if (helpers.sendToActive?.(sessionId, conversationId, payload)) return;
    send(ws, payload);
  };
  const requestedModel = sanitizeModel(meta.model);
  const requestedAttachments = Array.isArray(meta.attachments) ? meta.attachments : [];
  let attachmentContext = { attachments: [], prompt: '' };
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

  if (requestedAttachments.length) {
    attachmentContext = await buildAttachmentPrompt(requestedAttachments);
  }

  if (type === 'text') {
    if (!String(content || '').trim() && attachmentContext.attachments.length) {
      content = '[附件]';
    }
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
    meta: { type, media, attachments: attachmentContext.attachments },
    attachments: attachmentContext.attachments
  });
  sendCurrent({ type: 'status', content: 'user_message_saved', meta: { session_id: sessionId, conversation_id: conversationId } });

  const prompt = buildPrompt({
    type,
    content,
    meta: { ...meta, session_id: sessionId, conversation_id: conversationId },
    media,
    attachmentPrompt: attachmentContext.prompt
  });
  const resumeSessionId = getConversationClaudeSessionId(conversationId);
  if (resumeSessionId) {
    logger.info('Claude Code 续会话', { sessionId, conversationId, claudeSessionId: resumeSessionId });
  } else {
    logger.info('Claude Code 新会话', { sessionId, conversationId });
  }

  const result = await claudeManager.runTurn(prompt, { model: requestedModel, resumeSessionId, conversationId, sessionId }, {
    onStatus: (event) => sendCurrent(event),
    onEvent: (event) => sendCurrent({ ...event, meta: { ...event.meta, session_id: sessionId, conversation_id: conversationId } })
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
      parts: partsFromTurnResult(result),
      thinking: Array.isArray(result.thinking) ? result.thinking : [],
      tool_use: result.tools,
      raw_event_count: result.raw.length,
      model: requestedModel || null,
      claude_session_id: result.claudeSessionId || null,
      resumed_from: result.resumedFrom || null
    }
  });

  sendCurrent({
    type: 'status',
    content: 'assistant_message_saved',
    meta: { session_id: sessionId, conversation_id: conversationId }
  });

  if (shouldSynthesize(meta)) {
    try {
      const audio = await synthesizeSpeech(assistantContent, { token: config.bridgeToken });
      if (audio) {
        sendCurrent({
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
      sendCurrent({
        type: 'status',
        content: 'tts_error',
        meta: { session_id: sessionId, message: error.message }
      });
    }
  }
}

module.exports = { createWebSocketServer };
