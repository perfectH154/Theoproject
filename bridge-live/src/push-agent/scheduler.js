const config = require('../config');
const logger = require('../logger');
const { insertMessage } = require('../db');
const { pushContext } = require('./context');
const { shouldPush } = require('./decider');
const { generateKeepalive } = require('./generator');
const { notifyAll } = require('./notifier');
const { primeMorningLineIfNeeded } = require('../services/dash');

class PushAgent {
  constructor() {
    this.timer = null;
    this.inFlight = false;
    this.lastScheduleKey = '';
    this.lastResult = { enabled: config.push.enabled, lastRunAt: null };
  }

  start() {
    if (!config.push.enabled) {
      logger.info('push-agent disabled');
      return;
    }
    this.timer = setInterval(() => this.tick().catch((error) => {
      logger.error('push-agent tick failed', { message: error.message });
    }), 60_000);
    logger.info('push-agent started', { times: config.push.times, timezone: config.push.timezone });
  }

  status() {
    return {
      enabled: config.push.enabled,
      inFlight: this.inFlight,
      lastScheduleKey: this.lastScheduleKey,
      lastResult: this.lastResult
    };
  }

  async tick() {
    const now = new Date();
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.push.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(now).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    await primeMorningLineIfNeeded(now);
    const hhmm = `${local.hour}:${local.minute}`;
    if (!config.push.times.includes(hhmm)) return;
    const key = `${local.year}-${local.month}-${local.day} ${hhmm}`;
    if (key === this.lastScheduleKey) return;
    this.lastScheduleKey = key;
    await this.trigger(`schedule:${hhmm}`);
  }

  async trigger(reason = 'manual', options = {}) {
    if (this.inFlight) return { ok: false, skipped: 'in_flight' };
    this.inFlight = true;
    try {
      const ctx = pushContext(config.push.sessionId);
      const decision = options.force ? { yes: true, reason: 'force' } : await shouldPush(ctx, reason);
      if (!decision.yes) {
        this.lastResult = { ok: true, pushed: false, decision, at: Date.now() };
        return this.lastResult;
      }
      const text = await generateKeepalive(ctx, reason);
      const id = insertMessage({
        sessionId: config.push.sessionId,
        source: 'keepalive',
        role: 'assistant',
        content: text,
        model: config.push.model,
        meta: { reason, decision }
      });
      const push = await notifyAll(text);
      this.lastResult = { ok: true, pushed: true, id, push, at: Date.now(), text };
      return this.lastResult;
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = { PushAgent };
