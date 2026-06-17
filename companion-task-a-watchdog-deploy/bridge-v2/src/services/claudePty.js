const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const config = require('../config');
const logger = require('../logger');
const { ensureDir } = require('../utils/fs');
const { channelPortForConversation, tmuxSessionName } = require('./channelPorts');

const CHANNEL_DIR = path.join(config.dataDir, 'channel');
const MCP_CONFIG_DIR = path.join(CHANNEL_DIR, 'mcp-configs');
const WORKDIR_DIR = path.join(CHANNEL_DIR, 'workdirs');
const TMUX_DIR = path.join(config.dataDir, 'tmux');
const TMUX_SOCKET = path.join(TMUX_DIR, 'theo-v2.sock');
const DEFAULT_INTERNAL_TOKEN = process.env.CHANNEL_INTERNAL_TOKEN || config.bridgeToken || crypto.randomBytes(24).toString('hex');
const CLAUDE_PROCESS_RESTART_REASON = 'restart_claude';

function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 20_000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeConversationId(value) {
  return String(value || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'default';
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function transcriptDirForWorkdir(workdir) {
  return path.join('/root/.claude/projects', workdir.replace(/[^A-Za-z0-9]/g, '-'));
}

function findLatestClaudeSessionId(workdir) {
  try {
    const dir = transcriptDirForWorkdir(workdir);
    const files = fs.readdirSync(dir)
      .filter((name) => /^[0-9a-f-]{36}\.jsonl$/i.test(name))
      .map((name) => {
        const filePath = path.join(dir, name);
        return { name, mtimeMs: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0]?.name.replace(/\.jsonl$/i, '') || null;
  } catch {
    return null;
  }
}

function transcriptExists(workdir, sessionId) {
  if (!sessionId) return false;
  return fs.existsSync(path.join(transcriptDirForWorkdir(workdir), `${sessionId}.jsonl`));
}

function postJson(urlString, payload, token) {
  const url = new URL(urlString);
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  };
  if (token) headers.authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(response);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${response}`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function getJson(urlString) {
  return new Promise((resolve, reject) => {
    const req = http.get(urlString, (res) => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { response += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(response);
        else reject(new Error(`HTTP ${res.statusCode}: ${response}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

class ClaudePtyManager {
  constructor() {
    this.instances = new Map();
    this.maxInstances = Number.parseInt(process.env.CLAUDE_CHANNEL_MAX_SESSIONS || '1', 10);
    this.idleMs = Number.parseInt(process.env.CLAUDE_CHANNEL_IDLE_MS || String(30 * 60 * 1000), 10);
    this.replyQuietMs = Number.parseInt(process.env.CLAUDE_CHANNEL_REPLY_QUIET_MS || '1200', 10);
    this.internalToken = DEFAULT_INTERNAL_TOKEN;
    this.restartPromise = null;
  }

  start() {
    ensureDir(CHANNEL_DIR);
    ensureDir(MCP_CONFIG_DIR);
    ensureDir(WORKDIR_DIR);
    ensureDir(TMUX_DIR);
    this.watchdogTimer = setInterval(() => {
      this.watchdog().catch((error) => {
        logger.warn('Claude channel watchdog failed', { error: error.message });
      });
    }, 30_000);
    this.watchdogTimer.unref?.();
    logger.info('Claude channel manager ready', {
      mode: 'tmux-channel',
      maxInstances: this.maxInstances,
      idleMs: this.idleMs
    });
  }

  status() {
    return {
      ready: true,
      mode: 'tmux-channel',
      model: config.claude.model || 'default',
      processCount: null,
      active: Array.from(this.instances.values()).filter((item) => Boolean(item.active)).length,
      sessions: Array.from(this.instances.values()).map((item) => ({
        conversationId: item.conversationId,
        tmuxSession: item.tmuxSession,
        port: item.port,
        active: Boolean(item.active),
        lastUsedAt: item.lastUsedAt
      }))
    };
  }

  getInternalToken() {
    return this.internalToken;
  }

  async runTurn(prompt, options = {}, handlers = {}) {
    if (typeof options.onStatus === 'function' || typeof options.onEvent === 'function') {
      handlers = options;
      options = {};
    }
    const conversationId = safeConversationId(options.conversationId || 'default');
    const instance = await this.ensureInstance(conversationId, options);
    return this.enqueueTurn(instance, prompt, options, handlers);
  }

  async ensureInstance(conversationId, options = {}) {
    let instance = this.instances.get(conversationId);
    if (!instance) {
      instance = {
        conversationId,
        tmuxSession: tmuxSessionName(conversationId),
        port: channelPortForConversation(conversationId),
        mcpConfigPath: path.join(MCP_CONFIG_DIR, `${conversationId}.mcp.json`),
        workdir: path.join(WORKDIR_DIR, conversationId),
        queue: [],
        active: null,
        lastUsedAt: Date.now(),
        idleTimer: null
      };
      this.instances.set(conversationId, instance);
    }
    instance.lastUsedAt = Date.now();
    instance.lastOptions = { ...instance.lastOptions, ...options };
    clearTimeout(instance.idleTimer);
    await this.evictIfNeeded(conversationId);
    this.writeMcpConfig(instance);
    await this.ensureTmux(instance, options);
    await this.waitForChannel(instance);
    return instance;
  }

  parseClaudeProcesses(stdout) {
    return String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter(Boolean)
      .filter((item) => {
        if (!Number.isFinite(item.pid)) return false;
        const command = item.command;
        const isCompanionChannelClaude = command.includes('claude')
          && command.includes('--dangerously-load-development-channels')
          && command.includes('companion-channel');
        const isSessionClaude = command.includes('claude') && command.includes('--session');
        const isHelper = command.includes('companion-channel.mjs') || command.includes('/src/server.js');
        const isTmuxWrapper = command.startsWith('tmux ') || command.includes(' tmux -S ');
        return (isCompanionChannelClaude || isSessionClaude) && !isHelper && !isTmuxWrapper;
      });
  }

  async listClaudeProcesses() {
    try {
      const result = await execFileP('ps', ['-eo', 'pid=,args='], { timeout: 5000 });
      return this.parseClaudeProcesses(result.stdout);
    } catch (error) {
      logger.warn('无法列出 Claude 进程', { error: error.message });
      return [];
    }
  }

  async killTmuxSessions() {
    let stdout = '';
    try {
      const result = await execFileP('tmux', ['-S', TMUX_SOCKET, 'ls'], { timeout: 5000 });
      stdout = result.stdout || '';
    } catch {
      return [];
    }

    const sessions = stdout
      .split(/\r?\n/)
      .map((line) => line.split(':')[0]?.trim())
      .filter((name) => name && name.startsWith('theo-cc-'));

    for (const session of sessions) {
      try {
        await execFileP('tmux', ['-S', TMUX_SOCKET, 'kill-session', '-t', session], { timeout: 5000 });
      } catch (error) {
        logger.warn('杀掉 tmux 会话失败', { session, error: error.message });
      }
    }
    return sessions;
  }

  async signalProcesses(processes, signal) {
    const pids = Array.from(new Set((processes || []).map((item) => String(item.pid)).filter(Boolean)));
    if (!pids.length) return;
    try {
      await execFileP('kill', [`-${signal}`, ...pids], { timeout: 5000 });
    } catch (error) {
      logger.warn('发送进程信号失败', { signal, pids, error: error.message });
    }
  }

  rejectAllPending(reason) {
    const error = new Error(reason || 'Claude process restarted');
    for (const instance of this.instances.values()) {
      clearTimeout(instance.idleTimer);
      if (instance.active) {
        clearTimeout(instance.active.timeout);
        clearTimeout(instance.active.replyTimer);
        instance.active.reject(error);
        instance.active = null;
      }
      while (instance.queue.length) {
        const job = instance.queue.shift();
        job.reject(error);
      }
    }
    this.instances.clear();
  }

  async restartClaude(options = {}) {
    if (this.restartPromise) {
      return this.restartPromise;
    }

    this.restartPromise = this._restartClaude(options).finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  async _restartClaude(options = {}) {
    const conversationId = safeConversationId(options.conversationId || options.conversation_id || 'default');
    const model = String(options.model || config.claude.model || '').trim();
    const startedAt = Date.now();
    const before = await this.listClaudeProcesses();

    logger.warn('开始收敛 Claude channel 进程', {
      reason: options.reason || CLAUDE_PROCESS_RESTART_REASON,
      conversationId,
      beforeCount: before.length,
      beforePids: before.map((item) => item.pid)
    });

    this.rejectAllPending('Claude channel restarted by watchdog');
    const killedSessions = await this.killTmuxSessions();
    await sleep(300);
    await this.signalProcesses(await this.listClaudeProcesses(), 'TERM');
    await sleep(2000);
    const afterTerm = await this.listClaudeProcesses();
    if (afterTerm.length) {
      await this.signalProcesses(afterTerm, 'KILL');
      await sleep(1000);
    }

    const instance = await this.ensureInstance(conversationId, { ...options, model });
    const after = await this.listClaudeProcesses();
    const result = {
      ok: after.length === 1,
      conversation_id: conversationId,
      before_count: before.length,
      before_pids: before.map((item) => item.pid),
      killed_tmux_sessions: killedSessions,
      after_count: after.length,
      pid: after[0]?.pid || null,
      after_pids: after.map((item) => item.pid),
      model: model || 'default',
      tmux_session: instance.tmuxSession,
      duration_ms: Date.now() - startedAt
    };

    if (result.ok) {
      logger.info('Claude channel 进程已收敛为 1 个', result);
    } else {
      logger.error('Claude channel 进程收敛失败', result);
    }
    return result;
  }

  async evictIfNeeded(keepConversationId) {
    const entries = Array.from(this.instances.values())
      .filter((item) => item.conversationId !== keepConversationId && !item.active)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    while (this.instances.size > this.maxInstances && entries.length) {
      const victim = entries.shift();
      await this.killInstance(victim, 'lru_evict');
    }
  }

  writeMcpConfig(instance) {
    const base = readJson(config.claude.mcpConfig, { mcpServers: {} });
    base.mcpServers = base.mcpServers || {};
    if (base.mcpServers['ombre-brain'] && process.env.OMBRE_MCP_HTTP_URL) {
      base.mcpServers['ombre-brain'].url = process.env.OMBRE_MCP_HTTP_URL;
    }
    base.mcpServers['companion-channel'] = {
      command: process.execPath,
      args: [path.join(config.claude.workdir, '..', 'bridge-v2', 'src', 'channel', 'companion-channel.mjs')],
      env: {
        COMPANION_CONVERSATION_ID: instance.conversationId,
        COMPANION_CHANNEL_PORT: String(instance.port),
        COMPANION_BRIDGE_URL: `http://${config.host}:${config.port}`,
        COMPANION_INTERNAL_TOKEN: this.internalToken
      }
    };
    fs.writeFileSync(instance.mcpConfigPath, JSON.stringify(base, null, 2), { mode: 0o600 });
    ensureDir(instance.workdir);
    fs.writeFileSync(path.join(instance.workdir, '.mcp.json'), JSON.stringify(base, null, 2), { mode: 0o600 });
    ensureDir(path.join(instance.workdir, '.claude'));
    const localSettingsPath = path.join(instance.workdir, '.claude', 'settings.local.json');
    const localSettings = readJson(localSettingsPath, {});
    const enabled = new Set(localSettings.enabledMcpjsonServers || []);
    enabled.add('ombre-brain');
    enabled.add('companion-channel');
    const allow = new Set(localSettings.permissions?.allow || []);
    allow.add('mcp__companion-channel__reply');
    localSettings.enabledMcpjsonServers = Array.from(enabled);
    localSettings.permissions = { ...(localSettings.permissions || {}), allow: Array.from(allow) };
    fs.writeFileSync(localSettingsPath, JSON.stringify(localSettings, null, 2), { mode: 0o600 });
  }

  async tmuxHasSession(instance) {
    try {
      await execFileP('tmux', ['-S', TMUX_SOCKET, 'has-session', '-t', instance.tmuxSession]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureTmux(instance, options = {}) {
    if (await this.tmuxHasSession(instance)) return;

    const args = [
      '--dangerously-load-development-channels', 'server:companion-channel',
      '--permission-mode', config.claude.permissionMode || 'bypassPermissions'
    ];
    const model = options.model || config.claude.model || '';
    if (model) args.push('--model', model);
    const resumeCandidate = instance.claudeSessionId || options.resumeSessionId || '';
    if (transcriptExists(instance.workdir, resumeCandidate)) {
      args.push('--resume', resumeCandidate);
    }

    const command = [
      'cd', shellQuote(instance.workdir), '&&',
      'env',
      `OMBRE_MCP_HTTP_URL=${shellQuote(process.env.OMBRE_MCP_HTTP_URL || '')}`,
      `NODE_ENV=${shellQuote(config.nodeEnv)}`,
      'claude',
      ...args.map(shellQuote)
    ].join(' ');

    logger.info('启动 Claude tmux channel 会话', {
      conversationId: instance.conversationId,
      tmuxSession: instance.tmuxSession,
      port: instance.port,
      model: model || 'default',
      resumed: args.includes('--resume')
    });
    await execFileP('tmux', ['-S', TMUX_SOCKET, 'new-session', '-d', '-s', instance.tmuxSession, command]);
  }

  async waitForChannel(instance) {
    const url = `http://127.0.0.1:${instance.port}/health`;
    const started = Date.now();
    let lastError = null;
    let lastPromptCheck = 0;
    while (Date.now() - started < 45_000) {
      try {
        await getJson(url);
        return;
      } catch (error) {
        lastError = error;
        if (Date.now() - lastPromptCheck > 1500) {
          lastPromptCheck = Date.now();
          await this.acceptKnownStartupPrompt(instance);
        }
        await sleep(500);
      }
    }
    throw new Error(`channel not ready for ${instance.conversationId}: ${lastError?.message || 'timeout'}`);
  }

  async acceptKnownStartupPrompt(instance) {
    let pane = '';
    try {
      const result = await execFileP('tmux', ['-S', TMUX_SOCKET, 'capture-pane', '-pt', instance.tmuxSession, '-S', '-80']);
      pane = result.stdout || '';
    } catch {
      return;
    }

    const prompts = [
      'Yes, I trust this folder',
      'new MCP servers found in this project',
      'I am using this for local development'
    ];
    if (prompts.some((text) => pane.includes(text))) {
      logger.info('自动确认 Claude channel 启动提示', { conversationId: instance.conversationId });
      try {
        await execFileP('tmux', ['-S', TMUX_SOCKET, 'send-keys', '-t', instance.tmuxSession, 'Enter']);
      } catch (error) {
        logger.warn('自动确认启动提示失败', { conversationId: instance.conversationId, error: error.message });
      }
    }
  }

  async watchdog() {
    const processes = await this.listClaudeProcesses();
    if (processes.length > 1) {
      logger.warn('watchdog 发现多个 Claude channel 进程，自动收敛', {
        count: processes.length,
        pids: processes.map((item) => item.pid)
      });
      await this.restartClaude({ reason: 'watchdog_duplicate_processes' });
      return;
    }

    for (const instance of this.instances.values()) {
      if (!(await this.tmuxHasSession(instance))) {
        logger.warn('Claude tmux channel 会话消失，准备重启', {
          conversationId: instance.conversationId,
          tmuxSession: instance.tmuxSession
        });
        await this.restartClaude({
          ...(instance.lastOptions || {}),
          conversationId: instance.conversationId,
          reason: 'watchdog_missing_tmux_session'
        });
        return;
      }
    }
  }

  enqueueTurn(instance, prompt, options, handlers) {
    return new Promise((resolve, reject) => {
      instance.queue.push({ prompt, options, handlers, resolve, reject });
      this.drain(instance);
    });
  }

  drain(instance) {
    if (instance.active || !instance.queue.length) return;
    const job = instance.queue.shift();
    const turnId = crypto.randomBytes(8).toString('hex');
    const timeout = setTimeout(() => {
      this.finishActive(instance, new Error('Claude channel reply timeout'));
    }, config.claude.turnTimeoutMs);

    instance.active = {
      ...job,
      turnId,
      startedAt: Date.now(),
      timeout,
      replyTimer: null,
      text: '',
      raw: [],
      thinking: [],
      tools: [],
      claudeSessionId: job.options.resumeSessionId || null
    };

    job.handlers.onStatus?.({
      type: 'status',
      content: 'claude_channel_turn_started',
      meta: { turnId, conversation_id: instance.conversationId, tmuxSession: instance.tmuxSession }
    });

    postJson(`http://127.0.0.1:${instance.port}/message`, {
      content: job.prompt,
      meta: {
        conversation_id: instance.conversationId,
        chat_id: instance.conversationId,
        message_id: turnId,
        from: 'ceci',
        source: 'websocket'
      }
    }, this.internalToken).catch((error) => {
      this.finishActive(instance, error);
    });
  }

  handleChannelReply(payload) {
    const conversationId = safeConversationId(payload.conversation_id || payload.chat_id || 'default');
    const instance = this.instances.get(conversationId);
    if (!instance || !instance.active) {
      logger.warn('收到无活动 turn 的 channel reply', { conversationId, textBytes: Buffer.byteLength(String(payload.text || '')) });
      return { ok: false, reason: 'no_active_turn' };
    }

    const text = String(payload.text || '').trim();
    if (!text) return { ok: false, reason: 'empty_text' };
    const latestSessionId = findLatestClaudeSessionId(instance.workdir);
    if (latestSessionId) {
      instance.claudeSessionId = latestSessionId;
      instance.active.claudeSessionId = latestSessionId;
    }
    instance.active.text += (instance.active.text ? '\n' : '') + text;
    instance.active.raw.push({ type: 'reply', text, payload });
    instance.active.handlers.onEvent?.({
      type: 'text',
      content: text,
      meta: {
        rawType: 'channel_reply',
        conversation_id: conversationId,
        chat_id: payload.chat_id || conversationId,
        reply_to: payload.reply_to || null
      }
    });

    clearTimeout(instance.active.replyTimer);
    instance.active.replyTimer = setTimeout(() => {
      this.finishActive(instance, null, {
        text: instance.active.text.trim(),
        thinking: instance.active.thinking,
        tools: instance.active.tools,
        raw: instance.active.raw,
        claudeSessionId: instance.active.claudeSessionId,
        resumedFrom: instance.active.options.resumeSessionId || null
      });
    }, this.replyQuietMs);
    return { ok: true };
  }

  handlePermissionRequest(payload) {
    logger.warn('Claude permission request via channel', payload);
    return { ok: true };
  }

  finishActive(instance, error, result = null) {
    if (!instance.active) return;
    const active = instance.active;
    instance.active = null;
    clearTimeout(active.timeout);
    clearTimeout(active.replyTimer);
    instance.lastUsedAt = Date.now();
    instance.idleTimer = setTimeout(() => {
      this.killInstance(instance, 'idle_timeout').catch((killError) => {
        logger.warn('idle kill failed', { conversationId: instance.conversationId, error: killError.message });
      });
    }, this.idleMs);

    if (error) active.reject(error);
    else active.resolve(result);
    this.drain(instance);
  }

  async killInstance(instance, reason) {
    logger.info('停止 Claude tmux channel 会话', { conversationId: instance.conversationId, tmuxSession: instance.tmuxSession, reason });
    clearTimeout(instance.idleTimer);
    this.instances.delete(instance.conversationId);
    try {
      await execFileP('tmux', ['-S', TMUX_SOCKET, 'kill-session', '-t', instance.tmuxSession]);
    } catch {
      // 已退出时忽略。
    }
  }
}

module.exports = { ClaudePtyManager };
