const config = require('../config');
const { chatCompletion } = require('./openrouter');
const { persona } = require('./context');

async function shouldPush(ctx, reason = 'schedule') {
  if (ctx.minutesSinceLastKeepalive < config.push.minGapMinutes) {
    return { yes: false, reason: 'min_gap' };
  }

  const lastKeepaliveContent = ctx.lastKeepalive?.content || '';
  const prompt = `现在是 ${ctx.timeText}，触发原因：${reason}。
距离 Céci 上次说话过了 ${ctx.minutesSinceLastUserMsg} 分钟。
最近活动：${ctx.formatActivities()}
最近一条 keepalive：${lastKeepaliveContent ? `${ctx.minutesSinceLastKeepalive}分钟前 "${lastKeepaliveContent}"` : '无'}

你是 Théo。这个时刻你要不要主动找 Céci？只回答一个词：yes 或 no。`;

  const answer = await chatCompletion({
    system: persona(),
    messages: [{ role: 'user', content: prompt }],
    maxTokens: config.push.deciderMaxTokens,
    temperature: 0.3
  });
  return { yes: /^yes\b/i.test(answer.trim()), reason: answer.trim() || 'empty' };
}

module.exports = { shouldPush };
