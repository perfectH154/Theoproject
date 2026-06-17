const fs = require('fs');
const WebSocket = require('/opt/companion/bridge-v2/node_modules/ws');
const env = fs.readFileSync('/etc/companion/bridge-v2.env', 'utf8');
const token = env.match(/^BRIDGE_TOKEN=(.*)$/m)?.[1]?.trim();
const url = `ws://127.0.0.1:3001/ws?token=${encodeURIComponent(token)}&session_id=default&conversation_id=conv_08321d00d5d432fd`;
const events = [];
const ws1 = new WebSocket(url);
ws1.on('open', () => {
  events.push('ws1 open');
  setTimeout(() => {
    const ws2 = new WebSocket(url);
    ws2.on('open', () => {
      events.push('ws2 open');
      setTimeout(() => ws2.close(1000, 'smoke done'), 500);
    });
    ws2.on('close', (code, reason) => {
      events.push(`ws2 close ${code} ${reason}`);
      finish();
    });
    ws2.on('error', (e) => events.push(`ws2 error ${e.message}`));
  }, 500);
});
ws1.on('close', (code, reason) => events.push(`ws1 close ${code} ${reason}`));
ws1.on('error', (e) => events.push(`ws1 error ${e.message}`));
function finish() {
  setTimeout(() => {
    console.log(JSON.stringify({ events }, null, 2));
    const ok = events.some((x) => x.includes('ws1 close 4002')) && events.some((x) => x.includes('ws2 open'));
    process.exit(ok ? 0 : 1);
  }, 500);
}
setTimeout(() => { console.log(JSON.stringify({ events, timeout: true }, null, 2)); process.exit(1); }, 10000);
