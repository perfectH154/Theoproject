const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const logger = require('../logger');
const { ensureDir } = require('../utils/fs');

const approvalPath = path.join(config.dataDir, 'mcp-approvals.json');

function normalizeToolName(name) {
  return String(name || '').trim().toUpperCase();
}

function aliasesForTool(name) {
  const raw = String(name || '').trim();
  const upper = normalizeToolName(raw);
  const aliases = new Set([upper]);

  if (upper.startsWith('MCP_OMBRE_')) {
    aliases.add(upper.replace(/^MCP_OMBRE_/, ''));
  } else if (upper) {
    aliases.add(`MCP_OMBRE_${upper}`);
  }

  return aliases;
}

function readStoredApprovals() {
  try {
    if (!fs.existsSync(approvalPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(approvalPath, 'utf8'));
    if (!Array.isArray(parsed.alwaysAllow)) return [];
    return parsed.alwaysAllow.map(normalizeToolName).filter(Boolean);
  } catch (error) {
    logger.warn('读取 MCP approval 文件失败', { path: approvalPath, error: error.message });
    return [];
  }
}

function writeStoredApprovals(alwaysAllow) {
  ensureDir(config.dataDir);
  fs.writeFileSync(approvalPath, JSON.stringify({ alwaysAllow: [...alwaysAllow].sort() }, null, 2), {
    mode: 0o600
  });
}

function getDefaultApprovedTools() {
  return new Set([...(config.ombre.defaultApprovedTools || [])].map(normalizeToolName).filter(Boolean));
}

function getAlwaysApprovedTools() {
  return new Set(readStoredApprovals());
}

function isToolApproved(name, options = {}) {
  const aliases = aliasesForTool(name);
  const defaults = getDefaultApprovedTools();
  const stored = getAlwaysApprovedTools();

  const allowlistHit = [...aliases].find((alias) => defaults.has(alias));
  if (allowlistHit) {
    logger.info('MCP tool 命中默认 allowlist', {
      tool: name,
      normalized: [...aliases],
      allowlistHit
    });
    return { ok: true, source: 'default_allowlist', allowlistHit };
  }

  const storedHit = [...aliases].find((alias) => stored.has(alias));
  if (storedHit) {
    logger.info('MCP tool 命中用户始终允许列表', {
      tool: name,
      normalized: [...aliases],
      allowlistHit: storedHit
    });
    return { ok: true, source: 'stored_allowlist', allowlistHit: storedHit };
  }

  logger.warn('MCP tool 需要用户批准', {
    tool: name,
    normalized: [...aliases],
    reason: options.reason || 'not_in_allowlist'
  });
  return {
    ok: false,
    source: 'approval_required',
    reason: options.reason || 'not_in_allowlist',
    aliases: [...aliases]
  };
}

function approveTool(name, scope = 'once') {
  const normalized = normalizeToolName(name);
  if (!normalized) throw new Error('tool name required');

  if (scope === 'always') {
    const stored = getAlwaysApprovedTools();
    stored.add(normalized);
    for (const alias of aliasesForTool(normalized)) stored.add(alias);
    writeStoredApprovals(stored);
    logger.info('MCP approval result', { tool: name, scope, result: 'stored' });
    return { ok: true, tool: normalized, scope, stored: true };
  }

  logger.info('MCP approval result', { tool: name, scope, result: 'once' });
  return { ok: true, tool: normalized, scope: 'once', stored: false };
}

function approvalStatus() {
  return {
    defaultApprovedTools: [...getDefaultApprovedTools()],
    alwaysApprovedTools: [...getAlwaysApprovedTools()]
  };
}

module.exports = {
  aliasesForTool,
  approveTool,
  approvalStatus,
  isToolApproved,
  normalizeToolName
};
