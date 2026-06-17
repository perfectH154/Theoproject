const fs = require('fs');
const WebSocket = require('/opt/companion/bridge-v2/node_modules/ws');
const env = fs.readFileSync('/etc/companion/bridge-v2.env', 'utf8');
const token = env.match(/^BRIDGE_TOKEN=(.*)$/m)?.[1]?.trim();
const conv = 'conv_08321d00d5d432fd';
const ws = new WebSocket(`ws://127.0.0.1:3001/ws?token=${encodeURIComponent(token)}&session_id=smoke&conversation_id=${conv}`);
let text = '';
const timeout = setTimeout(() => { console.log(JSON.stringify({ ok: false, reason: 'timeout', text })); try { ws.close(); } catch {} process.exit(1); }, 180000);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'text', content: 'Please reply exactly: ws-stable-ok', meta: { session_id: 'smoke', conversation_id: conv } }));
});
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.type === 'text') text += msg.content || '';
  if (msg.type === 'status' && msg.content === 'assistant_message_saved') {
    clearTimeout(timeout);
    const ok = /ws-stable-ok/i.test(text);
    console.log(JSON.stringify({ ok, text }));
    ws.close(1000, 'smoke done');
    setTimeout(() => process.exit(ok ? 0 : 1), 200);
  }
});
ws.on('close', (code, reason) => {
  if (!text) console.error(`[closed] ${code} ${reason}`);
});
ws.on('error', (e) => { console.error(e.message); process.exit(1); });
