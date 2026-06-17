#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pty = require('node-pty');

const ENV_FILE = process.env.BRIDGE_ENV_FILE || '/etc/companion/bridge.env';
const DEFAULT_WORKDIR = '/opt/companion/claude';
const READY_TIMEOUT_MS = Number(process.env.TEST_PTY_READY_TIMEOUT_MS || 120_000);
const RESPONSE_TIMEOUT_MS = Number(process.env.TEST_PTY_RESPONSE_TIMEOUT_MS || 180_000);
const QUIET_AFTER_PROMPT_MS = Number(process.env.TEST_PTY_QUIET_AFTER_PROMPT_MS || 1_500);

function now() {
  return Date.now();
}

function ms(start) {
  return `${Date.now() - start}ms`;
}

function log(message, meta) {
  if (meta === undefined) {
    console.log(message);
  } else {
    console.log(`${message} ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`);
  }
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// 轻量 strip-ansi，避免为了测试脚本额外改 package.json。
function stripAnsi(input) {
  return String(input || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\r/g, '\n');
}

function previewRaw(buffer, bytes = 200) {
  return buffer.slice(0, bytes).toString('utf8').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function compact(text, limit = 1200) {
  const value = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]` : value;
}

function hasReadyPrompt(cleaned) {
  const tail = cleaned.slice(-3000);
  return (
    /(^|\n)\s*>\s*$/.test(tail) ||
    /(^|\n)\s*>\s+/.test(tail) ||
    /Welcome to Claude Code/i.test(tail) ||
    /cwd:/i.test(tail) ||
    /Try .*Claude Code/i.test(tail)
  );
}

function looksDone(cleaned) {
  const tail = cleaned.slice(-2500);
  return /(^|\n)\s*>\s*$/.test(tail) || /(^|\n)\s*>\s+/.test(tail);
}

function maybeHandleOnboarding(child, cleaned, flags) {
  const tail = cleaned.slice(-5000);
  if (/Choose\s*the\s*text\s*style|Syntaxtheme|Syntax\s*theme/i.test(tail) && flags.themeAttempts < 6) {
    const last = flags.lastThemeAttemptAt || 0;
    if (Date.now() - last < 3000) return false;
    flags.themeAttempts += 1;
    flags.lastThemeAttemptAt = Date.now();
    const sequences = ['\r', '1\r', '\n', '\x1b[B\r', '\x1b[B\n', '\t\r'];
    const sequence = sequences[flags.themeAttempts - 1] || '\r';
    log('[INFO] onboarding: selecting default text style', {
      attempt: flags.themeAttempts,
      sequence: JSON.stringify(sequence)
    });
    child.write(sequence);
    return true;
  }
  if (!flags.trustAnswered && /Do\s*you\s*trust|trust\s*this\s*(folder|workspace|directory)|Yes,\s*proceed/i.test(tail)) {
    flags.trustAnswered = true;
    log('[INFO] onboarding: accepting workspace trust prompt');
    child.write('\r');
    return true;
  }
  return false;
}

function buildSpawnArgs(env, sessionId) {
  const args = ['--session-id', sessionId];
  const testSettings = {
    theme: 'dark',
    syntaxTheme: 'Monokai Extended',
    preferredTextStyle: 'auto',
    hasCompletedOnboarding: true,
    ccOnboardingFlags: {
      textStyle: true,
      syntaxTheme: true,
      terminalTheme: true
    }
  };
  args.push('--settings', JSON.stringify(testSettings));
  if (env.CLAUDE_MCP_CONFIG) args.push('--mcp-config', env.CLAUDE_MCP_CONFIG);
  if (env.CLAUDE_PERMISSION_MODE) args.push('--permission-mode', env.CLAUDE_PERMISSION_MODE);
  if (env.CLAUDE_MODEL) args.push('--model', env.CLAUDE_MODEL);
  return args;
}

function waitForReady(state, child) {
  const start = now();
  const flags = { themeAttempts: 0, lastThemeAttemptAt: 0, trustAnswered: false };
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const cleaned = stripAnsi(Buffer.concat(state.chunks).toString('utf8'));
      maybeHandleOnboarding(child, cleaned, flags);
      if (hasReadyPrompt(cleaned)) {
        clearInterval(timer);
        log('[OK] PTY ready', { elapsed: ms(start), rawBytes: state.rawBytes });
        resolve({ cleaned, elapsedMs: Date.now() - start });
        return;
      }
      if (Date.now() - start > READY_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(`PTY ready timeout after ${READY_TIMEOUT_MS}ms\n${compact(cleaned)}`));
      }
    }, 250);
  });
}

function sendAndWait(state, child, label, message) {
  const start = now();
  const beforeIndex = state.chunks.length;
  const beforeBytes = state.rawBytes;
  child.write(`${message}\r`);
  log(`[SEND] ${label}`, message);

  return new Promise((resolve, reject) => {
    let sawOutput = false;
    let promptSeenAt = 0;
    const timer = setInterval(() => {
      const newChunks = state.chunks.slice(beforeIndex);
      const raw = Buffer.concat(newChunks);
      const rawDelta = state.rawBytes - beforeBytes;
      const cleaned = stripAnsi(raw.toString('utf8'));
      if (rawDelta > message.length + 20) sawOutput = true;
      if (sawOutput && looksDone(cleaned)) {
        if (!promptSeenAt) promptSeenAt = Date.now();
        if (Date.now() - promptSeenAt >= QUIET_AFTER_PROMPT_MS) {
          clearInterval(timer);
          const elapsedMs = Date.now() - start;
          log(`[OK] response boundary: ${label}`, { elapsed: `${elapsedMs}ms`, rawBytes: raw.length, cleanedChars: cleaned.length });
          log(`[RAW first 200 bytes] ${label}: ${previewRaw(raw)}`);
          log(`[CLEANED text] ${label}:\n${compact(cleaned)}`);
          resolve({ raw, cleaned, elapsedMs });
        }
      } else {
        promptSeenAt = 0;
      }

      if (Date.now() - start > RESPONSE_TIMEOUT_MS) {
        clearInterval(timer);
        log(`[RAW first 200 bytes] ${label}: ${previewRaw(raw)}`);
        log(`[CLEANED text] ${label}:\n${compact(cleaned)}`);
        reject(new Error(`response timeout for ${label} after ${RESPONSE_TIMEOUT_MS}ms`));
      }
    }, 300);
  });
}

async function killAndVerify(child) {
  const start = now();
  if (child && child.pid) {
    log('[EXIT] killing PTY', { pid: child.pid });
    try {
      child.write('\u0003');
      child.write('/exit\r');
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      child.kill();
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  log('[OK] PTY killed', { elapsed: ms(start) });
}

async function main() {
  const envFile = loadEnvFile(ENV_FILE);
  const env = { ...process.env, ...envFile };
  const claudeBin = env.CLAUDE_BIN || 'claude';
  const cwd = env.CLAUDE_WORKDIR || DEFAULT_WORKDIR;
  const sessionId = env.TEST_PTY_SESSION_ID || crypto.randomUUID();
  const args = buildSpawnArgs(env, sessionId);
  const state = { chunks: [], rawBytes: 0, terminalColorAnswered: false };
  const summary = {
    ready: false,
    firstResponse: false,
    secondResponse: false,
    context: false,
    killed: false
  };

  log('[INFO] env file', ENV_FILE);
  log('[INFO] cwd', cwd);
  log('[INFO] spawn argv', [claudeBin, ...args].join(' '));

  const child = pty.spawn(claudeBin, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 36,
    cwd,
    env
  });

  log('[INFO] spawned', { pid: child.pid, sessionId });
  child.onData((chunk) => {
    const buffer = Buffer.from(chunk, 'utf8');
    state.rawBytes += buffer.length;
    state.chunks.push(buffer);
    if (!state.terminalColorAnswered && chunk.includes(']11;?')) {
      state.terminalColorAnswered = true;
      log('[INFO] terminal query: answering OSC 11 background color');
      child.write('\x1b]11;rgb:0000/0000/0000\x07');
      child.write('\x1b]11;rgb:0000/0000/0000\x1b\\');
    }
  });

  child.onExit((event) => {
    log('[INFO] PTY exit event', event);
  });

  try {
    await waitForReady(state, child);
    summary.ready = true;

    const first = await sendAndWait(state, child, 'turn-1', '我叫 Céci。请用一句话确认你记住了。');
    summary.firstResponse = first.cleaned.length > 0;

    const second = await sendAndWait(state, child, 'turn-2', '我叫什么？只回答名字本身。');
    summary.secondResponse = second.cleaned.length > 0;

    const contextOk = /C[ée]ci|Céci|Ceci/i.test(second.cleaned);
    summary.context = contextOk;
    if (contextOk) {
      log('[PASS] context test');
    } else {
      log(`[FAIL] context test, got: ${compact(second.cleaned, 800)}`);
    }
  } finally {
    await killAndVerify(child);
    summary.killed = true;
  }

  log('[SUMMARY]', summary);
  if (!summary.ready || !summary.firstResponse || !summary.secondResponse || !summary.context || !summary.killed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[FATAL]', error.stack || error.message);
  process.exit(1);
});
