const fs = require('node:fs');
const config = require('../config');
const {
  getRecentConversation,
  getRecentActivities,
  getLastUserMessage,
  getLastKeepalive
} = require('../db');

let cachedPersona = null;

function persona() {
  if (cachedPersona !== null) return cachedPersona;
  cachedPersona = fs.readFileSync(config.push.personaPath, 'utf-8');
  return cachedPersona;
}

function formatTime(ts) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.push.timezone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(ts));
}

function formatActivities(activities) {
  if (!activities.length) return '无';
  return activities.map((item) => `${formatTime(item.created_at)} ${item.type}:${item.value || ''}`).join('；');
}

function minutesSince(ts) {
  if (!ts) return 99999;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

function pushContext(sessionId) {
  const now = Date.now();
  const lastUser = getLastUserMessage(sessionId);
  const lastKeepalive = getLastKeepalive(sessionId);
  const recentActivities = getRecentActivities(now - 6 * 3600 * 1000, 10);
  const recentMessages = getRecentConversation(sessionId, 20);
  return {
    now,
    timeText: formatTime(now),
    lastUser,
    lastKeepalive,
    recentActivities,
    recentMessages,
    minutesSinceLastUserMsg: minutesSince(lastUser?.ts),
    minutesSinceLastKeepalive: minutesSince(lastKeepalive?.ts),
    formatActivities: () => formatActivities(recentActivities)
  };
}

module.exports = { persona, pushContext, formatActivities, minutesSince };
