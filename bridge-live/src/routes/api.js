const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const config = require('../config');
const { httpAuth } = require('../security');
const { safeJoin } = require('../utils/fs');
const { callOmbreTool } = require('../services/mcpHttp');
const { approveTool, approvalStatus } = require('../services/mcpApproval');
const { saveUploadedFile, findAttachmentById } = require('../services/media');
const { relationshipMeta, getMorningLine } = require('../services/dash');
const { partsFromTurnResult } = require('../services/messageParts');
const {
  getRecentMessages,
  getPendingKeepalive,
  consumeKeepalive,
  insertDreamEvent,
  upsertPushSubscription,
  getStatus,
  insertMessage,
  normalizeConversationId,
  listConversations,
  createConversation,
  updateConversationTitle,
  deleteConversation,
  getConversationClaudeSessionId,
  upsertConversationClaudeSessionId,
  updateMessageContent,
  deleteMessage,
  getRegenerationSeed,
  softDeleteAfterMessage,
  clearConversationClaudeSessionId,
  getRecentConversation
} = require('../db');

const MODEL_CHOICES = [
  { value: '', label: 'Server default' },
  { value: 'opus', label: 'Claude Opus 4.7 / latest (alias: opus)' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6 (alias: sonnet)' },
  { value: 'haiku', label: 'Claude Haiku 4.5 (alias: haiku)' }
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.maxUploadBytes, files: 1 }
});

function sanitizeModelName(model) {
  const value = String(model || '').trim();
  if (!value) return '';
  if (!/^[A-Za-z0-9._:/@-]{1,120}$/.test(value)) {
    throw new Error('invalid model name');
  }
  return value;
}

function updateEnvValue(filePath, key, value) {
  const line = `${key}=${value}`;
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    content = '';
  }
  const lines = content.split(/\r?\n/);
  let found = false;
  const next = lines.map((item) => {
    if (item.startsWith(`${key}=`)) {
      found = true;
      return line;
    }
    return item;
  });
  if (!found) next.push(line);
  fs.writeFileSync(filePath, next.filter((item, index) => item || index < next.length - 1).join('\n') + '\n', { mode: 0o600 });
}

function buildRegeneratePrompt({ sessionId, conversationId, seedMessage }) {
  const recent = getRecentConversation(sessionId, 24, conversationId)
    .filter((message) => message.id !== seedMessage.id)
    .map((message) => `${message.role === 'user' ? 'Ceci' : 'Theo'}: ${message.content}`)
    .join('\n');
  return [
    `[Bridge session: ${sessionId}]`,
    `[Conversation: ${conversationId}]`,
    'Continue this conversation naturally. Use Ombre Brain tools only when the user explicitly asks for memory actions.',
    recent ? `Recent visible history:\n${recent}` : '',
    `User: ${seedMessage.content}`
  ].filter(Boolean).join('\n\n');
}

