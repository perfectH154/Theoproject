const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const logger = require('../logger');
const { ensureDir } = require('../utils/fs');
const { persona, pushContext } = require('../push-agent/context');
const { chatCompletion } = require('../push-agent/openrouter');
const { callOmbreTool } = require('./mcpHttp');

const DASH_DIR = path.join(config.dataDir, 'dash');
const MORNING_LINE_CACHE = path.join(DASH_DIR, 'morning-line.json');

function localDateParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.push.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
}

function localDateKey(date = new Date()) {
  const parts = localDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function ombreTextOf(payload) {
  const result = payload?.result?.result || payload?.result;
  if (typeof result?.structuredContent?.result === 'string') return result.structuredContent.result;
  return (result?.content || []).map((item) => item?.text || '').filter(Boolean).join('\n');
}

function clip(text, max = 2200) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function cleanMorningLine(text) {
  const value = String(text || '').trim();
  if (!value) return '';

  const unwrapped = value
    .replace(/^["'\u201c\u201d\u300c\u300d]+|["'\u201c\u201d\u300c\u300d]+$/g, '')
    .trim();

  const lines = unwrapped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(理由|说明|注释|分析|语气|场景|推送理由)[:：]/i.test(line))
    .filter((line) => !/(不要输出|只输出|请写|生成原因|最近记忆浮现|最近对话)/.test(line));

  const merged = lines.join('\n').trim();
  return clip(merged || unwrapped, 180);
}

function dateStatusString(value) {
  if (!value) return '';
  const base = new Date(`${value}T00:00:00+08:00`);
  if (Number.isNaN(base.getTime())) return '';
  return value;
}

function relationshipMeta() {
  return {
    theoSinceDate: dateStatusString(config.dash.theoSinceDate),
    theoMarriedDate: dateStatusString(config.dash.theoMarriedDate),
    timezone: config.push.timezone
  };
}

async function generateMorningLine(reason = 'dash_api') {
  const ctx = pushContext(config.push.sessionId);
  let pulseText = '';
  try {
    const pulse = await callOmbreTool('MCP_OMBRE_PULSE', { include_archive: false }, { reason: 'dash_morning_line' });
    pulseText = clip(ombreTextOf(pulse), 1800);
  } catch (error) {
    logger.warn('dash morning line pulse failed', { message: error.message });
  }

  const recentMessages = ctx.recentMessages
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'Ceci' : 'Theo'}: ${item.content}`)
    .join('\n');

  const prompt = [
    '[这是 Dash 顶部的「今天 Theo 想对我说的话」小组件。]',
    `今天日期：${localDateKey()}`,
    `生成原因：${reason}`,
    pulseText ? `最近记忆浮现：\n${pulseText}` : '最近记忆浮现：无',
    recentMessages ? `最近对话：\n${clip(recentMessages, 1200)}` : '最近对话：无',
    '请直接写 1 到 2 句 Theo 真正会发给 Ceci 的话，要像私聊，不像提纲。',
    '只输出最后给用户看的正文，不要分析，不要解释，不要写创作理由，不要第三人称旁白，不要出现“语气要”“推送理由”“她怎样”这种说明句。',
    '可以温柔、亲密、简短，像一句早安、想念、提醒休息的话。',
    '输出时请只给正文本身，最好放进一对中文引号里。'
  ].join('\n\n');

  const text = await chatCompletion({
    system: persona(),
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 120,
    temperature: 0.8
  });

  return cleanMorningLine(text);
}

async function getMorningLine(options = {}) {
  const dateKey = localDateKey();
  const cached = readJson(MORNING_LINE_CACHE, null);
  if (!options.force && cached?.dateKey === dateKey && cached?.text) {
    return { ...cached, cached: true };
  }

  const text = await generateMorningLine(options.reason || 'dash_api');
  const payload = {
    dateKey,
    text,
    model: config.push.model,
    generatedAt: Date.now()
  };
  writeJson(MORNING_LINE_CACHE, payload);
  return { ...payload, cached: false };
}

async function primeMorningLineIfNeeded(now = new Date()) {
  const hourMinute = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.push.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);
  if (hourMinute !== '08:00') return null;
  try {
    return await getMorningLine({ reason: 'scheduled_0800' });
  } catch (error) {
    logger.warn('dash morning line prime failed', { message: error.message });
    return null;
  }
}

module.exports = {
  relationshipMeta,
  getMorningLine,
  primeMorningLineIfNeeded
};
