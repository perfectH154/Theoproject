const express = require('express');
const path = require('node:path');
const config = require('../config');
const { httpAuth } = require('../security');
const { safeJoin } = require('../utils/fs');
const { callOmbreTool } = require('../services/mcpHttp');
const { approveTool, approvalStatus } = require('../services/mcpApproval');
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
  upsertConversationClaudeSessionId
} = require('../db');

function createApiRouter(claudeManager, pushAgent) {
  const router = express.Router();

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
      mcp: approvalStatus()
    });
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

      const result = await claudeManager.runTurn(prompt, { model, resumeSessionId });
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
