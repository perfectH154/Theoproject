#!/usr/bin/env node
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const conversationId = process.env.COMPANION_CONVERSATION_ID || 'default';
const port = Number.parseInt(process.env.COMPANION_CHANNEL_PORT || '41000', 10);
const bridgeUrl = process.env.COMPANION_BRIDGE_URL || 'http://127.0.0.1:3001';
const internalToken = process.env.COMPANION_INTERNAL_TOKEN || '';

const routingInstruction = [
  'ROUTING REQUIREMENT:',
  'You are inside a detached Claude Code terminal. Ceci cannot see normal terminal text.',
  'For every inbound companion-channel message, you MUST call the reply tool with visible text.',
  'Do not answer in the terminal. Do not say that you replied. The reply tool is the only path to the phone UI.',
  'Set conversation_id to the inbound conversation_id. If you want multiple chat bubbles, put || between segments in reply.text.'
].join(' ');

function log(message, meta = {}) {
  const payload = JSON.stringify({ ts: new Date().toISOString(), channel: conversationId, message, ...meta });
  process.stderr.write(`[companion-channel] ${payload}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 128 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function authorized(req) {
  if (!internalToken) return true;
  return req.headers.authorization === `Bearer ${internalToken}`;
}

async function postToBridge(path, payload) {
  const url = new URL(path, bridgeUrl);
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  };
  if (internalToken) headers.authorization = `Bearer ${internalToken}`;

  await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(response);
        else reject(new Error(`bridge ${res.statusCode}: ${response}`));
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const mcp = new Server(
  { name: 'companion-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {}
      },
      tools: {}
    },
    instructions: [
      'Messages arrive as <channel source="companion-..." conversation_id="..." message_id="...">.',
      'This is Theo\'s private mobile chat UI. Treat each channel message as Ceci speaking to you.',
      routingInstruction,
      'Never respond to a companion-channel message with only normal terminal prose; Ceci will see nothing unless you call reply.',
      'Keep replies natural and concise. Do not mention tools, MCP, or channel plumbing.',
      'Only use Ombre Brain memory tools when Ceci explicitly asks to remember, search previous memory, archive, or manage memory.'
    ].join(' ')
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  log('tools/list');
  return {
    tools: [
      {
        name: 'reply',
        description: [
          'Required tool for sending visible text to Ceci in the Theo mobile web UI.',
          'Use this after every companion-channel message. Normal terminal output is invisible to the user.',
          'Keep text under 500 characters. For multiple bubbles, put || between segments in one text value.'
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 2000 },
            chat_id: { type: 'string', description: 'Conversation or chat id from the inbound channel meta.' },
            conversation_id: { type: 'string', description: 'Conversation id from the inbound channel meta.' },
            reply_to: { type: 'string', description: 'Message id being replied to.' },
            files: { type: 'array', items: { type: 'string' } }
          },
          required: ['text']
        }
      }
    ]
  };
});

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  log('tool/call', {
    name: req.params.name,
    argKeys: Object.keys(req.params.arguments || {})
  });
  if (req.params.name !== 'reply') {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const args = req.params.arguments || {};
  const text = String(args.text || '').trim();
  if (!text) throw new Error('reply text required');

  const resolvedConversationId = String(args.conversation_id || args.chat_id || conversationId);
  try {
    await postToBridge('/internal/channel/reply', {
      conversation_id: resolvedConversationId,
      chat_id: args.chat_id || resolvedConversationId,
      text,
      reply_to: args.reply_to || null,
      files: Array.isArray(args.files) ? args.files : []
    });
  } catch (error) {
    log('reply forward failed', { error: error.message, resolvedConversationId, bytes: Buffer.byteLength(text) });
    throw error;
  }
  log('reply forwarded', { bytes: Buffer.byteLength(text), resolvedConversationId });
  return { content: [{ type: 'text', text: 'sent' }] };
});

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string().optional().default('')
  })
});

mcp.setNotificationHandler(
  PermissionRequestSchema,
  async ({ params }) => {
    await postToBridge('/internal/channel/permission_request', {
      conversation_id: conversationId,
      request_id: params.request_id,
      tool_name: params.tool_name,
      description: params.description,
      input_preview: params.input_preview
    });
    log('permission request forwarded', { request_id: params.request_id, tool_name: params.tool_name });
  }
);

await mcp.connect(new StdioServerTransport());

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, conversation_id: conversationId });
      return;
    }
    if (!authorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/message') {
      json(res, 404, { ok: false, error: 'not found' });
      return;
    }

    const body = await readBody(req);
    const payload = body ? JSON.parse(body) : {};
    const content = String(payload.content || '');
    const meta = {};
    for (const [key, value] of Object.entries(payload.meta || {})) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && value !== null) {
        meta[key] = String(value);
      }
    }
    meta.conversation_id = meta.conversation_id || conversationId;
    meta.chat_id = meta.chat_id || conversationId;

    const routedContent = [
      `<channel source="companion-web" conversation_id="${meta.conversation_id}" chat_id="${meta.chat_id}" message_id="${meta.message_id || ''}">`,
      content,
      '</channel>',
      routingInstruction,
      `Now call reply with conversation_id="${meta.conversation_id}".`
    ].join('\n');

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: routedContent, meta }
    });
    log('message injected', { bytes: Buffer.byteLength(content), meta });
    json(res, 200, { ok: true });
  } catch (error) {
    log('http error', { error: error.message });
    json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  log('http listener ready', { port, bridgeUrl });
});
