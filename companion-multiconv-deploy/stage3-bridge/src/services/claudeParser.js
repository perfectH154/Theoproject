function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.thinking === 'string') return content.thinking;
  if (typeof content.content === 'string') return content.content;
  return JSON.stringify(content);
}

function toolPayload(block) {
  return {
    id: block.id || block.tool_use_id || null,
    name: block.name || block.tool_name || block.type || 'tool_use',
    input: block.input || block.arguments || block.params || null,
    raw: block
  };
}

function normalizeClaudeEvent(event) {
  const out = [];
  if (!event || typeof event !== 'object') return out;

  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === 'text') {
        out.push({ type: 'text', content: contentToText(block), meta: { rawType: block.type } });
      } else if (block.type === 'thinking') {
        out.push({ type: 'thinking', content: contentToText(block), meta: { rawType: block.type } });
      } else if (block.type === 'tool_use') {
        out.push({ type: 'tool_use', content: block.name || 'tool_use', meta: toolPayload(block) });
      } else {
        out.push({ type: 'status', content: block.type || 'assistant_content', meta: { raw: block } });
      }
    }
    return out;
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta || {};
    if (delta.type === 'text_delta' && delta.text) {
      out.push({ type: 'text', content: delta.text, meta: { rawType: event.type, deltaType: delta.type } });
      return out;
    }
    if (delta.type === 'thinking_delta' || typeof delta.thinking === 'string') {
      const thinking = delta.thinking || delta.text || '';
      if (thinking) out.push({ type: 'thinking', content: thinking, meta: { rawType: event.type, deltaType: delta.type } });
      return out;
    }
    if (delta.type === 'input_json_delta' || typeof delta.partial_json === 'string') {
      out.push({ type: 'status', content: 'tool_input_delta', meta: { rawType: event.type, deltaType: delta.type, partial_json: delta.partial_json || '' } });
      return out;
    }
    return out;
  }

  if (event.type === 'text') {
    const text = event.text || '';
    if (text) out.push({ type: 'text', content: text, meta: { rawType: event.type } });
    return out;
  }

  if (event.type === 'thinking') {
    out.push({ type: 'thinking', content: contentToText(event), meta: { rawType: event.type } });
    return out;
  }

  if (event.type === 'tool_use' || event.type === 'tool_result') {
    const payload = toolPayload(event);
    out.push({ type: 'tool_use', content: payload.name, meta: payload });
    return out;
  }

  if (event.type === 'system' || event.type === 'result') {
    out.push({ type: 'status', content: event.subtype || event.type, meta: { raw: event } });
    return out;
  }

  return out;
}

module.exports = { normalizeClaudeEvent };
