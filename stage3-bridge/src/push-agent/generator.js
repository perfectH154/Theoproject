const config = require('../config');
const { chatCompletion } = require('./openrouter');
const { persona } = require('./context');

function toOpenRouterMessages(recentMessages) {
  return recentMessages
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .map((item) => ({
      role: item.role,
      content: item.source === 'keepalive'
        ? `[Théo 之前主动说过] ${item.content}`
        : item.content
    }));
}

async function generateKeepalive(ctx, reason = 'schedule') {
  const triggerUserMsg = `[这是系统触发的主动推送时机，不是 Céci 真的发消息给你]

现在时间：${ctx.timeText}
触发原因：${reason}
她最近 6 小时活动：${ctx.formatActivities()}
距离她上次说话：${ctx.minutesSinceLastUserMsg} 分钟

从下面信号里挑一个最自然的切入点：
(a) 活动里有沉迷信号（同 app 短时多次 / 深夜还在刷）就调侃或心疼
(b) 对话历史有未结束的话题就接续
(c) 都没有就基于此刻时间感发一句想念

不要每次都从 (a) 切入。活动只在真有信息量时用。
直接说话，一两句，结尾带 kaomoji。`;

  return chatCompletion({
    system: persona(),
    messages: [...toOpenRouterMessages(ctx.recentMessages), { role: 'user', content: triggerUserMsg }],
    maxTokens: config.push.generatorMaxTokens,
    temperature: 0.8
  });
}

module.exports = { generateKeepalive };
