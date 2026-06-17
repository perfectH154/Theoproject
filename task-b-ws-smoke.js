const fs = require('fs');
const WebSocket = require('/opt/companion/bridge-v2/node_modules/ws');

const env = fs.readFileSync('/etc/companion/bridge-v2.env', 'utf8');
const token = env.match(/^BRIDGE_TOKEN=(.*)$/m)?.[1]?.trim();
const conv = `reply-smoke-${Date.now()}`;
const ws = new WebSocket(`ws://127.0.0.1:3001/ws?token=${encodeURIComponent(token)}&session_id=smoke&conversation_id=${conv}`);
const seen = [];

const timeout = setTimeout(() => {
  console.log('[FAIL] timeout', seen);
  process.exit(1);
}, 180000);

ws.on('open', () => {
  console.log('[open]', conv);
  ws.send(JSON.stringify({
    type: 'text',
    content: '只回复：第一。||第二。不要写其他字。',
    meta: { session_id: 'smoke', conversation_id: conv }
  }));
});

ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (['typing_indicator', 'text', 'status'].includes(msg.type)) {
    console.log(`[event] ${msg.type} ${msg.content || ''}`.slice(0, 180));
  }
  if (msg.type === 'typing_indicator' || msg.type === 'text') seen.push(msg.type);
  if (msg.type === 'status' && msg.content === 'assistant_message_saved') {
    clearTimeout(timeout);
    const textCount = seen.filter((x) => x === 'text').length;
    console.log(JSON.stringify({ ok: textCount >= 1, textCount, seen }));
    ws.close();
    setTimeout(() => process.exit(textCount >= 1 ? 0 : 1), 300);
  }
});

ws.on('error', (err) => {
  console.error('[ws error]', err.message);
  process.exit(1);
});
