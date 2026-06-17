const fs = require('fs');
const WebSocket = require('/opt/companion/bridge-v2/node_modules/ws');
const env = fs.readFileSync('/etc/companion/bridge-v2.env', 'utf8');
const token = env.match(/^BRIDGE_TOKEN=(.*)$/m)?.[1]?.trim();
const conv = 'conv_08321d00d5d432fd';
const ws = new WebSocket(`ws://127.0.0.1:3001/ws?token=${encodeURIComponent(token)}&session_id=smoke&conversation_id=${conv}`);
const seen = [];
const timeout = setTimeout(() => {
  console.log('[FAIL] timeout', JSON.stringify(seen));
  try { ws.close(); } catch {}
  process.exit(1);
}, 180000);
ws.on('open', () => {
  console.log('[open]', conv);
  ws.send(JSON.stringify({
    type: 'text',
    content: 'Please reply exactly: websocket-ok',
    meta: { session_id: 'smoke', conversation_id: conv }
  }));
});
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (['typing_indicator', 'text', 'status', 'error'].includes(msg.type)) {
    console.log(`[event] ${msg.type} ${msg.content || ''}`.slice(0, 300));
  }
  if (msg.type === 'text') seen.push(msg.content || '');
  if (msg.type === 'status' && msg.content === 'assistant_message_saved') {
    clearTimeout(timeout);
    const text = seen.join('\n');
    const ok = /websocket-ok/i.test(text);
    console.log(JSON.stringify({ ok, text }));
    ws.close();
    setTimeout(() => process.exit(ok ? 0 : 1), 300);
  }
});
ws.on('error', (err) => {
  console.error('[ws error]', err.message);
  process.exit(1);
});
