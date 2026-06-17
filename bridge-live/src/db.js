const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const config = require('./config');
const { ensureDir } = require('./utils/fs');
const { parseJsonObject, stringifyMeta } = require('./utils/json');

ensureDir(config.dataDir);

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  conversation_id TEXT,
  source TEXT DEFAULT 'chat',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  ts INTEGER NOT NULL,
  meta TEXT,
  attachments TEXT,
  keepalive_consumed INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
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

CREATE TABLE IF NOT EXISTS dream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  value TEXT,
  created_at INTEGER NOT NULL,
  state TEXT
);

CREATE TABLE IF NOT EXISTS claude_sessions (
  session_id TEXT PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  claude_session_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_keepalive ON messages(session_id, source, keepalive_consumed, ts);
CREATE INDEX IF NOT EXISTS idx_dream_events_created_at ON dream_events(created_at);
`);

function hasColumn(tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

function createConversationId() {
  return `conv_${crypto.randomBytes(8).toString('hex')}`;
}

function migrateConversations() {
  const now = Date.now();
  if (!hasColumn('messages', 'conversation_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE');
  }
  if (!hasColumn('messages', 'deleted_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN deleted_at INTEGER');
  }
  if (!hasColumn('messages', 'attachments')) {
    db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT');
  }

  const minMax = db.prepare('SELECT MIN(ts) AS created_at, MAX(ts) AS updated_at FROM messages').get();
  const legacyClaude = db.prepare('SELECT claude_session_id FROM claude_sessions WHERE session_id = ?').get('default');
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, claude_session_id)
    VALUES ('default', '默认会话', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = MAX(conversations.updated_at, excluded.updated_at),
      claude_session_id = COALESCE(conversations.claude_session_id, excluded.claude_session_id)
  `).run(minMax.created_at || now, minMax.updated_at || now, legacyClaude?.claude_session_id || null);

  db.prepare(`
    UPDATE messages
    SET conversation_id = 'default'
    WHERE conversation_id IS NULL OR conversation_id = ''
  `).run();
}

migrateConversations();

