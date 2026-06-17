const fs = require('fs');
const WebSocket = require('/opt/companion/bridge-v2/node_modules/ws');
const env = fs.readFileSync('/etc/companion/bridge-v2.env', 'utf8');
const token = env.match(/^BRIDGE_TOKEN=(.*)$/m)?.[1]?.trim();
const conv = 'conv_08321d00d5d432fd';
const ws = new WebSocket(`ws://127.0.0.1:3001/ws?token=${encodeURIComponent(token)}&session_id=smoke-c&conversation_id=${conv}`);
const events = [];
let text = '';
const timeout = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, reason: 'timeout', events, text }, null, 2));
  try { ws.close(); } catch {}
  process.exit(1);
}, 180000);
ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'text',
    content: 'Please reply exactly: task-c-ok',
    meta: { session_id: 'smoke-c', conversation_id: conv }
  }));
});
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (['thinking_chunk', 'thinking_complete', 'text', 'typing_indicator', 'status'].includes(msg.type)) {
    events.push({ type: msg.type, content: msg.content || '', hidden: msg.meta?.hidden || false });
  }
  if (msg.type === 'text') text += msg.content || '';
  if (msg.type === 'status' && msg.content === 'assistant_message_saved') {
    clearTimeout(timeout);
    const ok = /task-c-ok/i.test(text);
    console.log(JSON.stringify({ ok, thinkingEvents: events.filter(e => e.type.startsWith('thinking')).length, events, text }, null, 2));
    ws.close(1000, 'smoke done');
    setTimeout(() => process.exit(ok ? 0 : 1), 200);
  }
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
