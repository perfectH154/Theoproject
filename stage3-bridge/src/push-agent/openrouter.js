const config = require('../config');

async function chatCompletion({ system, messages, maxTokens, temperature }) {
  if (!config.push.openRouterApiKey) {
    throw new Error('OPENROUTER_API_KEY 未配置');
  }
  const url = `${config.push.openRouterBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model: config.push.model,
    messages: [
      { role: 'system', content: system },
      ...messages
    ],
    max_tokens: maxTokens,
    temperature
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.push.openRouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://theo.cecilexiejiuyuan.xyz',
      'X-Title': 'Theo Companion'
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }
  const data = JSON.parse(text);
  return data.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = { chatCompletion };
