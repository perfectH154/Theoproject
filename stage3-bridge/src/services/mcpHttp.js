const config = require('../config');
const logger = require('../logger');
const { isToolApproved } = require('./mcpApproval');

function parseMcpResponse(text, contentType) {
  if (contentType.includes('text/event-stream') || text.trimStart().startsWith('event:')) {
    const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    if (!dataLines.length) throw new Error('MCP SSE 响应没有 data 行');
    return JSON.parse(dataLines[dataLines.length - 1].replace(/^data:\s*/, ''));
  }
  return JSON.parse(text);
}

async function mcpRequest(url, method, params, sessionId, id) {
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json'
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (config.ombre.authHeaderName && config.ombre.authHeaderValue) {
    headers[config.ombre.authHeaderName] = config.ombre.authHeaderValue;
  }

  const body = { jsonrpc: '2.0', method };
  if (id !== null) body.id = id;
  if (params) body.params = params;

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text}`);
  return {
    data: id === null ? null : parseMcpResponse(text, response.headers.get('content-type') || ''),
    sessionId: response.headers.get('mcp-session-id') || sessionId
  };
}

async function callOmbreTool(name, args = {}, options = {}) {
  if (!config.ombre.mcpHttpUrl) {
    throw new Error('OMBRE_MCP_HTTP_URL 未配置');
  }
  const approval = isToolApproved(name, { reason: options.reason || 'ombre_http_call' });
  if (!approval.ok) {
    const error = new Error(`MCP 工具 ${name} 需要用户批准`);
    error.code = 'MCP_APPROVAL_REQUIRED';
    error.toolName = name;
    error.approval = approval;
    throw error;
  }

  logger.info('准备调用 Ombre MCP tool', {
    tool: name,
    approvalSource: approval.source,
    allowlistHit: approval.allowlistHit || null
  });

  let id = 1;
  const init = await mcpRequest(config.ombre.mcpHttpUrl, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'theo-bridge-memory-tab', version: '0.5.0' }
  }, null, id++);

  await mcpRequest(config.ombre.mcpHttpUrl, 'notifications/initialized', null, init.sessionId, null);
  const result = await mcpRequest(config.ombre.mcpHttpUrl, 'tools/call', {
    name,
    arguments: args
  }, init.sessionId, id++);
  logger.info('Ombre MCP tool 调用完成', { tool: name });
  return result.data;
}

module.exports = { callOmbreTool };
