function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const char of String(text || 'default')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function channelPortForConversation(conversationId) {
  const base = Number.parseInt(process.env.CHANNEL_PORT_BASE || '41000', 10);
  const span = Number.parseInt(process.env.CHANNEL_PORT_SPAN || '2000', 10);
  return base + (fnv1a(conversationId) % span);
}

function tmuxSessionName(conversationId) {
  const safe = String(conversationId || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `theo-cc-${safe || 'default'}`;
}

module.exports = { channelPortForConversation, tmuxSessionName };
