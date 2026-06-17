const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pty = require('node-pty');
const config = require('../config');
const logger = require('../logger');
const { ensureDir } = require('../utils/fs');
const { normalizeClaudeEvent } = require('./claudeParser');

class ClaudePtyManager {
  constructor() {
    this.ptyProcess = null;
    this.buffer = '';
    this.queue = [];
    this.active = null;
    this.ready = false;
    this.restartTimer = null;
  }

  start() {
    if (this.ptyProcess) return;
    ensureDir(config.tmpDir);
    this.spawnShell();
  }

  status() {
    return {
      ready: this.ready,
      pid: this.ptyProcess?.pid || null,
      model: config.claude.model || 'default',
      queueLength: this.queue.length,
      active: Boolean(this.active)
    };
  }

  spawnShell() {
    const shell = process.env.SHELL || '/bin/bash';
    logger.info('启动 Claude PTY worker', { shell });
    this.ptyProcess = pty.spawn(shell, ['--noprofile', '--norc'], {
      name: 'xterm-color',
      cols: 120,
      rows: 40,
      cwd: config.claude.workdir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        CLAUDE_MCP_CONFIG: config.claude.mcpConfig,
        CLAUDE_MODEL: config.claude.model,
        CLAUDE_RESUME_SESSION_ID: '',
        CLAUDE_VERBOSE: config.claude.verbose ? '1' : '0',
        CLAUDE_PERMISSION_MODE: config.claude.permissionMode
      }
    });

    this.ready = true;
    this.ptyProcess.onData((data) => this.onData(data));
    this.ptyProcess.onExit(({ exitCode, signal }) => {
      logger.warn('Claude PTY worker 退出', { exitCode, signal });
      this.ready = false;
      this.ptyProcess = null;
      if (this.active) {
        this.active.reject(new Error('Claude PTY worker 意外退出'));
        this.active = null;
      }
      this.scheduleRestart();
    });

    // 关闭回显和 shell prompt，避免污染 JSONL。
    this.ptyProcess.write("stty -echo\nPS1=''\n");
    this.drainQueue();
  }

  scheduleRestart() {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnShell();
    }, config.claude.restartDelayMs);
  }

  runTurn(prompt, options = {}, handlers = {}) {
    if (typeof options.onStatus === 'function' || typeof options.onEvent === 'function') {
      handlers = options;
      options = {};
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, options, handlers, resolve, reject });
      this.drainQueue();
    });
  }

  drainQueue() {
    if (!this.ready || this.active || !this.queue.length || !this.ptyProcess) return;
    const job = this.queue.shift();
    const turnId = crypto.randomBytes(8).toString('hex');
    const promptFile = path.join(config.tmpDir, `claude-${turnId}.txt`);
    fs.writeFileSync(promptFile, job.prompt, { mode: 0o600 });

    const doneMarker = `__COMPANION_TURN_DONE__:${turnId}:`;
    const command = [
      'COMPANION_TURN_ID=' + shellQuote(turnId),
      'CLAUDE_MCP_CONFIG=' + shellQuote(config.claude.mcpConfig),
      'CLAUDE_MODEL=' + shellQuote(job.options.model || config.claude.model || ''),
      'CLAUDE_RESUME_SESSION_ID=' + shellQuote(job.options.resumeSessionId || ''),
      'CLAUDE_VERBOSE=' + shellQuote(config.claude.verbose ? '1' : '0'),
      'CLAUDE_PERMISSION_MODE=' + shellQuote(config.claude.permissionMode),
      shellQuote(config.claude.turnScript),
      shellQuote(promptFile),
      '; code=$?; printf "\\n' + doneMarker + '%s\\n" "$code"'
    ].join(' ');

    this.active = {
      ...job,
      turnId,
      promptFile,
      doneMarker,
      text: '',
      thinking: [],
      tools: [],
      raw: [],
      model: job.options.model || config.claude.model || '',
      resumeSessionId: job.options.resumeSessionId || '',
      claudeSessionId: job.options.resumeSessionId || '',
      timeout: setTimeout(() => {
        this.abortActive(new Error('Claude turn 超时'));
      }, config.claude.turnTimeoutMs)
    };

    job.handlers.onStatus?.({ type: 'status', content: 'claude_turn_started', meta: { turnId } });
    this.ptyProcess.write(`${command}\n`);
  }

  onData(data) {
    this.buffer += data.replace(/\r/g, '');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
    }
  }

  handleLine(line) {
    if (!this.active) return;
    if (line.startsWith(this.active.doneMarker)) {
      const exitCode = Number.parseInt(line.slice(this.active.doneMarker.length), 10);
      if (exitCode === 0) {
        this.finishActive(null, {
          text: this.active.text.trim(),
          thinking: this.active.thinking,
          tools: this.active.tools,
          raw: this.active.raw,
          claudeSessionId: this.active.claudeSessionId || null,
          resumedFrom: this.active.resumeSessionId || null
        });
      } else {
        this.finishActive(new Error(`Claude turn 失败，退出码 ${exitCode}`));
      }
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Claude 或 shell 的非 JSON 输出作为状态透传，便于调试，但不写入 assistant 正文。
      this.active.handlers.onEvent?.({ type: 'status', content: line, meta: { nonJson: true } });
      return;
    }

    this.active.raw.push(event);
    const claudeSessionId = findClaudeSessionId(event);
    if (claudeSessionId) {
      this.active.claudeSessionId = claudeSessionId;
    }
    const normalized = normalizeClaudeEvent(event);
    for (const item of normalized) {
      if (item.type === 'text') this.active.text += item.content;
      if (item.type === 'thinking') this.active.thinking.push(item.content);
      if (item.type === 'tool_use') this.active.tools.push(item.meta);
      this.active.handlers.onEvent?.(item);
    }
  }

  finishActive(error, result = null) {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    clearTimeout(active.timeout);
    try {
      fs.unlinkSync(active.promptFile);
    } catch {
      // 临时 prompt 文件清理失败不影响主流程。
    }
    if (error) {
      active.reject(error);
    } else {
      active.resolve(result);
    }
    this.drainQueue();
  }

  abortActive(error) {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    clearTimeout(active.timeout);
    try {
      fs.unlinkSync(active.promptFile);
    } catch {
      // 临时 prompt 文件清理失败不影响主流程。
    }
    active.reject(error);

    // 关键决策：超时后直接重启 PTY，避免旧 Claude 子进程继续输出，污染下一轮 JSONL。
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch {
        // kill 失败时等待 onExit 或下一次健康检查处理。
      }
    }
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function findClaudeSessionId(value, depth = 0) {
  if (!value || depth > 4) return null;
  if (typeof value !== 'object') return null;
  if (typeof value.session_id === 'string' && value.session_id) return value.session_id;
  if (typeof value.sessionId === 'string' && value.sessionId) return value.sessionId;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findClaudeSessionId(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

module.exports = { ClaudePtyManager };