db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_conversation_ts ON messages(conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_deleted_at ON messages(deleted_at);
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO messages (session_id, conversation_id, source, role, content, model, ts, meta, attachments, keepalive_consumed)
  VALUES (@session_id, @conversation_id, @source, @role, @content, @model, @ts, @meta, @attachments, @keepalive_consumed)
`);

const recentMessagesStmt = db.prepare(`
  SELECT id, session_id, conversation_id, source, role, content, model, ts, meta, attachments, keepalive_consumed, deleted_at
  FROM messages
  WHERE session_id = ? AND conversation_id = ? AND deleted_at IS NULL
  ORDER BY ts DESC
  LIMIT ?
`);

const allRecentMessagesStmt = db.prepare(`
  SELECT id, session_id, conversation_id, source, role, content, model, ts, meta, attachments, keepalive_consumed, deleted_at
  FROM messages
  WHERE deleted_at IS NULL
  ORDER BY ts DESC
  LIMIT ?
`);

function rowToMessage(row) {
  return {
    ...row,
    meta: parseJsonObject(row.meta, {}),
    attachments: parseJsonObject(row.attachments, [])
  };
}

function normalizeConversationId(conversationId) {
  const id = String(conversationId || 'default').trim() || 'default';
  const row = db.prepare('SELECT id FROM conversations WHERE id = ?').get(id);
  return row?.id || 'default';
}

function touchConversation(conversationId) {
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), normalizeConversationId(conversationId));
}

function insertMessage({ sessionId, conversationId = 'default', source = 'chat', role, content, model = null, meta = null, attachments = null, keepaliveConsumed = 0 }) {
  const resolvedConversationId = normalizeConversationId(conversationId);
  const info = insertMessageStmt.run({
    session_id: sessionId || 'default',
    conversation_id: resolvedConversationId,
    source,
    role,
    content,
    model,
    ts: Date.now(),
    meta: stringifyMeta(meta),
    attachments: attachments ? stringifyMeta(attachments) : null,
    keepalive_consumed: keepaliveConsumed
  });
  touchConversation(resolvedConversationId);
  return info.lastInsertRowid;
}

function getRecentMessages(sessionId, limit = 50, conversationId = 'default') {
  return recentMessagesStmt.all(sessionId, normalizeConversationId(conversationId), limit).reverse().map(rowToMessage);
}

function getRecentMessagesAnySession(limit = 50) {
  return allRecentMessagesStmt.all(limit).reverse().map(rowToMessage);
}

function getPendingKeepalive(sessionId, conversationId = 'default') {
  return db.prepare(`
    SELECT id, session_id, conversation_id, source, role, content, model, ts, meta, attachments, keepalive_consumed, deleted_at
    FROM messages
    WHERE session_id = ? AND conversation_id = ? AND source = 'keepalive' AND keepalive_consumed = 0 AND deleted_at IS NULL
    ORDER BY ts ASC
  `).all(sessionId, normalizeConversationId(conversationId)).map(rowToMessage);
}

function consumeKeepalive(ids) {
  if (!ids.length) return 0;
  const stmt = db.prepare(`UPDATE messages SET keepalive_consumed = 1 WHERE id = ?`);
  const tx = db.transaction((messageIds) => {
    let changed = 0;
    for (const id of messageIds) changed += stmt.run(id).changes;
    return changed;
  });
  return tx(ids);
}

function insertDreamEvent({ type, value = null, state = null }) {
  return db.prepare(`
    INSERT INTO dream_events (type, value, created_at, state)
    VALUES (?, ?, ?, ?)
  `).run(type, value, Date.now(), state ? JSON.stringify(state) : null).lastInsertRowid;
}

function upsertPushSubscription({ endpoint, p256dh, auth, ua = null }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, ua, created_at, fail_count)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      ua = excluded.ua
  `).run(endpoint, p256dh, auth, ua, now);
}

function getPushSubscriptions() {
  return db.prepare(`
    SELECT id, endpoint, p256dh, auth, ua, created_at, last_ok_at, last_fail_at, fail_count
    FROM push_subscriptions
    ORDER BY created_at ASC
  `).all();
}

function markPushOk(id) {
  db.prepare(`
    UPDATE push_subscriptions
    SET last_ok_at = ?, fail_count = 0
    WHERE id = ?
  `).run(Date.now(), id);
}

function markPushFail(id) {
  db.prepare(`
    UPDATE push_subscriptions
    SET last_fail_at = ?, fail_count = fail_count + 1
    WHERE id = ?
  `).run(Date.now(), id);
}

function getRecentConversation(sessionId, limit = 20, conversationId = 'default') {
  return db.prepare(`
    SELECT id, role, content, source, ts
    FROM messages
    WHERE session_id = ? AND conversation_id = ? AND deleted_at IS NULL
    ORDER BY ts DESC
    LIMIT ?
  `).all(sessionId, normalizeConversationId(conversationId), limit).reverse();
}

