const http = require('http');
const fs = require('fs');
const token = fs.readFileSync('/etc/companion/bridge-v2.env', 'utf8').match(/^BRIDGE_TOKEN=(.*)$/m)?.[1]?.trim();
const body = JSON.stringify({
  session_id: 'thinking-config-test',
  conversation_id: 'thinking-config-test',
  content: 'Think through this design choice before answering: for a read tab, should we use epub.js or a plain iframe renderer? Reply with one short recommendation sentence.'
});
const req = http.request('http://127.0.0.1:3001/api/debug/turn', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  }
}, (res) => {
  let data = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log(res.statusCode);
    console.log(data);
  });
});
req.on('error', (error) => { console.error(error); process.exitCode = 1; });
req.end(body);
