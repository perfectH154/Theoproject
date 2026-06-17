function cleanText(value) {
  return String(value || '').trim();
}

function textPart(content) {
  const text = cleanText(content);
  return text ? { type: 'text', content: text } : null;
}

function thinkingPart(content) {
  const text = cleanText(content);
  return text
    ? {
      type: 'thinking',
      content: text,
      collapsed: true
    }
    : null;
}

function toolPart(item) {
  if (!item || typeof item !== 'object') return null;
  const name = cleanText(item.name || item.tool || item.type || 'tool');
  const content = cleanText(item.content || item.result || item.text || '');
  return name || content ? { type: 'tool', name, content } : null;
}

function partsFromTurnResult(result = {}) {
  const parts = [];
  const thinking = Array.isArray(result.thinking)
    ? result.thinking.map(cleanText).filter(Boolean)
    : [];
  if (thinking.length) {
    const part = thinkingPart(thinking.join('\n\n'));
    if (part) parts.push(part);
  }

  const rawReplies = Array.isArray(result.raw)
    ? result.raw.filter((item) => item && item.type === 'reply')
    : [];
  for (const reply of rawReplies) {
    const segments = Array.isArray(reply.segments) && reply.segments.length
      ? reply.segments
      : [reply.text];
    for (const segment of segments) {
      const part = textPart(segment);
      if (part) parts.push(part);
    }
  }

  if (!parts.some((part) => part.type === 'text')) {
    const fallbackText = textPart(result.text);
    if (fallbackText) parts.push(fallbackText);
  }

  const tools = Array.isArray(result.tools) ? result.tools : [];
  for (const tool of tools) {
    const part = toolPart(tool);
    if (part) parts.push(part);
  }

  return parts;
}

module.exports = { partsFromTurnResult };