function createApiRouter(claudeManager, pushAgent) {
  const router = express.Router();

  function internalAuth(req, res, next) {
    const expected = claudeManager.getInternalToken?.();
    if (!expected || req.headers.authorization === `Bearer ${expected}`) {
      next();
      return;
    }
    res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  router.post('/internal/channel/reply', internalAuth, express.json({ limit: '128kb' }), (req, res) => {
    try {
      const result = claudeManager.handleChannelReply(req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/internal/channel/permission_request', internalAuth, express.json({ limit: '64kb' }), (req, res) => {
    try {
      const result = claudeManager.handlePermissionRequest?.(req.body || {}) || { ok: true };
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/healthz', (req, res) => {
    res.json({ ok: true, service: 'companion-bridge', claude: claudeManager.status() });
  });

  router.get('/api/status', httpAuth, (req, res) => {
    res.json({
      ok: true,
      bridge: {
        host: config.host,
        port: config.port,
        wsPath: config.wsPath,
        sttMode: config.stt.mode,
        ttsMode: config.tts.mode
      },
      claude: claudeManager.status(),
      db: getStatus()
      ,
      push: pushAgent?.status?.() || null,
      mcp: approvalStatus(),
      dash: relationshipMeta()
    });
  });

  router.get('/api/dash/morning-line', httpAuth, async (req, res) => {
    try {
      const result = await getMorningLine({ force: req.query.force === '1', reason: 'dash_api' });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/api/upload', httpAuth, upload.single('file'), (req, res) => {
    try {
      if (!req.file) {
        res.status(400).json({ ok: false, error: 'file required' });
        return;
      }
      const conversationId = normalizeConversationId(req.body?.conversation_id || req.body?.conversationId || 'default');
      const file = saveUploadedFile(req.file, { conversationId });
      res.json({ ok: true, file });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get('/api/files/:fileId', httpAuth, (req, res) => {
    try {
      const filePath = findAttachmentById(req.params.fileId);
      if (!filePath) {
        res.status(404).json({ ok: false, error: 'file not found' });
        return;
      }
      res.sendFile(filePath);
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post('/api/admin/restart-claude', httpAuth, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const result = await claudeManager.restartClaude({
        conversationId: req.body?.conversation_id || req.body?.conversationId || 'default',
        model: req.body?.model || '',
        reason: req.body?.reason || 'admin_api'
      });
      res.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/api/model/current', httpAuth, (req, res) => {
    res.json({
      ok: true,
      model: config.claude.model || '',
      label: MODEL_CHOICES.find((item) => item.value === (config.claude.model || ''))?.label || config.claude.model || 'Server default',
      choices: MODEL_CHOICES,
      envFile: process.env.BRIDGE_ENV_FILE || '/etc/companion/bridge-v2.env',
      claude: claudeManager.status()
    });
  });

  router.post('/api/model/switch', httpAuth, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const model = sanitizeModelName(req.body?.model);
      const persist = req.body?.persist === true;
      const conversationId = req.body?.conversation_id || req.body?.conversationId || 'default';
      config.claude.model = model;
      if (persist) {
        updateEnvValue(process.env.BRIDGE_ENV_FILE || '/etc/companion/bridge-v2.env', 'CLAUDE_MODEL', model);
      }
      const restart = await claudeManager.restartClaude({
        conversationId,
        model,
        reason: persist ? 'model_switch_persist' : 'model_switch'
      });
      res.status(restart.ok ? 200 : 500).json({
        ok: restart.ok,
        model,
        persist,
        restart,
        label: MODEL_CHOICES.find((item) => item.value === model)?.label || model || 'Server default'
      });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get('/api/conversations', httpAuth, (req, res) => {
    res.json({ ok: true, conversations: listConversations() });
  });

  router.post('/api/conversations', httpAuth, express.json({ limit: '64kb' }), (req, res) => {
    try {
      const conversation = createConversation({ title: req.body?.title || '新对话' });
      res.json({ ok: true, conversation });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.patch('/api/conversations/:id', httpAuth, express.json({ limit: '64kb' }), (req, res) => {
    try {
      const ok = updateConversationTitle(req.params.id, req.body?.title);
      if (!ok) {
        res.status(404).json({ ok: false, error: 'conversation not found' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.delete('/api/conversations/:id', httpAuth, (req, res) => {
    try {
      const deleted = deleteConversation(req.params.id);
      res.json({ ok: true, deleted });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get('/api/vapid', httpAuth, (req, res) => {
    if (!config.push.vapidPublicKey) {
      res.status(500).json({ ok: false, error: 'VAPID_PUBLIC_KEY 未配置' });
      return;
    }
    res.json({ ok: true, publicKey: config.push.vapidPublicKey });
  });

  router.post('/api/subscribe', httpAuth, express.json({ limit: '128kb' }), (req, res) => {
    const endpoint = req.body?.endpoint;
    const p256dh = req.body?.keys?.p256dh;
    const auth = req.body?.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      res.status(400).json({ ok: false, error: 'invalid subscription' });
      return;
    }
    upsertPushSubscription({
      endpoint,
      p256dh,
      auth,
      ua: req.headers['user-agent'] || null
    });
    res.json({ ok: true });
  });

  router.post('/api/push/trigger', httpAuth, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      if (!pushAgent) throw new Error('push-agent 未初始化');
      const result = await pushAgent.trigger(req.body?.reason || 'manual', { force: req.body?.force === true });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/api/history', httpAuth, (req, res) => {
    const sessionId = String(req.query.session_id || 'default');
    const conversationId = normalizeConversationId(req.query.conversation_id || 'default');
    const limit = Math.min(Number.parseInt(req.query.limit || '50', 10), 200);
    res.json({ ok: true, conversation_id: conversationId, messages: getRecentMessages(sessionId, limit, conversationId) });
  });

  router.patch('/api/messages/:id', httpAuth, express.json({ limit: '64kb' }), (req, res) => {
    try {
      const message = updateMessageContent(req.params.id, req.body?.content);
      if (!message) {
        res.status(404).json({ ok: false, error: 'message not found' });
        return;
      }
      res.json({ ok: true, message, event: 'message_edited' });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.delete('/api/messages/:id', httpAuth, (req, res) => {
    try {
      const cascade = String(req.query.cascade || 'false') === 'true';
      const result = deleteMessage(req.params.id, { cascade });
      if (!result.message) {
        res.status(404).json({ ok: false, error: 'message not found' });
        return;
      }
      res.json({ ok: true, ...result, cascade, event: 'message_deleted' });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.post('/api/messages/:id/regenerate', httpAuth, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const seedMessage = getRegenerationSeed(req.params.id);
      if (!seedMessage) {
        res.status(404).json({ ok: false, error: 'message not found or no previous user message' });
        return;
      }
      const sessionId = seedMessage.session_id || String(req.body?.session_id || req.body?.sessionId || 'default');
      const conversationId = normalizeConversationId(seedMessage.conversation_id || req.body?.conversation_id || 'default');
      const model = sanitizeModelName(req.body?.model || config.claude.model || '');

      const deleted = softDeleteAfterMessage(seedMessage.id);
      clearConversationClaudeSessionId(conversationId);
      await claudeManager.restartClaude({ conversationId, model, reason: 'message_regenerate' });

      const prompt = buildRegeneratePrompt({ sessionId, conversationId, seedMessage });
      const result = await claudeManager.runTurn(prompt, { model, conversationId, sessionId });
      if (result.claudeSessionId) {
        upsertConversationClaudeSessionId(conversationId, result.claudeSessionId);
      }
      const assistantId = insertMessage({
        sessionId,
        conversationId,
        source: 'chat',
        role: 'assistant',
        content: result.text || '[no text reply]',
        model: model || 'claude-code',
        meta: {
          parts: partsFromTurnResult(result),
          thinking: Array.isArray(result.thinking) ? result.thinking : [],
          regenerated_from: Number(req.params.id),
          seed_message_id: seedMessage.id,
          deleted_after_seed: deleted,
          claude_session_id: result.claudeSessionId || null
        }
      });
      res.json({
        ok: true,
        event: 'message_regenerated',
        seed_message_id: seedMessage.id,
        assistant_message_id: assistantId,
        text: result.text || '',
        messages: getRecentMessages(sessionId, 80, conversationId)
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.post('/api/debug/turn', httpAuth, express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const sessionId = String(req.body?.session_id || req.body?.sessionId || 'curl-debug');
      const conversationId = normalizeConversationId(req.body?.conversation_id || req.body?.conversationId || 'default');
      const content = String(req.body?.content || '').trim();
      const model = String(req.body?.model || '').trim();
      if (!content) {
        res.status(400).json({ ok: false, error: 'content required' });
        return;
      }

      insertMessage({
        sessionId,
        conversationId,
        source: 'chat',
        role: 'user',
        content,
        meta: { type: 'debug_http' }
      });

      const resumeSessionId = getConversationClaudeSessionId(conversationId);
      const prompt = [
        `[Bridge 会话: ${sessionId}]`,
        '请正常回复用户。只有用户明确要求记忆、查询记忆、归档或管理记忆时，才使用 Ombre Brain 工具。',
        '',
        `用户：${content}`
      ].join('\n');

      const result = await claudeManager.runTurn(prompt, { model, resumeSessionId, conversationId, sessionId });
      if (result.claudeSessionId) {
        upsertConversationClaudeSessionId(conversationId, result.claudeSessionId);
      }

      insertMessage({
        sessionId,
        conversationId,
        source: 'chat',
        role: 'assistant',
        content: result.text || '[无文本回复]',
        model: model || 'claude-code',
        meta: {
          parts: partsFromTurnResult(result),
          thinking: Array.isArray(result.thinking) ? result.thinking : [],
          debug_http: true,
          raw_event_count: result.raw.length,
          claude_session_id: result.claudeSessionId || null,
          resumed_from: result.resumedFrom || null
        }
      });

      res.json({
        ok: true,
        session_id: sessionId,
        conversation_id: conversationId,
        resumed_from: result.resumedFrom || null,
        claude_session_id: result.claudeSessionId || null,
        text: result.text || ''
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/api/pending', httpAuth, (req, res) => {
    const sessionId = String(req.query.session_id || 'default');
    const conversationId = normalizeConversationId(req.query.conversation_id || 'default');
    res.json({ ok: true, conversation_id: conversationId, messages: getPendingKeepalive(sessionId, conversationId) });
  });

  function sendMcpError(res, error) {
    if (error.code === 'MCP_APPROVAL_REQUIRED') {
      res.status(403).json({
        ok: false,
        error: error.message,
        approvalRequired: true,
        tool: error.toolName,
        approval: error.approval
      });
      return;
    }
    res.status(500).json({ ok: false, error: error.message });
  }

  router.get('/api/memory/pulse', httpAuth, async (req, res) => {
    try {
      const includeArchive = String(req.query.include_archive || 'false') === 'true';
      const result = await callOmbreTool('pulse', { include_archive: includeArchive }, { reason: 'memory_tab_pulse' });
      res.json({ ok: true, result });
    } catch (error) {
      sendMcpError(res, error);
    }
  });

  router.get('/api/memory/breath', httpAuth, async (req, res) => {
    try {
      const result = await callOmbreTool('breath', {
        query: String(req.query.query || ''),
        domain: String(req.query.domain || ''),
        valence: Number(req.query.valence ?? -1),
        arousal: Number(req.query.arousal ?? -1)
      }, { reason: 'memory_tab_breath' });
      res.json({ ok: true, result });
    } catch (error) {
      sendMcpError(res, error);
    }
  });

  router.post('/api/mcp/approve', httpAuth, express.json({ limit: '64kb' }), (req, res) => {
    try {
      const tool = String(req.body?.tool || req.body?.toolName || '').trim();
      const scope = req.body?.scope === 'always' ? 'always' : 'once';
      const result = approveTool(tool, scope);
      res.json({ ok: true, result, mcp: approvalStatus() });
    } catch (error) {
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.get('/audio/:file', httpAuth, (req, res) => {
    try {
      const fileName = path.basename(req.params.file);
      if (!/^[a-f0-9]{64}\.mp3$/.test(fileName)) {
        res.status(400).json({ ok: false, error: 'invalid audio file' });
        return;
      }
      const filePath = safeJoin(config.audioDir, fileName);
      res.type('audio/mpeg').sendFile(filePath);
    } catch (error) {
      res.status(404).json({ ok: false, error: error.message });
    }
  });

  router.post('/api/consume', httpAuth, express.json({ limit: '256kb' }), (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    res.json({ ok: true, consumed: consumeKeepalive(ids) });
  });

  router.get('/api/dream/events', (req, res) => {
    const token = String(req.query.token || '');
    if (!config.push.dreamEventsToken || token !== config.push.dreamEventsToken) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    const type = String(req.query.type || '').trim();
    if (!type) {
      res.status(400).json({ ok: false, error: 'type required' });
      return;
    }
    const value = req.query.value === undefined ? null : String(req.query.value);
    const id = insertDreamEvent({ type, value, state: { ip: req.clientIp || req.socket.remoteAddress, stage: 7 } });
    res.json({ ok: true, id });
  });

  return router;
}

module.exports = { createApiRouter };
