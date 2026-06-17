const crypto = require('node:crypto');
const config = require('./config');

const ipState = new Map();

function getClientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();

  // 浏览器 WebSocket 不能自定义 Authorization header，所以额外允许 query token。
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function stateForIp(ip) {
  const now = Date.now();
  const state = ipState.get(ip) || {
    windowStart: now,
    count: 0,
    failCount: 0,
    bannedUntil: 0
  };
  if (now - state.windowStart >= 60_000) {
    state.windowStart = now;
    state.count = 0;
  }
  ipState.set(ip, state);
  return state;
}

function isBanned(ip) {
  const state = stateForIp(ip);
  return Date.now() < state.bannedUntil;
}

function registerAuthFailure(ip) {
  const state = stateForIp(ip);
  state.failCount += 1;
  if (state.failCount >= config.limits.authFailLimit) {
    state.bannedUntil = Date.now() + config.limits.authBanMs;
  }
}

function registerAuthSuccess(ip) {
  const state = stateForIp(ip);
  state.failCount = 0;
}

function checkRateLimit(ip) {
  const state = stateForIp(ip);
  if (Date.now() < state.bannedUntil) {
    return { ok: false, reason: 'banned' };
  }
  state.count += 1;
  if (state.count > config.limits.rateLimitPerMinute) {
    return { ok: false, reason: 'rate_limited' };
  }
  return { ok: true };
}

function authenticateRequest(req) {
  const ip = getClientIp(req);
  if (isBanned(ip)) {
    return { ok: false, ip, status: 403, reason: 'banned' };
  }
  const token = getBearerToken(req);
  if (!constantTimeEqual(token, config.bridgeToken)) {
    registerAuthFailure(ip);
    return { ok: false, ip, status: 401, reason: 'unauthorized' };
  }
  registerAuthSuccess(ip);
  return { ok: true, ip };
}

function httpAuth(req, res, next) {
  const result = authenticateRequest(req);
  if (!result.ok) {
    res.status(result.status).json({ ok: false, error: result.reason });
    return;
  }
  req.clientIp = result.ip;
  next();
}

module.exports = {
  getClientIp,
  authenticateRequest,
  httpAuth,
  checkRateLimit
};