function getRecentActivities(sinceTs, limit = 10) {
  return db.prepare(`
    SELECT type, value, created_at, state
    FROM dream_events
    WHERE created_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sinceTs, limit).map((row) => ({ ...row, state: parseJsonObject(row.state, null) }));
}

function getLastUserMessage(sessionId, conversationId = 'default') {
  return db.prepare(`
    SELECT id, content, ts
    FROM messages
    WHERE session_id = ? AND conversation_id = ? AND role = 'user' AND deleted_at IS NULL
    ORDER BY ts DESC
    LIMIT 1
  `).get(sessionId, normalizeConversationId(conversationId));
}

function getLastKeepalive(sessionId, conversationId = 'default') {
  return db.prepare(`
    SELECT id, content, ts
    FROM messages
    WHERE session_id = ? AND conversation_id = ? AND source = 'keepalive' AND deleted_at IS NULL
    ORDER BY ts DESC
    LIMIT 1
  `).get(sessionId, normalizeConversationId(conversationId));
}

function listConversations() {
  return db.prepare(`
    SELECT
      c.id,
      c.title,
      c.created_at,
      c.updated_at,
      c.claude_session_id,
      COUNT(m.id) AS message_count,
      (
        SELECT content
        FROM messages
        WHERE conversation_id = c.id AND deleted_at IS NULL
        ORDER BY ts DESC
        LIMIT 1
      ) AS last_message
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id AND m.deleted_at IS NULL
    GROUP BY c.id
    ORDER BY c.updated_at DESC
  `).all();
}

function createConversation({ title = '新对话' } = {}) {
  const now = Date.now();
  const id = createConversationId();
  db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, claude_session_id)
    VALUES (?, ?, ?, ?, NULL)
  `).run(id, String(title || '新对话').slice(0, 80), now, now);
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

function updateConversationTitle(id, title) {
  const cleanTitle = String(title || '').trim().slice(0, 80);
  if (!cleanTitle) throw new Error('title required');
  const info = db.prepare(`
    UPDATE conversations
    SET title = ?, updated_at = ?
    WHERE id = ?
  `).run(cleanTitle, Date.now(), id);
  return info.changes > 0;
}

function deleteConversation(id) {
  const conversationId = normalizeConversationId(id);
  const count = db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count;
  if (conversationId === 'default' && count <= 1) {
    throw new Error('不能删除最后一个会话');
  }
  const tx = db.transaction((targetId) => {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(targetId);
    const info = db.prepare('DELETE FROM conversations WHERE id = ?').run(targetId);
    return info.changes;
  });
  return tx(conversationId);
}

function getConversationClaudeSessionId(conversationId) {
  const row = db.prepare(`
    SELECT claude_session_id
    FROM conversations
    WHERE id = ?
  `).get(normalizeConversationId(conversationId));
  return row?.claude_session_id || null;
}

function upsertConversationClaudeSessionId(conversationId, claudeSessionId) {
  if (!conversationId || !claudeSessionId) return false;
  db.prepare(`
    UPDATE conversations
    SET claude_session_id = ?, updated_at = ?
    WHERE id = ?
  `).run(claudeSessionId, Date.now(), normalizeConversationId(conversationId));
  return true;
}

function clearConversationClaudeSessionId(conversationId) {
  db.prepare(`
    UPDATE conversations
    SET claude_session_id = NULL, updated_at = ?
    WHERE id = ?
  `).run(Date.now(), normalizeConversationId(conversationId));
}

function getMessageById(id) {
  const row = db.prepare(`
    SELECT id, session_id, conversation_id, source, role, content, model, ts, meta, attachments, keepalive_consumed, deleted_at
    FROM messages
    WHERE id = ?
  `).get(Number(id));
  return row ? rowToMessage(row) : null;
}

function updateMessageContent(id, content) {
  const message = getMessageById(id);
  if (!message || message.deleted_at) return null;
  const cleanContent = String(content || '').trim();
  if (!cleanContent) throw new Error('content required');
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE messages
      SET content = ?, meta = json_set(COALESCE(meta, '{}'), '$.edited_at', ?)
      WHERE id = ? AND deleted_at IS NULL
    `).run(cleanContent, now, message.id);
    db.prepare(`
      UPDATE messages
      SET deleted_at = ?
      WHERE session_id = ? AND conversation_id = ? AND deleted_at IS NULL AND id > ?
    `).run(now, message.session_id, normalizeConversationId(message.conversation_id), message.id);
    clearConversationClaudeSessionId(message.conversation_id);
    touchConversation(message.conversation_id);
  });
  tx();
  return getMessageById(id);
}

function deleteMessage(id, { cascade = false } = {}) {
  const message = getMessageById(id);
  if (!message) return { deleted: 0, message: null };
  const conversationId = normalizeConversationId(message.conversation_id);
  const now = Date.now();
  if (cascade) {
    const info = db.prepare(`
      UPDATE messages
      SET deleted_at = ?
      WHERE session_id = ? AND conversation_id = ? AND deleted_at IS NULL AND id >= ?
    `).run(now, message.session_id, conversationId, message.id);
    clearConversationClaudeSessionId(conversationId);
    touchConversation(conversationId);
    return { deleted: info.changes, message };
  }
  const info = db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
  touchConversation(conversationId);
  return { deleted: info.changes, message };
}

function getRegenerationSeed(messageId) {
  const message = getMessageById(messageId);
  if (!message || message.deleted_at) return null;
  if (message.role === 'user') return message;
  const row = db.prepare(`
    SELECT id, session_id, conversation_id, source, role, content, model, ts, meta, attachments, keepalive_consumed, deleted_at
    FROM messages
    WHERE session_id = ? AND conversation_id = ? AND role = 'user' AND deleted_at IS NULL AND id < ?
    ORDER BY id DESC
    LIMIT 1
  `).get(message.session_id, normalizeConversationId(message.conversation_id), message.id);
  return row ? rowToMessage(row) : null;
}

function softDeleteAfterMessage(messageId) {
  const message = getMessageById(messageId);
  if (!message) return 0;
  const conversationId = normalizeConversationId(message.conversation_id);
  const info = db.prepare(`
    UPDATE messages
    SET deleted_at = ?
    WHERE session_id = ? AND conversation_id = ? AND deleted_at IS NULL AND id > ?
  `).run(Date.now(), message.session_id, conversationId, message.id);
  clearConversationClaudeSessionId(conversationId);
  touchConversation(conversationId);
  return info.changes;
}

function getClaudeSessionId(sessionId) {
  const row = db.prepare(`
    SELECT claude_session_id
    FROM claude_sessions
    WHERE session_id = ?
  `).get(sessionId);
  return row?.claude_session_id || null;
}

function upsertClaudeSessionId(sessionId, claudeSessionId) {
  if (!sessionId || !claudeSessionId) return false;
  const now = Date.now();
  db.prepare(`
    INSERT INTO claude_sessions (session_id, claude_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      claude_session_id = excluded.claude_session_id,
      updated_at = excluded.updated_at
  `).run(sessionId, claudeSessionId, now, now);
  return true;
}

function getStatus() {
  const messageCount = db.prepare('SELECT COUNT(*) AS count FROM messages WHERE deleted_at IS NULL').get().count;
  const conversationCount = db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count;
  const subscriptionCount = db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count;
  const claudeSessionCount = db.prepare('SELECT COUNT(*) AS count FROM claude_sessions').get().count;
  const recentEvents = db.prepare(`
    SELECT id, type, value, created_at, state
    FROM dream_events
    ORDER BY created_at DESC
    LIMIT 10
  `).all().map((row) => ({ ...row, state: parseJsonObject(row.state, null) }));
  return { messageCount, conversationCount, subscriptionCount, claudeSessionCount, recentEvents };
}

module.exports = {
  db,
  insertMessage,
  getRecentMessages,
  getRecentMessagesAnySession,
  getPendingKeepalive,
  consumeKeepalive,
  insertDreamEvent,
  upsertPushSubscription,
  getPushSubscriptions,
  markPushOk,
  markPushFail,
  getRecentConversation,
  getRecentActivities,
  getLastUserMessage,
  getLastKeepalive,
  normalizeConversationId,
  listConversations,
  createConversation,
  updateConversationTitle,
  deleteConversation,
  getConversationClaudeSessionId,
  upsertConversationClaudeSessionId,
  clearConversationClaudeSessionId,
  getMessageById,
  updateMessageContent,
  deleteMessage,
  getRegenerationSeed,
  softDeleteAfterMessage,
  getClaudeSessionId,
  upsertClaudeSessionId,
  getStatus
};
