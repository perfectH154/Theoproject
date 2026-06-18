import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowLeft,
  BookOpen,
  Brain,
  ChevronDown,
  Code2,
  Clock3,
  Eye,
  FileText,
  HeartPulse,
  LayoutDashboard,
  Loader2,
  Maximize2,
  Menu,
  MemoryStick,
  MessageCircle,
  Paperclip,
  Pencil,
  PlugZap,
  Plus,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  Volume2,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload, importEpub, wsUrl } from './lib/api';
import {
  loadConversationMessages,
  loadSettings,
  saveConversationMessages,
  saveSettings
} from './lib/storage';
import { WebSocketManager } from './lib/WebSocketManager';
import './styles.css';

const tabs = [
  { id: 'dash', label: 'dash', icon: LayoutDashboard },
  { id: 'chat', label: 'chat', icon: HeartPulse },
  { id: 'read', label: 'read', icon: BookOpen },
  { id: 'memory', label: 'memory', icon: Brain }
];

const modelChoices = [
  { value: '', label: 'Server default (bridge.env / Claude Code default)' },
  { value: 'opus', label: 'Claude Opus 4.7 / latest (alias: opus)' },
  { value: 'sonnet', label: 'Claude Sonnet 4.6 (alias: sonnet)' },
  { value: 'haiku', label: 'Claude Haiku 4.5 (alias: haiku)' },
  { value: '__custom', label: 'Custom model ID' }
];

const builtInModelValues = new Set(modelChoices.map((item) => item.value));
const typingSpeedOptions = [
  { value: 'slow', label: 'slow', delay: 70, take: 1 },
  { value: 'normal', label: 'normal', delay: 40, take: 2 },
  { value: 'fast', label: 'fast', delay: 24, take: 3 },
  { value: 'instant', label: 'instant', delay: 0, take: 999 }
];

function getTypingSpeed(value) {
  return typingSpeedOptions.find((item) => item.value === value) || typingSpeedOptions[1];
}

function nowId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatClock(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(ts));
}

function isSameCalendarDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function formatDayDivider(ts) {
  const date = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const value = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (value === today) return '今天';
  if (value === today - 86400000) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function createTextPart(content, extra = {}) {
  return {
    id: extra.id || `text-${nowId()}`,
    type: 'text',
    content: String(content || '')
  };
}

function createThinkingPart(content, extra = {}) {
  return {
    id: extra.id || `thinking-${nowId()}`,
    type: 'thinking',
    content: String(content || ''),
    collapsed: typeof extra.collapsed === 'boolean' ? extra.collapsed : true,
    placeholder: Boolean(extra.placeholder || extra.hidden),
    startedAt: extra.startedAt,
    endedAt: extra.endedAt
  };
}

function createToolPart(part = {}, extra = {}) {
  return {
    id: part.id || extra.id || `tool-${nowId()}`,
    type: 'tool',
    name: part.name || part.tool_name || extra.name || '',
    content: part.content || extra.content || ''
  };
}

function normalizePart(part, index = 0) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'thinking') {
    return createThinkingPart(part.content ?? part.thinking ?? '', {
      id: part.id || `thinking-${index}-${nowId()}`,
      collapsed: part.collapsed,
      placeholder: part.placeholder,
      hidden: part.hidden,
      startedAt: part.startedAt,
      endedAt: part.endedAt
    });
  }
  if (part.type === 'tool' || part.type === 'tool_use' || part.type === 'tool_result') {
    return createToolPart(part, { id: part.id || `tool-${index}-${nowId()}` });
  }
  const text = typeof part.content === 'string' ? part.content : typeof part.text === 'string' ? part.text : '';
  return createTextPart(text, { id: part.id || `text-${index}-${nowId()}` });
}

function normalizeStructuredParts(parts, fallbackContent = '') {
  const normalized = Array.isArray(parts)
    ? parts.map((part, index) => normalizePart(part, index)).filter(Boolean)
    : [];
  if (normalized.length) return normalized;
  if (String(fallbackContent || '').length) return [createTextPart(fallbackContent)];
  return [];
}

function textContentFromParts(parts) {
  return normalizeStructuredParts(parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .filter(Boolean)
    .join('\n');
}

function deriveMessageRole(message) {
  if (message?.role) return message.role;
  if (message?.type === 'user') return 'user';
  if (message?.type === 'system' || message?.type === 'mcp_approval') return 'system';
  return 'assistant';
}

function syncMessageContent(message) {
  if (!message || !message.parts) return message;
  return {
    ...message,
    content: textContentFromParts(message.parts)
  };
}

function chatSpeaker(message) {
  const role = deriveMessageRole(message);
  if (role === 'user') return 'me';
  if (role === 'assistant' || message?.type === 'audio') return 'theo';
  return '';
}

function isBubbleLikeMessage(message) {
  if (message?.type === 'audio') return true;
  return deriveMessageRole(message) === 'user' || deriveMessageRole(message) === 'assistant';
}

function hasMeaningfulPartContent(part) {
  if (!part || typeof part !== 'object') return false;
  if (part.type === 'thinking') {
    return Boolean(String(part.content || '').trim());
  }
  if (part.type === 'tool') {
    return Boolean(String(part.name || '').trim() || String(part.content || '').trim());
  }
  return Boolean(String(part.content || part.text || '').trim());
}

function isEmptyAssistantShell(message) {
  if (!message || deriveMessageRole(message) !== 'assistant') return false;
  if (message.type === 'typing_indicator' || message.type === 'audio') return false;
  if (message.meta?.streamingTurn || message.meta?.typing || message.meta?.pending) return false;

  const content = String(message.content || '').trim();
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const hasMeaningfulParts = parts.some((part) => hasMeaningfulPartContent(part));
  return !content && !hasMeaningfulParts;
}

function closeThinkingAndStopStreaming(message, reason = 'stopped') {
  if (!message || deriveMessageRole(message) !== 'assistant') return message;
  const next = closeOpenThinkingParts(message);
  return createStructuredMessage(next, {
    meta: {
      ...(next.meta || {}),
      streamingTurn: false,
      typing: false,
      pending: false,
      stopped: reason === 'stopped' || reason === 'abort' || reason === 'timeout' || reason === 'network',
      failed: reason === 'error' || reason === 'timeout' || reason === 'network',
      stopReason: reason
    }
  });
}

function expireStaleStreamingMessages(messages, now = Date.now()) {
  return messages
    .map((message) => {
      if (!message || deriveMessageRole(message) !== 'assistant') return message;
      const age = now - Number(message.ts || message.meta?.startedAt || 0);
      const hasOpenThinking = normalizeStructuredParts(message.parts, message.content)
        .some((part) => part.type === 'thinking' && !part.endedAt);
      if (age <= 2 * 60 * 1000 || (!message.meta?.streamingTurn && !message.meta?.typing && !hasOpenThinking)) {
        return message;
      }
      return closeThinkingAndStopStreaming(message, 'stale');
    })
    .filter((message) => !isEmptyAssistantShell(message));
}

function buildTimelineEntries(message) {
  if (!message) return [];
  if (message.type === 'typing_indicator' || message.type === 'mcp_approval' || message.type === 'audio') {
    return [{
      kind: 'message',
      id: message.id,
      message,
      part: null,
      bubbleLike: isBubbleLikeMessage(message),
      speaker: chatSpeaker(message),
      showKicker: Boolean(message.meta?.keepalive)
    }];
  }

  const parts = normalizeStructuredParts(message.parts, message.content);
  if (!parts.length) {
    return [{
      kind: 'message',
      id: message.id,
      message,
      part: null,
      bubbleLike: isBubbleLikeMessage(message),
      speaker: chatSpeaker(message),
      showKicker: Boolean(message.meta?.keepalive)
    }];
  }

  return parts.map((part, index) => ({
    kind: 'message',
    id: `${message.id}-${part.id || index}`,
    message,
    part,
    partIndex: index,
    partCount: parts.length,
    bubbleLike: part.type === 'text' && isBubbleLikeMessage(message),
    speaker: part.type === 'text' ? chatSpeaker(message) : '',
    showKicker: index === 0 && Boolean(message.meta?.keepalive)
  }));
}

function buildChatTimeline(messages) {
  const timeline = [];
  let previousTimed = null;

  messages
    .filter((message) => !isEmptyAssistantShell(message))
    .forEach((message) => {
    if (message?.ts) {
      if (!previousTimed || !isSameCalendarDay(previousTimed.ts, message.ts)) {
        timeline.push({ kind: 'day', id: `day-${message.id}`, label: formatDayDivider(message.ts) });
      } else if (message.ts - previousTimed.ts >= 5 * 60 * 1000) {
        timeline.push({ kind: 'time', id: `time-${message.id}`, label: formatClock(message.ts) });
      }
      previousTimed = message;
    }
    timeline.push(...buildTimelineEntries(message));
    });

  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item.kind !== 'message' || !item.bubbleLike) continue;
    const nextBubble = timeline.slice(index + 1).find((candidate) => candidate.kind === 'message' && candidate.bubbleLike);
    const closeEnough = nextBubble?.message?.ts && item.message?.ts && nextBubble.message.ts - item.message.ts < 5 * 60 * 1000;
    item.showTime = !(nextBubble && item.speaker && item.speaker === nextBubble.speaker && closeEnough);
  }

  return timeline;
}

function parseIsoDateStart(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatElapsedParts(fromDate, nowTs = Date.now()) {
  if (!(fromDate instanceof Date)) return { totalSeconds: 0, label: '0 秒', days: 0 };
  const diffSeconds = Math.max(0, Math.floor((nowTs - fromDate.getTime()) / 1000));
  const days = Math.floor(diffSeconds / 86400);
  const hours = Math.floor((diffSeconds % 86400) / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  const seconds = diffSeconds % 60;
  return {
    totalSeconds: diffSeconds,
    days,
    label: `${days} 天 ${String(hours).padStart(2, '0')} : ${String(minutes).padStart(2, '0')} : ${String(seconds).padStart(2, '0')}`
  };
}

function shortText(value, max = 92) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentUrl(settings, attachment) {
  if (attachment?.previewUrl) return attachment.previewUrl;
  if (!attachment?.url) return '';
  const base = String(settings.serverUrl || window.location.origin).replace(/\/$/, '');
  const url = new URL(attachment.url, base);
  if (settings.token) url.searchParams.set('token', settings.token);
  return url.toString();
}

function isImageAttachment(file) {
  return String(file?.mime || file?.type || '').startsWith('image/');
}

function attachmentTitle(file) {
  return file?.originalName || file?.name || file?.filename || 'attachment';
}

function localAttachmentFromFile(file) {
  const isImage = String(file.type || '').startsWith('image/');
  return {
    id: `local-${nowId()}`,
    local: true,
    status: 'uploading',
    name: file.name,
    originalName: file.name,
    type: isImage ? 'image' : 'document',
    mime: file.type || 'application/octet-stream',
    size: file.size,
    previewUrl: isImage ? URL.createObjectURL(file) : '',
    error: ''
  };
}

function cleanupAttachmentPreview(file) {
  if (file?.local && file?.previewUrl) {
    URL.revokeObjectURL(file.previewUrl);
  }
}

function parseFencedContent(content) {
  const text = String(content || '');
  const parts = [];
  const fence = /```([a-zA-Z0-9_-]+)?[ \t]*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fence.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    parts.push({
      type: 'code',
      lang: String(match[1] || '').toLowerCase(),
      code: match[2].replace(/\n$/, '')
    });
    lastIndex = fence.lastIndex;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', text: text.slice(lastIndex) });
  return parts.length ? parts : [{ type: 'text', text }];
}

function previewSrcDoc(lang, code) {
  if (lang === 'svg') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;display:grid;place-items:center;background:#fff7f9;color:#5f4b50}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
  }
  return code;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function blockText(block) {
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  return '';
}

function partsFromBlocks(blocks, options = {}) {
  const out = [];
  blocks.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'thinking') {
      if (!options.showThinking) return;
      const text = block.thinking || blockText(block);
      const placeholder = !text && Boolean(block.signature || block.placeholder || block.hidden);
      if (text || placeholder) {
        out.push(createThinkingPart(text, {
          id: block.id || `thinking-${index}-${nowId()}`,
          placeholder,
          hidden: placeholder,
          collapsed: true
        }));
      }
      return;
    }
    if (block.type === 'tool_use' || block.type === 'tool_result') {
      out.push(createToolPart(block, { id: block.id || `tool-${index}-${nowId()}` }));
      return;
    }
    const text = blockText(block);
    if (text) out.push(createTextPart(text, { id: block.id || `text-${index}-${nowId()}` }));
  });
  return out;
}

function createStructuredMessage(base, extra = {}) {
  const type = extra.type || base.type || 'assistant';
  const role = extra.role || deriveMessageRole({ ...base, type });
  const parts = normalizeStructuredParts(extra.parts, extra.content ?? base.content ?? '');
  return syncMessageContent({
    ...base,
    ...extra,
    type,
    role,
    parts,
    attachments: extra.attachments ?? base.attachments ?? [],
    meta: { ...(base.meta || {}), ...(extra.meta || {}) }
  });
}

function messageStorageKey(message) {
  const dbId = Number(message?.meta?.db_id);
  if (Number.isFinite(dbId) && dbId > 0) return `db:${dbId}`;
  return `id:${message?.id || nowId()}`;
}

function findCachedMessageForHistoryRow(row, cachedMessagesByKey = new Map(), cachedMessages = [], usedCacheKeys = new Set()) {
  const exactKey = `db:${row.id}`;
  const exact = cachedMessagesByKey.get(exactKey);
  if (exact && !usedCacheKeys.has(exactKey)) {
    return { key: exactKey, message: exact };
  }

  const roleType = row.role === 'user' ? 'user' : 'assistant';
  const rowText = String(row.content || '').trim().replace(/\s+/g, ' ');
  if (!rowText) return null;

  const candidates = cachedMessages.filter((message) => {
    const key = messageStorageKey(message);
    if (usedCacheKeys.has(key) || key === exactKey) return false;
    if (deriveMessageRole(message) !== roleType) return false;

    const parts = normalizeStructuredParts(message.parts, message.content);
    if (!parts.length || !parts.some((part) => part.type !== 'text')) return false;

    const cachedText = String(textContentFromParts(parts) || message.content || '').trim().replace(/\s+/g, ' ');
    if (!cachedText || cachedText !== rowText) return false;

    if (Number.isFinite(row.ts) && Number.isFinite(message.ts) && Math.abs(message.ts - row.ts) > 30 * 1000) {
      return false;
    }

    return true;
  });

  if (candidates.length !== 1) return null;
  const match = candidates[0];
  return {
    key: messageStorageKey(match),
    message: match
  };
}

function toStoredMessage(message) {
  const parts = normalizeStructuredParts(message.parts, message.content).map((part) => {
    if (part.type === 'thinking') {
      return {
        id: part.id,
        type: 'thinking',
        content: part.content,
        collapsed: Boolean(part.collapsed),
        startedAt: part.startedAt,
        endedAt: part.endedAt,
        placeholder: Boolean(part.placeholder)
      };
    }
    if (part.type === 'tool') {
      return {
        id: part.id,
        type: 'tool',
        name: part.name || '',
        content: part.content || ''
      };
    }
    return {
      id: part.id,
      type: 'text',
      content: part.content || ''
    };
  });
  return {
    id: message.id,
    type: message.type,
    role: deriveMessageRole(message),
    content: message.content || textContentFromParts(parts),
    parts,
    ts: message.ts,
    meta: message.meta || {},
    attachments: message.attachments || []
  };
}

function restoreStoredMessage(message) {
  return createStructuredMessage({
    id: message.id,
    ts: message.ts,
    meta: message.meta || {},
    attachments: message.attachments || [],
    content: message.content || ''
  }, {
    type: message.type || message.role || 'assistant',
    role: message.role || deriveMessageRole(message),
    parts: message.parts
  });
}

function normalizeMessage(raw, options = {}) {
  const base = {
    id: raw.id || nowId(),
    ts: raw.ts || Date.now(),
    meta: raw.meta || {},
    attachments: raw.attachments || raw.meta?.attachments || []
  };
  if (raw.approvalRequired || raw.type === 'mcp_approval') {
    return {
      ...base,
      type: 'mcp_approval',
      role: 'system',
      content: raw.content || raw.error || 'MCP tool needs approval.',
      meta: { ...base.meta, tool: raw.tool || raw.meta?.tool || raw.toolName }
    };
  }

  if (raw.type === 'thinking') {
    if (!options.showThinking) return null;
    const thinkingText = typeof raw.content === 'string' ? raw.content : raw.content?.thinking || '';
    const placeholder = Boolean(raw.meta?.placeholder || raw.meta?.hidden || raw.placeholder);
    return (thinkingText || placeholder)
      ? createStructuredMessage(base, {
        type: 'assistant',
        role: 'assistant',
        parts: [createThinkingPart(thinkingText, {
          placeholder,
          hidden: placeholder && !thinkingText,
          collapsed: true,
          startedAt: Date.now()
        })],
        meta: { ...base.meta, hidden: placeholder && !thinkingText, placeholder, streamingPartType: 'thinking' }
      })
      : null;
  }

  if (raw.type === 'thinking_chunk') {
    if (!options.showThinking) return null;
    const thinkingText = typeof raw.content === 'string' ? raw.content : '';
    const placeholder = Boolean(raw.meta?.hidden);
    if (!thinkingText && !placeholder) return null;
    return createStructuredMessage(base, {
      type: 'assistant',
      role: 'assistant',
      parts: [createThinkingPart(thinkingText, {
        placeholder,
        hidden: placeholder,
        collapsed: true,
        startedAt: Date.now()
      })],
      meta: { ...base.meta, streaming: true, hidden: placeholder, streamingPartType: 'thinking' }
    });
  }

  if (raw.type === 'thinking_complete') {
    return {
      ...base,
      type: 'thinking_complete',
      role: 'assistant',
      content: '',
      meta: { ...base.meta, streamComplete: true }
    };
  }

  if (raw.type === 'tool_use' || raw.type === 'tool_result' || raw.type === 'audio') {
    if (raw.type === 'audio') {
      return { ...base, type: 'audio', role: 'assistant', content: raw.content || raw.name || raw.type };
    }
    return createStructuredMessage(base, {
      type: 'assistant',
      role: 'assistant',
      parts: [createToolPart({ name: raw.name || raw.type, content: raw.content || '' })],
      meta: { ...base.meta, rawType: raw.type }
    });
  }

  const serverParts = Array.isArray(raw.parts)
    ? raw.parts
    : (Array.isArray(raw.meta?.parts) ? raw.meta.parts : null);
  if (serverParts) {
    return createStructuredMessage(base, {
      type: raw.type === 'text' ? 'assistant' : (raw.type || 'assistant'),
      role: raw.type === 'user' ? 'user' : 'assistant',
      parts: normalizeStructuredParts(serverParts, raw.content),
      meta: { ...base.meta, serverParts: true }
    });
  }

  const parsed = tryParseJson(raw.content);
  if (Array.isArray(raw.blocks)) {
    return createStructuredMessage(base, {
      type: raw.type === 'text' ? 'assistant' : (raw.type || 'assistant'),
      role: raw.type === 'user' ? 'user' : 'assistant',
      parts: partsFromBlocks(raw.blocks, options),
      meta: { ...base.meta, blocks: raw.blocks }
    });
  }

  if (Array.isArray(parsed)) {
    return createStructuredMessage(base, {
      type: raw.type === 'text' ? 'assistant' : (raw.type || 'assistant'),
      role: raw.type === 'user' ? 'user' : 'assistant',
      parts: partsFromBlocks(parsed, options),
      meta: { ...base.meta, rawContent: raw.content }
    });
  }

  if (parsed && typeof parsed === 'object') {
    if (parsed.type === 'thinking') {
      if (!options.showThinking) return null;
      const thinkingText = parsed.thinking || blockText(parsed);
      const placeholder = !thinkingText && Boolean(parsed.signature || parsed.placeholder || parsed.hidden);
      return (thinkingText || placeholder)
        ? createStructuredMessage(base, {
          type: 'assistant',
          role: 'assistant',
          parts: [createThinkingPart(thinkingText, {
            placeholder,
            hidden: placeholder,
            collapsed: true,
            startedAt: Date.now()
          })],
          meta: { ...base.meta, hidden: placeholder, placeholder, streamingPartType: 'thinking' }
        })
        : null;
    }

    if (Array.isArray(parsed.content)) {
      return createStructuredMessage(base, {
        type: raw.type === 'text' ? 'assistant' : (raw.type || 'assistant'),
        role: raw.type === 'user' ? 'user' : 'assistant',
        parts: partsFromBlocks(parsed.content, options),
        meta: { ...base.meta, rawContent: raw.content }
      });
    }

    if (parsed.type === 'text') {
      const parsedText = blockText(parsed);
      return parsedText
        ? createStructuredMessage(base, {
          type: raw.type === 'text' ? 'assistant' : (raw.type || 'assistant'),
          role: raw.type === 'user' ? 'user' : 'assistant',
          parts: [createTextPart(parsedText)]
        })
        : null;
    }

    if (parsed.type === 'tool_use' || parsed.type === 'tool_result') {
      return createStructuredMessage(base, {
        type: 'assistant',
        role: 'assistant',
        parts: [createToolPart(parsed)],
        meta: { ...base.meta, raw: parsed }
      });
    }
  }

  const content = typeof raw.content === 'string' ? raw.content : String(raw.content || '');
  if (!content.trim()) return null;
  return createStructuredMessage(base, {
    type: raw.type === 'text' ? 'assistant' : (raw.type || 'assistant'),
    role: raw.type === 'user' ? 'user' : 'assistant',
    parts: [createTextPart(content)]
  });
}

function normalizeHistoryMessage(row, options = {}, cachedMessagesByKey = new Map(), cachedMessages = [], usedCacheKeys = new Set()) {
  const roleType = row.role === 'user' ? 'user' : 'assistant';
  const normalized = normalizeMessage({
    id: `db-${row.id}`,
    type: roleType,
    content: row.content,
    meta: { ...(row.meta || {}), db_id: row.id },
    attachments: row.attachments || row.meta?.attachments || [],
    ts: row.ts
  }, options) || createStructuredMessage({
    id: `db-${row.id}`,
    ts: row.ts,
    meta: { ...(row.meta || {}), db_id: row.id },
    attachments: row.attachments || row.meta?.attachments || []
  }, {
    type: roleType,
    role: roleType,
    parts: row.content ? [createTextPart(row.content)] : []
  });

  const serverPartsSource = Array.isArray(row.parts)
    ? row.parts
    : (Array.isArray(row.meta?.parts) ? row.meta.parts : null);
  let parts = serverPartsSource
    ? normalizeStructuredParts(serverPartsSource, row.content)
    : normalizeStructuredParts(normalized.parts, normalized.content);
  if (serverPartsSource) {
    return createStructuredMessage(normalized, {
      parts,
      meta: { ...(normalized.meta || {}), db_id: row.id }
    });
  }

  if (options.showThinking && roleType === 'assistant' && Array.isArray(row.meta?.thinking)) {
    const thinking = row.meta.thinking
      .filter((item) => item && item !== 'Theo is thinking...')
      .join('\n');
    if (thinking && !parts.some((part) => part.type === 'thinking')) {
      parts = [createThinkingPart(thinking, { collapsed: true }), ...parts];
    }
  }

  const cachedMatch = findCachedMessageForHistoryRow(row, cachedMessagesByKey, cachedMessages, usedCacheKeys);
  const cached = cachedMatch?.message;
  if (cached?.parts?.length) {
    const cachedParts = normalizeStructuredParts(cached.parts, cached.content);
    const incomingText = textContentFromParts(parts).trim();
    const cachedText = textContentFromParts(cachedParts).trim();
    if (!incomingText || incomingText === cachedText) {
      if (cachedMatch?.key) usedCacheKeys.add(cachedMatch.key);
      return createStructuredMessage(normalized, {
        parts: cachedParts,
        meta: { ...(normalized.meta || {}), db_id: row.id }
      });
    }
  }

  return createStructuredMessage(normalized, { parts });
}

function closeOpenThinkingParts(message, endedAt = Date.now()) {
  const parts = normalizeStructuredParts(message.parts, message.content);
  let changed = false;
  const nextParts = parts.map((part) => {
    if (part.type !== 'thinking' || part.endedAt) return part;
    changed = true;
    return { ...part, endedAt };
  });
  return changed ? createStructuredMessage(message, { parts: nextParts }) : message;
}

function updateStructuredPart(message, partId, updater) {
  const parts = normalizeStructuredParts(message.parts, message.content);
  let changed = false;
  const nextParts = parts.map((part) => {
    if (part.id !== partId) return part;
    changed = true;
    return normalizePart(updater(part)) || part;
  });
  return changed ? createStructuredMessage(message, { parts: nextParts }) : message;
}

function mergeIncomingMessage(prevMessages, incoming, activeConversationId) {
  if (!incoming) return prevMessages;

  if (incoming.type === 'thinking_complete') {
    const next = [...prevMessages];
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const message = next[index];
      if (message.type === 'assistant' && message.meta?.streamingTurn && (message.meta?.conversation_id || activeConversationId) === (incoming.meta?.conversation_id || activeConversationId)) {
        next[index] = createStructuredMessage(closeOpenThinkingParts(message), {
          meta: { ...message.meta, streamingTurn: false, typing: false }
        });
        break;
      }
    }
    return next;
  }

  if (incoming.type === 'typing_indicator' || incoming.type === 'mcp_approval' || incoming.type === 'audio') {
    return [
      ...prevMessages.filter((message) => message.type !== 'typing_indicator'),
      incoming
    ];
  }

  if (incoming.type !== 'assistant') {
    return [
      ...prevMessages.filter((message) => message.type !== 'typing_indicator'),
      incoming
    ];
  }

  const incomingParts = normalizeStructuredParts(incoming.parts, incoming.content);
  const next = prevMessages.filter((message) => message.type !== 'typing_indicator');
  const conversationId = incoming.meta?.conversation_id || activeConversationId;
  let targetIndex = -1;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const message = next[index];
    if (message.type === 'assistant' && message.meta?.streamingTurn && (message.meta?.conversation_id || activeConversationId) === conversationId) {
      targetIndex = index;
      break;
    }
  }

  if (targetIndex === -1) {
    next.push(createStructuredMessage(incoming, {
      type: 'assistant',
      role: 'assistant',
      parts: incomingParts,
      meta: { ...incoming.meta, streamingTurn: !incoming.meta?.streamComplete }
    }));
    return next;
  }

  const target = next[targetIndex];
  let parts = normalizeStructuredParts(target.parts, target.content);
  incomingParts.forEach((part) => {
    if (part.type === 'thinking') {
      const lastPart = parts[parts.length - 1];
      if (lastPart?.type === 'thinking' && !lastPart.endedAt) {
        parts[parts.length - 1] = {
          ...lastPart,
          content: `${lastPart.content || ''}${part.content || ''}`,
          placeholder: Boolean(lastPart.placeholder && !part.content && !lastPart.content)
        };
      } else {
        parts.push(part);
      }
      return;
    }
    if (part.type === 'text') {
      parts = parts.map((existing) => (
        existing.type === 'thinking' && !existing.endedAt
          ? { ...existing, endedAt: Date.now() }
          : existing
      ));
    }
    parts.push(part);
  });

  next[targetIndex] = createStructuredMessage(target, {
    parts,
    meta: {
      ...target.meta,
      ...incoming.meta,
      streamingTurn: !incoming.meta?.streamComplete
    }
  });
  return next;
}

function normalizedMessageText(message) {
  return String(textContentFromParts(normalizeStructuredParts(message?.parts, message?.content)) || message?.content || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function messageDbIdFromMeta(message) {
  const metaId = Number(message?.meta?.db_id);
  if (Number.isFinite(metaId) && metaId > 0) return metaId;
  const idMatch = String(message?.id || '').match(/^db-(\d+)$/);
  return idMatch ? Number(idMatch[1]) : null;
}

function mergeHistoryIntoCurrentMessages(prevMessages, historyMessages) {
  const next = prevMessages.filter((message) => message?.type !== 'typing_indicator');
  const usedHistoryIndexes = new Set();

  historyMessages.forEach((historyMessage, historyIndex) => {
    if (!historyMessage || isEmptyAssistantShell(historyMessage)) return;
    const historyRole = deriveMessageRole(historyMessage);
    const historyDbId = messageDbIdFromMeta(historyMessage);
    const historyText = normalizedMessageText(historyMessage);
    let matchIndex = -1;

    if (historyDbId) {
      matchIndex = next.findIndex((message) => messageDbIdFromMeta(message) === historyDbId);
    }
    if (matchIndex === -1 && historyMessage.id) {
      matchIndex = next.findIndex((message) => message.id === historyMessage.id);
    }
    if (matchIndex === -1 && historyText) {
      matchIndex = next.findIndex((message) => (
        deriveMessageRole(message) === historyRole
        && normalizedMessageText(message) === historyText
      ));
    }
    if (matchIndex === -1 && Number.isFinite(historyMessage.ts)) {
      matchIndex = next.findIndex((message) => (
        deriveMessageRole(message) === historyRole
        && Number.isFinite(message.ts)
        && Math.abs(message.ts - historyMessage.ts) <= 30 * 1000
        && (!historyText || !normalizedMessageText(message) || normalizedMessageText(message) === historyText)
      ));
    }

    if (matchIndex === -1) {
      next.push(historyMessage);
      usedHistoryIndexes.add(historyIndex);
      return;
    }

    const current = next[matchIndex];
    const currentParts = normalizeStructuredParts(current.parts, current.content);
    const historyParts = normalizeStructuredParts(historyMessage.parts, historyMessage.content);
    next[matchIndex] = createStructuredMessage(historyMessage, {
      parts: historyParts.length ? historyParts : currentParts,
      meta: { ...(current.meta || {}), ...(historyMessage.meta || {}) },
      attachments: historyMessage.attachments?.length ? historyMessage.attachments : (current.attachments || [])
    });
    usedHistoryIndexes.add(historyIndex);
  });

  return next
    .filter((message) => !isEmptyAssistantShell(message))
    .sort((left, right) => (left.ts || 0) - (right.ts || 0));
}

function sanitizeMessagesForCache(messages) {
  return messages
    .filter((message) => message && message.type !== 'typing_indicator' && !isEmptyAssistantShell(message))
    .map((message) => toStoredMessage(message));
}

function disableAssistantTypewriter() {
  try {
    return localStorage.getItem('debug.disableAssistantTypewriter') === '1';
  } catch {
    return false;
  }
}

function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [tab, setTab] = useState('chat');
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(settings.conversationId || 'default');
  const [showConversations, setShowConversations] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState(null);
  const [showSettings, setShowSettings] = useState(!settings.token);
  const [messageMenu, setMessageMenu] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [error, setError] = useState('');
  const [activeRequest, setActiveRequest] = useState(null);
  const wsRef = useRef(null);
  const listRef = useRef(null);
  const fileInputRef = useRef(null);
  const settingsRef = useRef(settings);
  const activeConversationRef = useRef(activeConversationId);
  const attachmentsRef = useRef(attachments);
  const messagesRef = useRef(messages);
  const typewriterRef = useRef({ queue: [], running: false, runId: 0 });
  const pendingTypewriterJobsRef = useRef([]);
  const cacheSaveTimerRef = useRef(null);
  const historyFallbackTimersRef = useRef([]);
  const skipNextAutoScrollRef = useRef(false);
  const activeRequestRef = useRef(null);

  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    activeConversationRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => {
    attachmentsRef.current.forEach(cleanupAttachmentPreview);
  }, []);

  useEffect(() => {
    const cached = loadConversationMessages(settings.sessionId, activeConversationId);
    if (cached.length) {
      clearTypewriterQueue();
      setMessages(expireStaleStreamingMessages(cached.map((message) => restoreStoredMessage(message))));
    }
  }, [settings.sessionId, activeConversationId]);

  useEffect(() => () => {
    historyFallbackTimersRef.current.forEach((timer) => clearTimeout(timer));
    historyFallbackTimersRef.current = [];
  }, [settings.sessionId, activeConversationId]);

  useEffect(() => {
    clearTimeout(cacheSaveTimerRef.current);
    cacheSaveTimerRef.current = setTimeout(() => {
      const sanitized = sanitizeMessagesForCache(messages);
      saveConversationMessages(settings.sessionId, activeConversationId, sanitized);
    }, 180);
    return () => clearTimeout(cacheSaveTimerRef.current);
  }, [messages, settings.sessionId, activeConversationId]);

  function clearTypewriterQueue() {
    typewriterRef.current.queue = [];
    typewriterRef.current.running = false;
    typewriterRef.current.runId += 1;
  }

  function hasPendingTypewriterForMessage(messageId) {
    return Boolean(messageId && (
      typewriterRef.current.queue.some((item) => item.messageId === messageId)
      || pendingTypewriterJobsRef.current.some((item) => item.messageId === messageId)
    ));
  }

  function enqueueTypewriterJob(job) {
    if (!job?.messageId || !job?.partId || !job.fullText) return;
    const key = `${job.messageId}:${job.partId}:${job.fullText}`;
    if (typewriterRef.current.queue.some((item) => item.key === key)) return;
    typewriterRef.current.queue.push({
      ...job,
      key,
      chars: Array.from(job.fullText),
      index: 0
    });
    pumpTypewriter();
  }

  function flushPendingTypewriterJobs() {
    const jobs = pendingTypewriterJobsRef.current.splice(0);
    jobs.forEach(enqueueTypewriterJob);
  }

  function pumpTypewriter() {
    const state = typewriterRef.current;
    if (state.running || state.queue.length === 0) return;
    const item = state.queue[0];
    const runId = state.runId;
    const speed = getTypingSpeed(settingsRef.current.typingSpeed);

    if (speed.delay === 0) {
      state.queue.shift();
      setMessages((prev) => prev.map((message) => (
        message.id === item.messageId
          ? createStructuredMessage(updateStructuredPart(message, item.partId, (part) => ({
            ...part,
            content: item.fullText
          })), {
            meta: { ...(message.meta || {}), typing: false }
          })
          : message
      )));
      pumpTypewriter();
      return;
    }

    state.running = true;
    const step = () => {
      if (typewriterRef.current.runId !== runId) return;
      const active = typewriterRef.current.queue[0];
      if (!active || active.messageId !== item.messageId || active.partId !== item.partId) {
        typewriterRef.current.running = false;
        pumpTypewriter();
        return;
      }
      console.debug('[typewriter pump]', {
        messageId: active.messageId,
        exists: messagesRef.current?.some((message) => message.id === active.messageId),
        remaining: active.chars.length - active.index
      });
      const chunk = active.chars.slice(active.index, active.index + speed.take).join('');
      active.index += speed.take;
      const done = active.index >= active.chars.length;
      setMessages((prev) => prev.map((message) => (
        message.id === active.messageId
          ? createStructuredMessage(updateStructuredPart(message, active.partId, (part) => ({
            ...part,
            content: `${part.content || ''}${chunk}`
          })), {
            meta: { ...(message.meta || {}), typing: !done }
          })
          : message
      )));
      if (done) {
        typewriterRef.current.queue.shift();
        typewriterRef.current.running = false;
        pumpTypewriter();
        return;
      }
      window.setTimeout(() => window.requestAnimationFrame(step), speed.delay);
    };
    window.setTimeout(() => window.requestAnimationFrame(step), speed.delay);
  }

  function addTypingIndicator(meta = {}) {
    const conversationId = meta.conversation_id || meta.conversationId || activeConversationId;
    setMessages((prev) => {
      const filtered = prev.filter((message) => message.type !== 'typing_indicator');
      return [
        ...filtered,
        {
          id: `typing-${conversationId}-${Date.now()}`,
          type: 'typing_indicator',
          content: '',
          meta,
          ts: Date.now()
        }
      ];
    });
  }

  function appendIncomingMessages(incoming) {
    if (!incoming) return;
    if (incoming.type === 'assistant') {
      const speed = getTypingSpeed(settingsRef.current.typingSpeed);
      const textPart = normalizeStructuredParts(incoming.parts, incoming.content).find((part) => part.type === 'text' && part.content);
      const useTypewriter = Boolean(textPart && speed.delay !== 0 && !disableAssistantTypewriter());
      const preparedIncoming = useTypewriter
        ? createStructuredMessage(incoming, {
          parts: normalizeStructuredParts(incoming.parts, incoming.content).map((part) => (
            part.id === textPart.id ? { ...part, content: '' } : part
          )),
          meta: { ...(incoming.meta || {}), typing: true }
        })
        : incoming;
      setMessages((prev) => {
        const next = mergeIncomingMessage(prev, preparedIncoming, activeConversationId);
        if (useTypewriter) {
          const conversationId = preparedIncoming.meta?.conversation_id || activeConversationId;
          const candidates = [...next].reverse().filter((message) => (
            message.type === 'assistant'
            && (message.meta?.conversation_id || activeConversationId) === conversationId
          ));
          const actualTarget = candidates.find((message) => (
            normalizeStructuredParts(message.parts, message.content).some((part) => part.id === textPart.id)
          ))
            || candidates.find((message) => message.id === preparedIncoming.id)
            || candidates.find((message) => message.meta?.typing)
            || candidates.find((message) => message.meta?.streamingTurn)
            || null;
          const effectiveMessageId = actualTarget?.id || null;
          const existsInNext = Boolean(effectiveMessageId && next.some((message) => message.id === effectiveMessageId));
          console.debug('[appendIncomingMessages]', {
            incomingId: preparedIncoming.id,
            resolvedMessageId: effectiveMessageId,
            existsInNext,
            useTypewriter
          });
          if (!existsInNext) {
            console.warn('[typewriter] resolved missing message id', {
              effectiveMessageId,
              incomingId: preparedIncoming.id
            });
          } else {
            pendingTypewriterJobsRef.current.push({
              messageId: effectiveMessageId,
              partId: textPart.id,
              fullText: textPart.content
            });
          }
        } else {
          console.debug('[appendIncomingMessages]', {
            incomingId: preparedIncoming.id,
            resolvedMessageId: preparedIncoming.id,
            existsInNext: next.some((message) => message.id === preparedIncoming.id),
            useTypewriter
          });
        }
        return next;
      });

      window.setTimeout(flushPendingTypewriterJobs, 0);
      if (payloadDebugEnabled()) {
        console.debug('[appendIncomingMessages:messages]', messagesRef.current.length);
      }
      if (textPart && useTypewriter === false && disableAssistantTypewriter()) {
        console.debug('[appendIncomingMessages] typewriter disabled by debug flag');
      }
      return;
    }

    setMessages((prev) => mergeIncomingMessage(prev, incoming, activeConversationId));
  }

  function payloadDebugEnabled() {
    try {
      return localStorage.getItem('debug.theoVerbose') === '1';
    } catch {
      return false;
    }
  }

  function normalizeHistoryRows(history) {
    const cachedMessages = loadConversationMessages(settings.sessionId, activeConversationId);
    const cachedMap = new Map(cachedMessages.map((message) => [messageStorageKey(message), message]));
    const usedCacheKeys = new Set();
    return history
      .map((message) => normalizeHistoryMessage(
        message,
        { showThinking: settings.showThinking },
        cachedMap,
        cachedMessages,
        usedCacheKeys
      ))
      .filter((message) => !isEmptyAssistantShell(message));
  }

  useEffect(() => {
    setSettings((prev) => (
      prev.conversationId === activeConversationId ? prev : { ...prev, conversationId: activeConversationId }
    ));
  }, [activeConversationId]);

  useEffect(() => {
    if (!settings.token) return;
    let cancelled = false;
    async function loadConversations() {
      try {
        const data = await apiGet(settings.serverUrl, '/api/conversations', settings.token);
        if (cancelled) return;
        const list = data.conversations || [];
        setConversations(list);
        if (!list.some((item) => item.id === activeConversationId)) {
          setActiveConversationId(list[0]?.id || 'default');
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    loadConversations();
    return () => {
      cancelled = true;
    };
  }, [settings.serverUrl, settings.token]);

  useEffect(() => {
    if (!settings.token) return;
    refreshStatus();
  }, [settings.serverUrl, settings.token]);

  useEffect(() => {
    if (!settings.token) return;
    if (wsRef.current) {
      wsRef.current.destroy();
      wsRef.current = null;
    }
    const manager = new WebSocketManager({
      getUrl: () => wsUrl(settings.serverUrl, settings.token, settings.sessionId, activeConversationId),
      onOpen: () => {
        setConnected(true);
        setError('');
        refreshStatus();
      },
      onClose: () => {
        setConnected(false);
        if (activeRequestRef.current) finishChatRequest('network');
      },
      onError: () => {
        setError('WebSocket 连接失败，正在自动重连');
        if (activeRequestRef.current) finishChatRequest('network');
      },
      onMessage: (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'text') {
          console.debug('[ws text]', payload.type, typeof payload.content === 'string' ? payload.content.length : 0);
        }
        if (payload.type === 'status' && payload.content === 'history') {
          const history = payload.meta.messages || [];
          const historyMessages = normalizeHistoryRows(history);
          setMessages((prev) => mergeHistoryIntoCurrentMessages(prev, historyMessages));
          return;
        }
        if (payload.type === 'typing_indicator') {
          addTypingIndicator(payload.meta || {});
          return;
        }
        if (payload.type === 'status') {
          if (payload.content === 'pong') return;
          if (payload.content === 'done' || payload.content === 'assistant_message_saved') {
            finishChatRequest('done');
          }
          if (payload.content === 'error' || payload.content === 'aborted' || payload.content === 'abort_ignored') {
            finishChatRequest(payload.content === 'error' ? 'error' : 'abort');
            if (payload.meta?.message) setError(payload.meta.message);
          }
          if (payload.content === 'mcp_approval_required' || payload.meta?.approvalRequired) {
            const approvalMessage = normalizeMessage({
              id: nowId(),
              type: 'mcp_approval',
              content: payload.meta?.message || 'MCP tool needs approval.',
              tool: payload.meta?.tool,
              meta: payload.meta,
              ts: Date.now()
            }, { showThinking: settings.showThinking });
            if (approvalMessage) {
              setMessages((prev) => [...prev, approvalMessage]);
            }
            return;
          }
          setStatus(payload);
          return;
        }
        if (payload.type === 'thinking_complete') {
          finishChatRequest(payload.meta?.error ? 'error' : payload.meta?.aborted ? 'abort' : 'done');
          return;
        }
        const normalized = normalizeMessage({ id: nowId(), ...payload, ts: Date.now() }, { showThinking: settings.showThinking });
        appendIncomingMessages(normalized);
      }
    });
    wsRef.current = manager;
    manager.bindLifecycleEvents();
    manager.connect();
    return () => {
      if (wsRef.current === manager) {
        wsRef.current = null;
      }
      manager.destroy();
    };
  }, [settings.serverUrl, settings.token, settings.sessionId, activeConversationId, settings.showThinking]);

  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, tab]);

  useEffect(() => {
    if (!settings.token) return;
    const poll = async () => {
      try {
        const data = await apiGet(
          settings.serverUrl,
          `/api/pending?session_id=${encodeURIComponent(settings.sessionId)}&conversation_id=${encodeURIComponent(activeConversationId)}`,
          settings.token
        );
        const pending = data.messages || [];
        if (!pending.length) return;
        const normalizedPending = pending
          .map((m) => normalizeMessage({
            id: `pending-${m.id}`,
            type: 'assistant',
            content: m.content,
            meta: { ...(m.meta || {}), keepalive: true },
            attachments: m.attachments || m.meta?.attachments || [],
            ts: m.ts
          }, { showThinking: settings.showThinking }))
          .filter(Boolean);
        normalizedPending.forEach((message) => appendIncomingMessages(message));
        await apiPost(settings.serverUrl, '/api/consume', settings.token, { ids: pending.map((m) => m.id) });
      } catch {
        // pending 轮询失败时保持静默，避免打扰聊天。
      }
    };
    poll();
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, [settings.serverUrl, settings.token, settings.sessionId, activeConversationId, settings.showThinking]);

  async function refreshStatus() {
    try {
      const data = await apiGet(settings.serverUrl, '/api/status', settings.token);
      setStatus({ type: 'status', content: 'api_status', meta: data });
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function refreshConversations(nextActiveId = activeConversationId) {
    const data = await apiGet(settings.serverUrl, '/api/conversations', settings.token);
    const list = data.conversations || [];
    setConversations(list);
    if (nextActiveId && list.some((item) => item.id === nextActiveId)) {
      setActiveConversationId(nextActiveId);
    } else {
      setActiveConversationId(list[0]?.id || 'default');
    }
    return list;
  }

  async function reloadHistory(conversationId = activeConversationId) {
    const data = await apiGet(
      settings.serverUrl,
      `/api/history?session_id=${encodeURIComponent(settings.sessionId)}&conversation_id=${encodeURIComponent(conversationId)}&limit=80`,
      settings.token
    );
    clearTypewriterQueue();
    setMessages((data.messages || []).flatMap((message) => normalizeHistoryMessage(message, { showThinking: settings.showThinking })));
    return data;
  }

  async function mergeLatestHistory(conversationId = activeConversationId) {
    const data = await apiGet(
      settings.serverUrl,
      `/api/history?session_id=${encodeURIComponent(settings.sessionId)}&conversation_id=${encodeURIComponent(conversationId)}&limit=80`,
      settings.token
    );
    if (conversationId !== activeConversationRef.current) return data;
    const historyMessages = normalizeHistoryRows(data.messages || []);
    setMessages((prev) => mergeHistoryIntoCurrentMessages(prev, historyMessages));
    return data;
  }

  function scheduleSendHistoryFallback(conversationId = activeConversationId) {
    historyFallbackTimersRef.current.forEach((timer) => clearTimeout(timer));
    historyFallbackTimersRef.current = [2000, 6000].map((delay) => setTimeout(() => {
      if (conversationId !== activeConversationRef.current) return;
      mergeLatestHistory(conversationId).catch((err) => {
        setError(err.message);
      });
    }, delay));
  }

  async function createNewConversation() {
    try {
      const data = await apiPost(settings.serverUrl, '/api/conversations', settings.token, { title: '新对话' });
      const id = data.conversation?.id || 'default';
      await refreshConversations(id);
      setMessages([]);
      setShowConversations(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function renameConversation(conversation) {
    const title = window.prompt('给这个对话起个名字', conversation.title || '新对话');
    if (!title || title.trim() === conversation.title) return;
    try {
      await apiPatch(settings.serverUrl, `/api/conversations/${encodeURIComponent(conversation.id)}`, settings.token, { title: title.trim() });
      await refreshConversations(conversation.id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeConversation(conversation) {
    if (!window.confirm(`删除「${conversation.title || '这个对话'}」？里面的消息也会一起删除。`)) return;
    try {
      await apiDelete(settings.serverUrl, `/api/conversations/${encodeURIComponent(conversation.id)}`, settings.token);
      await refreshConversations(activeConversationId === conversation.id ? null : activeConversationId);
      if (activeConversationId === conversation.id) setMessages([]);
    } catch (err) {
      setError(err.message);
    }
  }

  function switchConversation(id) {
    setActiveConversationId(id);
    setMessages([]);
    setAttachments((prev) => {
      prev.forEach(cleanupAttachmentPreview);
      return [];
    });
    setShowConversations(false);
  }

  async function uploadAttachment(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const pending = files.map(localAttachmentFromFile);
    setAttachments((prev) => [...prev, ...pending]);
    setError('');
    event.target.value = '';

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const local = pending[index];
      try {
        const form = new FormData();
        form.append('conversation_id', activeConversationId);
        form.append('file', file);
        const data = await apiUpload(settings.serverUrl, '/api/upload', settings.token, form);
        if (!data.file) throw new Error('上传没有返回文件信息');
        setAttachments((prev) => prev.map((item) => {
          if (item.id !== local.id) return item;
          cleanupAttachmentPreview(item);
          return { ...data.file, status: 'ready' };
        }));
      } catch (err) {
        setAttachments((prev) => prev.map((item) => (
          item.id === local.id
            ? { ...item, status: 'error', error: err.message || '上传失败' }
            : item
        )));
        setError(`${file.name} 上传失败：${err.message}`);
      }
    }
  }

  function removeAttachment(fileId) {
    setAttachments((prev) => {
      const next = [];
      prev.forEach((item) => {
        if ((item.id || item.file_id) === fileId) {
          cleanupAttachmentPreview(item);
        } else {
          next.push(item);
        }
      });
      return next;
    });
  }

  function updateMessagePartCollapsed(messageId, partIndex, collapsed) {
    skipNextAutoScrollRef.current = true;
    setMessages((prev) => prev.map((message) => {
      if (message.id !== messageId) return message;
      const parts = normalizeStructuredParts(message.parts, message.content);
      if (!parts[partIndex] || parts[partIndex].type !== 'thinking') return message;
      const nextParts = parts.map((part, index) => (
        index === partIndex ? { ...part, collapsed } : part
      ));
      return syncMessageContent({
        ...message,
        parts: nextParts
      });
    }));
  }

  function finishChatRequest(reason = 'done') {
    const current = activeRequestRef.current;
    if (current?.timeout) clearTimeout(current.timeout);
    activeRequestRef.current = null;
    setActiveRequest(null);
    console.debug('[finishChatRequest]', {
      reason,
      pendingTypewriterCount: typewriterRef.current.queue.length + pendingTypewriterJobsRef.current.length
    });
    setMessages((prev) => prev
      .map((message) => (
        deriveMessageRole(message) === 'assistant' && message.meta?.streamingTurn
          ? closeThinkingAndStopStreaming(message, reason)
          : message
      ))
      .filter((message) => !isEmptyAssistantShell(message) || hasPendingTypewriterForMessage(message.id)));
  }

  function startChatRequest(requestId, conversationId) {
    const previous = activeRequestRef.current;
    if (previous?.timeout) clearTimeout(previous.timeout);
    const controller = new AbortController();
    const request = {
      id: requestId,
      conversationId,
      controller,
      timeout: setTimeout(() => controller.abort('timeout'), 120_000),
      abortSent: false,
      startedAt: Date.now()
    };
    controller.signal.addEventListener('abort', () => {
      const reason = String(controller.signal.reason || 'abort');
      if (!request.abortSent && wsRef.current?.isConnected()) {
        wsRef.current.send({
          type: 'abort',
          content: reason,
          meta: {
            session_id: settingsRef.current.sessionId,
            conversation_id: conversationId,
            request_id: requestId,
            reason
          }
        });
        request.abortSent = true;
      }
      finishChatRequest(reason);
    });
    activeRequestRef.current = request;
    setActiveRequest({ id: requestId, conversationId, startedAt: request.startedAt });
    return request;
  }

  function stopActiveRequest(reason = 'stopped') {
    const current = activeRequestRef.current;
    if (!current) return;
    if (current.controller && !current.controller.signal.aborted) {
      current.controller.abort(reason);
      return;
    }
    finishChatRequest(reason);
  }

  function sendText() {
    if (activeRequestRef.current) {
      setError('Theo is still replying. Tap STOP first.');
      return false;
    }
    const content = input.trim();
    if (!content && attachments.length === 0) {
      setError('先写一句话再发送');
      return false;
    }
    if (attachments.some((item) => item.status === 'uploading')) {
      setError('附件还在上传，等它变成完成状态再发送。');
      return false;
    }
    if (attachments.some((item) => item.status === 'error')) {
      setError('有附件上传失败，先移除失败项再发送。');
      return false;
    }
    const readyAttachments = attachments.filter((item) => !item.local && item.status !== 'error');
    if (!wsRef.current?.isConnected()) {
      setError('WebSocket 还没连上，稍等一下再发');
      wsRef.current?.reconnect();
      return false;
    }
    const requestId = `req-${nowId()}`;
    startChatRequest(requestId, activeConversationId);
    const meta = {
      session_id: settings.sessionId,
      conversation_id: activeConversationId,
      request_id: requestId,
      tts: settings.tts,
      model: settings.model || undefined,
      attachments: readyAttachments
    };
    const sent = wsRef.current.send({ type: 'text', content, meta });
    if (!sent) {
      finishChatRequest('network');
      setError('WebSocket send failed, reconnecting');
      wsRef.current?.reconnect();
      return false;
    }
    scheduleSendHistoryFallback(activeConversationId);
    setMessages((prev) => [...prev, { id: nowId(), type: 'user', content: content || '[附件]', meta, attachments: readyAttachments, ts: Date.now() }]);
    setInput('');
    setAttachments((prev) => {
      prev.forEach(cleanupAttachmentPreview);
      return [];
    });
    setError('');
    return true;
  }

  function messageDbId(message) {
    const id = Number(message?.meta?.db_id || String(message?.id || '').match(/^db-(\d+)$/)?.[1]);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  async function copyMessage(message) {
    await navigator.clipboard?.writeText(message.content || '');
    setMessageMenu(null);
  }

  async function deleteMessageAction(message, cascade = false) {
    const id = messageDbId(message);
    if (!id) {
      setError('这条消息还没同步到数据库，刷新后再试。');
      setMessageMenu(null);
      return;
    }
    const promptText = cascade
      ? 'Delete this message and everything after it?'
      : 'Delete only this message? This can make the conversation look a little strange.';
    if (!window.confirm(promptText)) return;
    try {
      await apiDelete(settings.serverUrl, `/api/messages/${id}?cascade=${cascade ? 'true' : 'false'}`, settings.token);
      setMessageMenu(null);
      await reloadHistory(activeConversationId);
      await refreshConversations(activeConversationId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveEditedMessage(message, content) {
    const id = messageDbId(message);
    if (!id) {
      setError('这条消息还没同步到数据库，刷新后再试。');
      return;
    }
    try {
      await apiPatch(settings.serverUrl, `/api/messages/${id}`, settings.token, { content });
      setEditingMessage(null);
      const data = await apiPost(settings.serverUrl, `/api/messages/${id}/regenerate`, settings.token, {
        session_id: settings.sessionId,
        conversation_id: activeConversationId,
        model: settings.model || ''
      });
      clearTypewriterQueue();
      setMessages((data.messages || []).flatMap((item) => normalizeHistoryMessage(item, { showThinking: settings.showThinking })));
      await refreshConversations(activeConversationId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function regenerateMessage(message) {
    const id = messageDbId(message);
    if (!id) {
      setError('这条消息还没同步到数据库，刷新后再试。');
      setMessageMenu(null);
      return;
    }
    try {
      setMessageMenu(null);
      addTypingIndicator({ conversation_id: activeConversationId });
      const data = await apiPost(settings.serverUrl, `/api/messages/${id}/regenerate`, settings.token, {
        session_id: settings.sessionId,
        conversation_id: activeConversationId,
        model: settings.model || ''
      });
      clearTypewriterQueue();
      setMessages((data.messages || []).flatMap((item) => normalizeHistoryMessage(item, { showThinking: settings.showThinking })));
      await refreshConversations(activeConversationId);
    } catch (err) {
      setError(err.message);
      setMessages((prev) => prev.filter((item) => item.type !== 'typing_indicator'));
    }
  }

  async function approveMcpTool(tool, scope) {
    try {
      const data = await apiPost(settings.serverUrl, '/api/mcp/approve', settings.token, { tool, scope });
      setError('');
      setMessages((prev) => prev.map((message) => (
        message.type === 'mcp_approval' && message.meta?.tool === tool
          ? { ...message, content: scope === 'always' ? '已始终允许该工具' : '已允许本次工具调用', meta: { ...message.meta, approved: true, approvalResult: data.result } }
          : message
      )));
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }

  const activeTab = useMemo(() => tabs.find((item) => item.id === tab), [tab]);
  const bgStyle = {
    '--user-bg-image': settings.backgroundImage ? `url(${settings.backgroundImage})` : 'none',
    '--bg-wash-opacity': `${Math.max(0, Math.min(100, Number(settings.backgroundOpacity ?? 88))) / 100}`
  };

  if (!settings.token) {
    return <Login settings={settings} setSettings={setSettings} />;
  }

  return (
    <div className="app-shell" style={bgStyle}>
      <div className="portrait" style={settings.portraitUrl ? { backgroundImage: `url(${settings.portraitUrl})` } : undefined} />
      <header className="topbar">
        <button className="icon-button menu-button" onClick={() => setShowConversations(true)} aria-label="菜单">
          <Menu size={22} />
        </button>
        <div className="title-lockup">
          <h1>Théo</h1>
          <span className="online-dot" aria-label="online" />
        </div>
        <button className="icon-button" onClick={() => setShowSettings(true)} aria-label="设置">
          <Settings size={20} />
        </button>
      </header>

      <ConversationDrawer
        open={showConversations}
        conversations={conversations}
        activeConversationId={activeConversationId}
        onClose={() => setShowConversations(false)}
        onSelect={switchConversation}
        onCreate={createNewConversation}
        onRename={renameConversation}
        onDelete={removeConversation}
      />

      <main className={tab === 'chat' ? 'main-panel' : 'main-panel washed'}>
        {tab === 'chat' && (
          <ChatTab
            listRef={listRef}
            messages={messages}
            input={input}
            setInput={setInput}
            sendText={sendText}
            activeRequest={activeRequest}
            stopActiveRequest={stopActiveRequest}
            connected={connected}
            error={error}
            approveMcpTool={approveMcpTool}
            attachments={attachments}
            uploadAttachment={uploadAttachment}
            removeAttachment={removeAttachment}
            fileInputRef={fileInputRef}
            settings={settings}
            typingSpeed={settings.typingSpeed}
            onMessageMenu={setMessageMenu}
            onThinkingCollapsedChange={updateMessagePartCollapsed}
          />
        )}
        {tab === 'dash' && (
          <DashTab
            connected={connected}
            status={status}
            error={error}
            refreshStatus={refreshStatus}
            settings={settings}
            setError={setError}
          />
        )}
        {tab === 'read' && <ReadTab settings={settings} setError={setError} />}
        {tab === 'memory' && <MemoryTabV2 settings={settings} setError={setError} approveMcpTool={approveMcpTool} />}
      </main>

      <nav className="tabbar">
        {tabs.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} className={tab === item.id ? 'tab active' : 'tab'} onClick={() => setTab(item.id)}>
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {showSettings && (
        <SettingsSheet
          settings={settings}
          setSettings={setSettings}
          close={() => setShowSettings(false)}
          activeTab={activeTab}
        />
      )}
      {messageMenu && (
        <MessageActionMenu
          message={messageMenu}
          close={() => setMessageMenu(null)}
          onCopy={copyMessage}
          onEdit={(message) => {
            setMessageMenu(null);
            setEditingMessage(message);
          }}
          onDelete={deleteMessageAction}
          onRegenerate={regenerateMessage}
        />
      )}
      {editingMessage && (
        <EditMessageSheet
          message={editingMessage}
          close={() => setEditingMessage(null)}
          onSave={saveEditedMessage}
        />
      )}
    </div>
  );
}

function Login({ settings, setSettings }) {
  const [token, setToken] = useState(settings.token);
  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  return (
    <div className="login">
      <div className="login-card">
        <p className="eyebrow">welcome back</p>
        <h1>Théo</h1>
        <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="服务器地址" />
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="Bridge token" type="password" />
        <button onClick={() => setSettings({ ...settings, token, serverUrl })}>进入</button>
      </div>
    </div>
  );
}

function ConversationDrawer({
  open,
  conversations,
  activeConversationId,
  onClose,
  onSelect,
  onCreate,
  onRename,
  onDelete
}) {
  const [menuFor, setMenuFor] = useState(null);
  const longPressTimer = useRef(null);

  function startPress(conversation) {
    clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => setMenuFor(conversation), 560);
  }

  function endPress() {
    clearTimeout(longPressTimer.current);
  }

  if (!open) return null;

  return (
    <div className="conversation-layer">
      <button className="conversation-scrim" onClick={onClose} aria-label="关闭会话列表" />
      <aside className="conversation-drawer" aria-label="会话列表">
        <div className="conversation-head">
          <div>
            <p>Conversations</p>
            <h2>对话</h2>
          </div>
          <button className="conversation-new" onClick={onCreate} aria-label="新建对话">
            <Plus size={18} />
          </button>
        </div>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={conversation.id === activeConversationId ? 'conversation-item active' : 'conversation-item'}
              onClick={() => onSelect(conversation.id)}
              onPointerDown={() => startPress(conversation)}
              onPointerUp={endPress}
              onPointerLeave={endPress}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuFor(conversation);
              }}
            >
              <MessageCircle size={18} />
              <span>
                <strong>{conversation.title || '新对话'}</strong>
                <small>{conversation.message_count || 0} 条 · {conversation.last_message ? shortText(conversation.last_message, 24) : '空白'}</small>
              </span>
            </button>
          ))}
        </div>
        <p className="conversation-tip">点按切换，长按重命名或删除。</p>
      </aside>

      {menuFor && (
        <div className="conversation-menu">
          <strong>{menuFor.title || '新对话'}</strong>
          <button onClick={() => { onRename(menuFor); setMenuFor(null); }}>
            <Pencil size={16} />
            重命名
          </button>
          <button className="danger" onClick={() => { onDelete(menuFor); setMenuFor(null); }}>
            <Trash2 size={16} />
            删除
          </button>
          <button onClick={() => setMenuFor(null)}>取消</button>
        </div>
      )}
    </div>
  );
}

function ChatTab({
  listRef,
  messages,
  input,
  setInput,
  sendText,
  activeRequest,
  stopActiveRequest,
  connected,
  error,
  approveMcpTool,
  attachments,
  uploadAttachment,
  removeAttachment,
  fileInputRef,
  settings,
  onMessageMenu,
  onThinkingCollapsedChange
}) {
  const timeline = useMemo(() => buildChatTimeline(messages), [messages]);
  return (
    <section className="chat">
      <div className="message-list" ref={listRef}>
        {timeline.length === 0 && (
          <div className="chat-empty">
            <Sparkles size={28} />
            <strong>Théo 在这里</strong>
            <span>发一句话，或者先去 dash 看服务状态。</span>
          </div>
        )}
        {timeline.map((item) => {
          if (item.kind === 'day') return <div key={item.id} className="day-divider">{item.label}</div>;
          if (item.kind === 'time') return <div key={item.id} className="time-divider">{item.label}</div>;
          return (
            <Message
              key={item.id}
              message={item.message}
              part={item.part}
              partIndex={item.partIndex}
              showTime={item.showTime}
              approveMcpTool={approveMcpTool}
              onMessageMenu={onMessageMenu}
              settings={settings}
              onThinkingCollapsedChange={onThinkingCollapsedChange}
            />
          );
        })}
        {error && <div className="inline-error">{error}</div>}
      </div>
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendText();
        }}
      >
        {attachments.length > 0 && (
          <div className="attachment-tray">
            {attachments.map((file) => (
              <AttachmentChip
                key={file.id || file.file_id}
                file={file}
                settings={settings}
                onRemove={() => removeAttachment(file.id || file.file_id)}
              />
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif,.pdf,.txt,.md,.docx"
          multiple
          onChange={uploadAttachment}
        />
        <button
          className="tool-button"
          type="button"
          aria-label="添加附件"
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={20} />
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendText();
            }
          }}
          placeholder="Message..."
          rows={1}
        />
        <button
          className="send-button text-button"
          type={activeRequest ? 'button' : 'submit'}
          onPointerDown={(event) => {
            // iOS Safari 有时在 textarea 聚焦时第一下只处理焦点；pointerdown 让发送更可靠。
            event.preventDefault();
            if (activeRequest) {
              stopActiveRequest('stopped');
            } else {
              sendText();
            }
          }}
          aria-label={activeRequest ? '停止生成' : '发送'}
        >{activeRequest ? 'STOP' : 'SEND'}</button>
      </form>
    </section>
  );
}

function AttachmentChip({ file, settings, onRemove }) {
  const isImage = isImageAttachment(file);
  const status = file.status || 'ready';
  const title = attachmentTitle(file);
  return (
    <div className={`attachment-chip ${status}`}>
      {isImage ? (
        <img src={attachmentUrl(settings, file)} alt="" />
      ) : (
        <div className="attachment-file-icon"><FileText size={18} /></div>
      )}
      <span>
        <strong>{shortText(title, 24)}</strong>
        <small>
          {status === 'uploading' && (
            <>
              <Loader2 size={11} className="spin" />
              上传中
            </>
          )}
          {status === 'error' && (file.error || '上传失败')}
          {status !== 'uploading' && status !== 'error' && `${file.type === 'image' ? '图片' : '文件'} · ${formatBytes(file.size)}`}
        </small>
      </span>
      <button type="button" onClick={onRemove} aria-label="移除附件">×</button>
    </div>
  );
}

function MessageAttachments({ attachments = [], settings }) {
  if (!attachments.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((file) => {
        const isImage = isImageAttachment(file);
        const title = attachmentTitle(file);
        const url = attachmentUrl(settings, file);
        return (
          <a
            key={file.id || file.path}
            className={isImage ? 'message-attachment image' : 'message-attachment file'}
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {isImage ? (
              <img src={url} alt={title} />
            ) : (
              <>
                <div className="attachment-file-icon"><FileText size={18} /></div>
                <span>
                  <strong>{shortText(title, 28)}</strong>
                  <small>{formatBytes(file.size)}</small>
                </span>
              </>
            )}
          </a>
        );
      })}
    </div>
  );
}

function Message({
  message,
  part,
  partIndex,
  showTime,
  approveMcpTool,
  onMessageMenu,
  settings,
  onThinkingCollapsedChange
}) {
  const pressTimer = useRef(null);
  const canOpenMenu = message.type === 'user' || message.type === 'assistant';
  const effectiveType = part?.type || message.type;
  function startPress(event) {
    if (!canOpenMenu || !onMessageMenu) return;
    clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => onMessageMenu(message), 560);
    event.currentTarget?.classList.add('pressing');
  }
  function endPress(event) {
    clearTimeout(pressTimer.current);
    event.currentTarget?.classList.remove('pressing');
  }

  if (effectiveType === 'typing_indicator') {
    return (
      <div className="msg from-theo typing-row" aria-label="Theo is typing">
        <div className="body typing-bubble">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  if (effectiveType === 'thinking') {
    return (
      <ThinkingBlock
        message={part?.content ? { ...message, content: part.content } : message}
        part={part}
        collapsed={typeof part?.collapsed === 'boolean' ? part.collapsed : undefined}
        onCollapsedChange={typeof partIndex === 'number'
          ? (collapsed) => onThinkingCollapsedChange?.(message.id, partIndex, collapsed)
          : undefined}
      />
    );
  }
  if (effectiveType === 'mcp_approval') {
    return <McpApprovalCard message={message} approveMcpTool={approveMcpTool} />;
  }
  if (effectiveType === 'tool' || message.type === 'tool_use') {
    return (
      <details className="tool-call">
        <summary><MemoryStick size={16} /> tool · {message.content}<ChevronDown size={16} /></summary>
        <pre>{JSON.stringify(message.meta || {}, null, 2)}</pre>
      </details>
    );
  }
  if (effectiveType === 'audio') {
    return (
      <div className="msg from-theo audio-row">
        <div className="body">
          <div className="audio-wrap">
            <Volume2 size={16} />
            <audio className="audio-player" controls src={message.content} />
          </div>
        </div>
        {showTime && <div className="meta">{formatClock(message.ts)}</div>}
      </div>
    );
  }
  const cls = message.type === 'user' ? 'msg from-me' : 'msg from-theo';
  const content = part?.type === 'text' ? part.content : message.content;
  const attachments = typeof partIndex === 'number' && partIndex > 0
    ? []
    : (message.attachments || message.meta?.attachments || []);
  return (
    <div
      className={cls}
      onPointerDown={startPress}
      onPointerUp={endPress}
      onPointerLeave={endPress}
      onPointerCancel={endPress}
      onContextMenu={(event) => {
        if (!canOpenMenu || !onMessageMenu) return;
        event.preventDefault();
        onMessageMenu(message);
      }}
    >
      {message.meta?.keepalive && <div className="message-kicker">Théo · 主动</div>}
      <div className="body">
        <MessageContent content={content} />
        <MessageAttachments attachments={attachments} settings={settings} />
      </div>
      {showTime && <div className="meta">{formatClock(message.ts)}</div>}
    </div>
  );
}

function MessageContent({ content }) {
  const parts = parseFencedContent(content);
  return (
    <div className="message-content">
      {parts.map((part, index) => {
        if (part.type === 'text') {
          return part.text ? <span key={index}>{part.text}</span> : null;
        }
        return <CodeBlock key={index} lang={part.lang} code={part.code} />;
      })}
    </div>
  );
}

function CodeBlock({ lang, code }) {
  const canPreview = lang === 'html' || lang === 'svg';
  return (
    <div className="code-block-wrap">
      <div className="code-block-title">
        <span><Code2 size={14} />{lang || 'code'}</span>
      </div>
      <pre className="message-code"><code>{code}</code></pre>
      {canPreview && <HtmlPreview lang={lang} code={code} />}
    </div>
  );
}

function HtmlPreview({ lang, code }) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [height, setHeight] = useState(400);
  const dragRef = useRef(null);
  const srcDoc = useMemo(() => previewSrcDoc(lang, code), [lang, code]);

  function resize(event) {
    if (!dragRef.current) return;
    const next = dragRef.current.height + event.clientY - dragRef.current.y;
    setHeight(Math.max(220, Math.min(800, next)));
  }

  function stopResize() {
    dragRef.current = null;
    window.removeEventListener('pointermove', resize);
  }

  function startResize(event) {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { y: event.clientY, height };
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize, { once: true });
  }

  return (
    <div className={`html-preview ${open ? 'open' : ''}`} onPointerDown={(event) => event.stopPropagation()}>
      {!open ? (
        <button className="preview-toggle" type="button" onClick={() => setOpen(true)}>
          <Eye size={15} />
          预览
        </button>
      ) : (
        <>
          <div className="preview-toolbar">
            <strong>{lang === 'svg' ? 'SVG 预览' : 'HTML 预览'}</strong>
            <span />
            <button type="button" onClick={() => setFullscreen(true)} aria-label="全屏预览"><Maximize2 size={15} /></button>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭预览"><X size={15} /></button>
          </div>
          <iframe
            title={`${lang} preview`}
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-same-origin"
            style={{ height }}
          />
          <button className="preview-resizer" type="button" onPointerDown={startResize} aria-label="调整预览高度" />
        </>
      )}
      {fullscreen && (
        <div className="preview-fullscreen" onClick={() => setFullscreen(false)}>
          <div className="preview-fullscreen-bar" onClick={(event) => event.stopPropagation()}>
            <strong>{lang === 'svg' ? 'SVG 预览' : 'HTML 预览'}</strong>
            <button type="button" onClick={() => setFullscreen(false)}>退出</button>
          </div>
          <iframe
            title={`${lang} fullscreen preview`}
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-same-origin"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function MessageActionMenu({ message, close, onCopy, onEdit, onDelete, onRegenerate }) {
  const isUser = message.type === 'user';
  return (
    <div className="message-menu-layer" onClick={close}>
      <div className="message-menu" onClick={(event) => event.stopPropagation()}>
        <strong>{isUser ? 'User message' : 'Theo message'}</strong>
        <button onClick={() => onCopy(message)}>Copy</button>
        {isUser && <button onClick={() => onEdit(message)}>Edit and rerun</button>}
        {!isUser && <button onClick={() => onRegenerate(message)}>Regenerate</button>}
        <button onClick={() => onDelete(message, true)}>Delete from here</button>
        <button className="danger" onClick={() => onDelete(message, false)}>Delete single</button>
        <button onClick={close}>Cancel</button>
      </div>
    </div>
  );
}

function EditMessageSheet({ message, close, onSave }) {
  const [content, setContent] = useState(message.content || '');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!content.trim()) return;
    setSaving(true);
    try {
      await onSave(message, content.trim());
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="message-menu-layer" onClick={close}>
      <div className="edit-message-sheet" onClick={(event) => event.stopPropagation()}>
        <strong>Edit user message</strong>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        <div className="edit-actions">
          <button onClick={close}>Cancel</button>
          <button onClick={save} disabled={saving || !content.trim()}>{saving ? 'Saving...' : 'Save and rerun'}</button>
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ message, part, collapsed, onCollapsedChange }) {
  const [openState, setOpenState] = useState(false);
  const placeholder = Boolean(message.meta?.placeholder || message.meta?.hidden || !(part?.content || message.content));
  const isControlled = typeof collapsed === 'boolean';
  const open = isControlled ? !collapsed : openState;

  function toggle() {
    const nextOpen = !open;
    if (isControlled) {
      onCollapsedChange?.(!nextOpen);
      return;
    }
    setOpenState(nextOpen);
  }
  const label = open ? '收起' : placeholder ? 'Théo 在想...' : '展开';
  return (
    <div className={open ? 'thinking-block open' : 'thinking-block'}>
      <button
        className="thinking-toggle"
        type="button"
        onClick={toggle}
        onDoubleClick={toggle}
      >
        <span>THINKING</span>
        <em>{label}</em>
      </button>
      {open && <div className="thinking-content">{message.content || 'Théo 在想...'}</div>}
    </div>
  );
}

function McpApprovalCard({ message, approveMcpTool, onApproved }) {
  const tool = message.meta?.tool || 'unknown_tool';
  const approved = Boolean(message.meta?.approved);
  async function approve(scope) {
    await approveMcpTool(tool, scope);
    await onApproved?.();
  }
  return (
    <div className="approval-card">
      <span>MCP APPROVAL</span>
      <strong>{tool}</strong>
      <p>{approved ? message.content : '这个工具还没有在服务端 allowlist 里。你可以允许一次，或始终允许。'}</p>
      {!approved && (
        <div className="approval-actions">
          <button onClick={() => approve('once')}>允许一次</button>
          <button onClick={() => approve('always')}>始终允许</button>
        </div>
      )}
    </div>
  );
}

function DashTab({ connected, status, error, refreshStatus, settings, setError }) {
  const meta = status?.meta || {};
  const api = meta.type === 'api_status' ? meta : meta.raw || meta;
  const dash = api.dash || {};
  const [morningLine, setMorningLine] = useState(null);
  const [morningLineError, setMorningLineError] = useState('');
  const [editingMorningLine, setEditingMorningLine] = useState(false);
  const [morningLineDraft, setMorningLineDraft] = useState('');
  const [savingMorningLine, setSavingMorningLine] = useState(false);
  const morningLineTextareaRef = useRef(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const theoSince = parseIsoDateStart(dash.theoSinceDate);
  const theoMarried = parseIsoDateStart(dash.theoMarriedDate);
  const together = formatElapsedParts(theoSince, nowTs);
  const married = formatElapsedParts(theoMarried, nowTs);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadMorningLine() {
      try {
        const data = await apiGet(settings.serverUrl, '/api/dash/morning-line', settings.token);
        if (cancelled) return;
        setMorningLine(data);
        if (!editingMorningLine) setMorningLineDraft(data.text || '');
        setMorningLineError('');
      } catch (err) {
        if (cancelled) return;
        setMorningLineError(err.message);
      }
    }
    if (settings.token) loadMorningLine();
    return () => {
      cancelled = true;
    };
  }, [settings.serverUrl, settings.token, editingMorningLine]);

  async function refreshDash() {
    await refreshStatus();
    try {
      const data = await apiGet(settings.serverUrl, '/api/dash/morning-line', settings.token);
      setMorningLine(data);
      if (!editingMorningLine) setMorningLineDraft(data.text || '');
      setMorningLineError('');
      setError('');
    } catch (err) {
      setMorningLineError(err.message);
    }
  }

  function startMorningLineEdit() {
    setMorningLineDraft(morningLine?.text || '');
    setEditingMorningLine(true);
  }

  function cancelMorningLineEdit() {
    setMorningLineDraft(morningLine?.text || '');
    setEditingMorningLine(false);
    setMorningLineError('');
  }

  async function saveMorningLineEdit() {
    const text = String(morningLineTextareaRef.current?.value ?? morningLineDraft).trim();
    if (!text) {
      setMorningLineError('写一句再保存。');
      return;
    }
    setSavingMorningLine(true);
    try {
      const data = await apiPatch(settings.serverUrl, '/api/dash/morning-line', settings.token, { text });
      setMorningLine(data);
      setMorningLineDraft(data.text || text);
      setEditingMorningLine(false);
      setMorningLineError('');
      setError('');
    } catch (err) {
      setMorningLineError(err.message);
    } finally {
      setSavingMorningLine(false);
    }
  }

  return (
    <section className="dash-page">
      <div className="dash-status">
        <div className="live"><span className="live-dot" />{connected ? 'online' : 'offline'}</div>
        <button className="refresh-link" onClick={refreshDash}><Activity size={14} />刷新</button>
      </div>
      <section className="quote-block">
        <div className="quote-head">
          <div className="quote-label">Théo 想对你说</div>
          {!editingMorningLine && (
            <button className="quote-edit-button" type="button" onClick={startMorningLineEdit}>编辑</button>
          )}
        </div>
        {editingMorningLine ? (
          <div className="quote-editor">
            <textarea
              ref={morningLineTextareaRef}
              value={morningLineDraft}
              onChange={(event) => setMorningLineDraft(event.target.value)}
              rows={3}
              maxLength={180}
              placeholder="写下今天想让 Théo 对你说的话..."
            />
            <div className="quote-editor-actions">
              <button type="button" onClick={cancelMorningLineEdit} disabled={savingMorningLine}>取消</button>
              <button type="button" onClick={saveMorningLineEdit} disabled={savingMorningLine}>
                {savingMorningLine ? '保存中' : '保存今天'}
              </button>
            </div>
          </div>
        ) : (
          <div className="quote-text">{morningLine?.text || '今天的话还没写好。'}</div>
        )}
        <div className="quote-meta">
          {morningLine?.dateKey
            ? `${morningLine.dateKey} · 今日${morningLine.manual ? ' · 手动保存' : morningLine.cached ? ' · 已缓存' : ''}`
            : '每天一条，早上更新'}
        </div>
      </section>
      <section className="counters">
        <div className="counter primary">
          <div className="counter-label">在一起的每一秒</div>
          <strong>{together.totalSeconds.toLocaleString('en-US')}</strong>
          <div className="counter-sub">{theoSince ? together.label : '未设置 THEO_SINCE_DATE'}</div>
        </div>
        <div className="counter">
          <div className="counter-label">婚后</div>
          <strong>{married.days}</strong>
          <div className="counter-sub">{theoMarried ? '天' : '未设置 THEO_MARRIED_DATE'}</div>
        </div>
      </section>
      {morningLineError && <div className="warning"><ShieldAlert size={18} />{morningLineError}</div>}
      {error && <div className="warning"><ShieldAlert size={18} />{error}</div>}
    </section>
  );
}

function ReadTab({ settings, setError }) {
  const base = (settings.serverUrl || window.location.origin).replace(/\/$/, '');
  const token = settings.token;

  const [books, setBooks] = useState([]);
  const [loadingBooks, setLoadingBooks] = useState(false);
  const [importing, setImporting] = useState(false);
  const [book, setBook] = useState(null);
  const [chapterNum, setChapterNum] = useState(1);
  const [chapter, setChapter] = useState(null);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [highlights, setHighlights] = useState([]);
  const [notes, setNotes] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState('theo');
  const [popup, setPopup] = useState(null);
  const highlightTouchTimer = useRef(null);
  const [chat, setChat] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);

  const contentRef = useRef(null);
  const notesTimer = useRef(null);
  const restoreScrollRef = useRef(0);
  const progressTimer = useRef(null);
  const chatJobRef = useRef(null);

  const loadBooks = async () => {
    if (!token) return;
    setLoadingBooks(true);
    try {
      const data = await apiGet(base, '/api/books', token);
      setBooks(data.books || []);
    } catch (err) {
      setError?.(err.message);
    } finally {
      setLoadingBooks(false);
    }
  };

  useEffect(() => {
    loadBooks();
  }, [base, token]);

  // 切走/卸载时把笔记和进度立刻落盘。
  useEffect(() => () => {
    clearTimeout(notesTimer.current);
    clearTimeout(progressTimer.current);
    clearTimeout(highlightTouchTimer.current);
    chatJobRef.current?.controller?.abort();
    chatJobRef.current = null;
  }, []);

  async function onImport(event) {
    const file = event.target.files?.[0];
    if (file) {
      event.target.value = '';
      setImporting(true);
      try {
        const data = await importEpub(base, token, file);
        await loadBooks();
        if (data.bookId) await openBook(data.bookId);
      } catch (err) {
        setError?.(`导入失败：${err.message}`);
      } finally {
        setImporting(false);
      }
    }
  }

  async function openBook(bookId) {
    try {
      const manifest = await apiGet(base, `/api/books/${encodeURIComponent(bookId)}/manifest`, token);
      setBook(manifest);
      setChat([]);
      let startChapter = 1;
      restoreScrollRef.current = 0;
      try {
        const progress = await apiGet(base, `/api/books/${encodeURIComponent(bookId)}/progress`, token);
        if (progress?.lastChapter) startChapter = progress.lastChapter;
        if (progress?.lastLocation) restoreScrollRef.current = Number(progress.lastLocation) || 0;
      } catch {
        // 没有进度就从头读。
      }
      await openChapter(manifest, startChapter);
    } catch (err) {
      setError?.(err.message);
    }
  }

  async function openChapter(manifest, n, keepScroll = true) {
    const total = manifest.totalChapters || 1;
    const num = Math.min(Math.max(1, n), total);
    if (!keepScroll) restoreScrollRef.current = 0;
    setChapterNum(num);
    setChapterLoading(true);
    setPopup(null);
    try {
      const id = encodeURIComponent(manifest.bookId);
      const [ch, hl, nt] = await Promise.all([
        apiGet(base, `/api/books/${id}/chapters/${num}`, token),
        apiGet(base, `/api/books/${id}/highlights/${num}`, token).catch(() => ({ highlights: [] })),
        apiGet(base, `/api/books/${id}/notes/${num}`, token).catch(() => ({ content: '' }))
      ]);
      setChapter(ch);
      setHighlights(hl.highlights || []);
      setNotes(nt.content || '');
      saveProgress(num, restoreScrollRef.current, manifest);
      // 等正文渲染好再恢复到上次的阅读位置。
      const target = restoreScrollRef.current;
      setTimeout(() => contentRef.current?.scrollTo?.({ top: target || 0 }), 60);
    } catch (err) {
      setError?.(err.message);
    } finally {
      setChapterLoading(false);
    }
  }

  function saveProgress(num, scrollTop, targetBook = book) {
    if (!targetBook && !num) return;
    const id = targetBook?.bookId;
    if (!id) return;
    const total = targetBook?.totalChapters || 1;
    putJson(`/api/books/${encodeURIComponent(id)}/progress`, {
      percentage: Math.round((num / total) * 100),
      lastChapter: num,
      lastLocation: Math.round(scrollTop || 0)
    }).catch(() => {});
  }

  function onScroll() {
    if (!book || chapterLoading) return;
    restoreScrollRef.current = contentRef.current?.scrollTop || 0;
    clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => saveProgress(chapterNum, restoreScrollRef.current), 600);
  }

  const chapterHtml = useMemo(() => {
    if (!chapter?.content) return '';
    return chapter.content.replace(/(src=")(\/api\/books\/[^"]+)"/g, (_m, p, u) => (
      `${p}${base}${u}${u.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}"`
    ));
  }, [chapter, base, token]);

  const highlightedChapterHtml = useMemo(() => {
    return applyChapterHighlights(chapterHtml, highlights);
  }, [chapterHtml, highlights]);

  const findHighlightByText = (text) => highlights.find((h) => h.text === text);
  const findHighlightById = (id) => highlights.find((h) => h.id === id);

  function captureSelection() {
    const sel = window.getSelection?.();
    const text = sel ? String(sel).trim() : '';
    if (!text || text.length < 2) {
      setPopup(null);
      return;
    }
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    try {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top;
    } catch {
      // 拿不到位置就用屏幕中间。
    }
    setPopup({ x, y, text });
  }

  function showHighlightPopup(highlight, x, y) {
    if (!highlight) return;
    setPopup({
      mode: 'highlight',
      x: x || window.innerWidth / 2,
      y: y || window.innerHeight / 2,
      text: highlight.text,
      highlightId: highlight.id,
      note: highlight.note || ''
    });
  }

  function onChapterPointer(event) {
    const mark = event.target?.closest?.('.reader-highlight-mark');
    if (!mark) return;
    const highlight = findHighlightById(mark.dataset.highlightId);
    if (!highlight) return;
    event.preventDefault();
    const rect = mark.getBoundingClientRect();
    showHighlightPopup(highlight, rect.left + rect.width / 2, rect.top);
  }

  function onChapterTouchStart(event) {
    const mark = event.target?.closest?.('.reader-highlight-mark');
    clearTimeout(highlightTouchTimer.current);
    if (!mark) return;
    const id = mark.dataset.highlightId;
    const rect = mark.getBoundingClientRect();
    highlightTouchTimer.current = setTimeout(() => {
      showHighlightPopup(findHighlightById(id), rect.left + rect.width / 2, rect.top);
    }, 420);
  }

  async function putJson(path, body) {
    await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function addHighlight(text) {
    if (highlights.some((h) => h.text === text)) return;
    const next = [...highlights, { id: nowId(), text, createdAt: Date.now() }];
    setHighlights(next);
    if (book) putJson(`/api/books/${encodeURIComponent(book.bookId)}/highlights/${chapterNum}`, { highlights: next }).catch(() => {});
  }

  function removeHighlight(id) {
    const next = highlights.filter((h) => h.id !== id);
    setHighlights(next);
    if (book) putJson(`/api/books/${encodeURIComponent(book.bookId)}/highlights/${chapterNum}`, { highlights: next }).catch(() => {});
  }

  function annotateHighlight(id, fallbackText = '') {
    const existing = findHighlightById(id) || findHighlightByText(fallbackText);
    const note = window.prompt('给这条划线写批注：', existing?.note || '');
    if (note === null) return;
    let next;
    if (existing) {
      next = highlights.map((h) => h.id === existing.id ? { ...h, note: note.trim(), updatedAt: Date.now() } : h);
    } else if (fallbackText) {
      next = [...highlights, { id: nowId(), text: fallbackText, note: note.trim(), createdAt: Date.now(), updatedAt: Date.now() }];
    } else {
      return;
    }
    setHighlights(next);
    if (book) putJson(`/api/books/${encodeURIComponent(book.bookId)}/highlights/${chapterNum}`, { highlights: next }).catch(() => {});
  }

  function onNotesChange(value) {
    setNotes(value);
    clearTimeout(notesTimer.current);
    setNotesSaving(true);
    notesTimer.current = setTimeout(async () => {
      if (book) await putJson(`/api/books/${encodeURIComponent(book.bookId)}/notes/${chapterNum}`, { content: value }).catch(() => {});
      setNotesSaving(false);
    }, 700);
  }

  function stopTheoReading({ silent = false } = {}) {
    const job = chatJobRef.current;
    chatJobRef.current = null;
    job?.controller?.abort();
    setChatBusy(false);
    if (job?.bookId && job?.jobId) {
      fetch(`${base}/api/books/${encodeURIComponent(job.bookId)}/chat-result/${encodeURIComponent(job.jobId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => {});
    }
    if (!silent) {
      setChat((prev) => [...prev, { role: 'theo', text: '（已停止等待，可以重新问我。）' }]);
    }
  }

  function waitForPoll(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }

  async function askTheo(selection, question) {
    if (!book || chatBusy) return;
    const q = String(question || '').trim() || '帮我讲讲这段。';
    setPanelOpen(true);
    setPanelTab('theo');
    setChat((prev) => [...prev, { role: 'me', text: selection ? `「${selection}」\n${q}` : q }]);
    setChatBusy(true);
    const id = encodeURIComponent(book.bookId);
    const controller = new AbortController();
    chatJobRef.current = { controller, bookId: book.bookId, jobId: null };
    let jobId = '';
    try {
      const start = await apiPost(base, `/api/books/${id}/chat`, token, {
        chapterNumber: chapterNum,
        selection,
        content: q
      });
      jobId = start.jobId;
      if (!jobId) throw new Error(start.error || '启动失败');
      // 轮询结果：Claude 读整章可能很久，但每次轮询都很快，不会触发 Cloudflare 524 超时。
      chatJobRef.current = { controller, bookId: book.bookId, jobId };
      const deadline = Date.now() + 5 * 60 * 1000;
      let unknownTries = 0;
      while (Date.now() < deadline) {
        await waitForPoll(2500, controller.signal);
        let r;
        try {
          const res = await fetch(`${base}/api/books/${id}/chat-result/${encodeURIComponent(jobId)}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal
          });
          if (!res.ok) throw new Error(`${res.status}`);
          r = await res.json();
        } catch {
          continue;
        }
        if (controller.signal.aborted || r.status === 'cancelled') return;
        if (r.status === 'done') {
          setChat((prev) => [...prev, { role: 'theo', text: r.text || '[无回复]' }]);
          return;
        }
        if (r.status === 'error') {
          setChat((prev) => [...prev, { role: 'theo', text: `（出错了：${r.error || '未知错误'}）` }]);
          return;
        }
        if (r.status === 'unknown' && (unknownTries += 1) > 3) {
          throw new Error('任务丢失（服务可能重启了）');
        }
      }
      setChat((prev) => [...prev, { role: 'theo', text: '（Théo 想了很久还没说完，先歇会儿，等会再问问看。）' }]);
    } catch (err) {
      if (controller.signal.aborted || err.name === 'AbortError') return;
      setChat((prev) => [...prev, { role: 'theo', text: `（出错了：${err.message}）` }]);
    } finally {
      if (chatJobRef.current?.controller === controller) chatJobRef.current = null;
      setChatBusy(false);
    }
  }

  if (!token) {
    return <section className="reader"><article className="reader-page">先在「设置」里填好服务器和 Token，才能导入书。</article></section>;
  }

  if (!book) {
    return (
      <section className="reader">
        <div className="reader-top">
          <div><span>library</span><strong>书架</strong></div>
          <label className="reader-upload">
            {importing ? <Loader2 size={17} className="spin" /> : <Plus size={17} />}
            {importing ? '导入中…' : '导入 epub'}
            <input type="file" accept=".epub,application/epub+zip" onChange={onImport} disabled={importing} />
          </label>
        </div>
        {loadingBooks && <p className="settings-note">加载书架…</p>}
        {!loadingBooks && books.length === 0 && (
          <article className="reader-page">书架还是空的。点右上角「导入 epub」上传第一本书，之后就能划线、批注、还能长按某句问 Théo。</article>
        )}
        <div className="book-grid">
          {books.map((b) => (
            <button key={b.bookId} className="book-card" onClick={() => openBook(b.bookId)}>
              <div className="book-card-title">{b.bookTitle}</div>
              <div className="book-card-meta">{b.bookAuthor} · {b.totalChapters} 章</div>
            </button>
          ))}
        </div>
      </section>
    );
  }

  const total = book.totalChapters || 1;
  return (
    <section className="reader reader-open">
      <div className="reader-top">
        <button className="reader-back" onClick={() => { setBook(null); setChapter(null); }}><ArrowLeft size={18} /></button>
        <div className="reader-title-wrap">
          <strong>{book.bookTitle}</strong>
          <span>{chapter?.title || ''}</span>
        </div>
        <button className="reader-panel-toggle" onClick={() => setPanelOpen((v) => !v)}>
          <MessageCircle size={18} />
        </button>
      </div>

      <div className="reader-body">
        <article
          className="reader-page reader-chapter"
          ref={contentRef}
          onScroll={onScroll}
          onClick={onChapterPointer}
          onContextMenu={onChapterPointer}
          onTouchStart={onChapterTouchStart}
          onTouchMove={() => clearTimeout(highlightTouchTimer.current)}
          onMouseUp={captureSelection}
          onTouchEnd={(event) => {
            clearTimeout(highlightTouchTimer.current);
            captureSelection(event);
          }}
          dangerouslySetInnerHTML={{ __html: chapterLoading ? '<p>加载中…</p>' : highlightedChapterHtml }}
        />
      </div>

      <div className="reader-nav">
        <button disabled={chapterNum <= 1} onClick={() => openChapter(book, chapterNum - 1, false)}>上一章</button>
        <span>{chapterNum} / {total}</span>
        <button disabled={chapterNum >= total} onClick={() => openChapter(book, chapterNum + 1, false)}>下一章</button>
      </div>

      {popup && (
        <div className="select-popup" style={{ left: Math.max(8, Math.min(popup.x - 80, window.innerWidth - 168)), top: Math.max(8, popup.y - 48) }}>
          {popup.mode === 'highlight' && (
            <div className="select-popup-note">{popup.note ? popup.note : '还没有批注。'}</div>
          )}
          {popup.mode === 'highlight' ? (
            <>
              <button onClick={() => { annotateHighlight(popup.highlightId, popup.text); setPopup(null); }}>批注</button>
              <button onClick={() => { removeHighlight(popup.highlightId); setPopup(null); }}>取消划线</button>
            </>
          ) : (
            <>
              {findHighlightByText(popup.text) ? (
                <button onClick={() => { removeHighlight(findHighlightByText(popup.text).id); setPopup(null); }}>取消划线</button>
              ) : (
                <button onClick={() => { addHighlight(popup.text); setPopup(null); }}>划线</button>
              )}
              <button onClick={() => { annotateHighlight(findHighlightByText(popup.text)?.id, popup.text); setPopup(null); }}>批注</button>
              <button onClick={() => { askTheo(popup.text, ''); setPopup(null); }}>问 Théo</button>
            </>
          )}
        </div>
      )}

      {panelOpen && (
        <div className="reader-panel">
          <div className="reader-panel-tabs">
            {[['theo', 'Théo'], ['notes', '笔记'], ['highlights', `高亮${highlights.length ? ` (${highlights.length})` : ''}`]].map(([id, label]) => (
              <button key={id} className={panelTab === id ? 'active' : ''} onClick={() => setPanelTab(id)}>{label}</button>
            ))}
            <button className="reader-panel-close" onClick={() => setPanelOpen(false)}><X size={16} /></button>
          </div>

          {panelTab === 'theo' && (
            <div className="reader-chat">
              <div className="reader-chat-list">
                {chat.length === 0 && <p className="settings-note">选中书里的句子点「问 Théo」，或直接在下面问关于本章的问题。</p>}
                {chat.map((m, i) => (
                  <div key={i} className={`reader-bubble ${m.role}`}>{m.text}</div>
                ))}
                {chatBusy && (
                  <div className="reader-bubble theo reader-busy-bubble">
                    <span><Loader2 size={14} className="spin" /> Théo 正在读这一章…</span>
                    <button type="button" onClick={() => stopTheoReading()}>退出</button>
                  </div>
                )}
              </div>
              <form
                className="reader-chat-input"
                onSubmit={(e) => { e.preventDefault(); if (chatInput.trim() && !chatBusy) { const q = chatInput; setChatInput(''); askTheo('', q); } }}
              >
                <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="问问这一章…" />
                <button type="submit" disabled={chatBusy || !chatInput.trim()}><Send size={16} /></button>
              </form>
            </div>
          )}

          {panelTab === 'notes' && (
            <div className="reader-notes">
              <textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} placeholder="写下本章的笔记…（Théo 也能读到）" />
              <span className="settings-note">{notesSaving ? '保存中…' : '已自动保存'}</span>
            </div>
          )}

          {panelTab === 'highlights' && (
            <div className="reader-highlights">
              {highlights.length === 0 && <p className="settings-note">还没有划线。选中句子点「划线」。</p>}
              {highlights.map((h) => (
                <div key={h.id} className="reader-highlight-item">
                  <span>
                    {h.text}
                    {h.note && <em>{h.note}</em>}
                  </span>
                  <button onClick={() => annotateHighlight(h.id, h.text)}>批注</button>
                  <button onClick={() => removeHighlight(h.id)}><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function escapeHighlightRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyChapterHighlights(html, highlights) {
  if (!html || typeof document === 'undefined') return html;
  const items = (highlights || [])
    .map((item) => ({ ...item, text: String(item?.text || '').trim() }))
    .filter((item) => item.text.length >= 2);
  const byText = new Map(items.map((item) => [item.text, item]));
  const terms = [...new Set(items.map((item) => item.text))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 80);
  if (!terms.length) return html;

  const template = document.createElement('template');
  template.innerHTML = html;
  const pattern = new RegExp(`(${terms.map(escapeHighlightRegExp).join('|')})`, 'g');
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('script, style, mark')) return NodeFilter.FILTER_REJECT;
      pattern.lastIndex = 0;
      return pattern.test(node.nodeValue || '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    pattern.lastIndex = 0;
    const text = node.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    text.replace(pattern, (match, _g, offset) => {
      if (offset > lastIndex) fragment.appendChild(document.createTextNode(text.slice(lastIndex, offset)));
      const mark = document.createElement('mark');
      mark.className = 'reader-highlight-mark';
      const highlight = byText.get(match);
      if (highlight?.id) mark.dataset.highlightId = highlight.id;
      mark.textContent = match;
      fragment.appendChild(mark);
      lastIndex = offset + match.length;
      return match;
    });
    if (lastIndex < text.length) fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.parentNode?.replaceChild(fragment, node);
  });

  return template.innerHTML;
}

function extractOmbreText(payload) {
  const result = payload?.result?.result || payload?.result;
  const direct = result?.structuredContent?.result;
  if (typeof direct === 'string') return direct;
  const content = result?.content || [];
  return content.map((item) => item?.text || '').filter(Boolean).join('\n');
}

function splitMemoryList(value) {
  return String(value || '')
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMood(text) {
  const match = /V([0-9.]+)\/A([0-9.]+)/.exec(text || '');
  return {
    valence: match ? Number(match[1]) : 0.5,
    arousal: match ? Number(match[2]) : 0.3
  };
}

function parseOmbreText(payload) {
  const text = extractOmbreText(payload);
  const counts = {
    pinned: Number(/固化记忆桶:\s*(\d+)/.exec(text)?.[1] || 0),
    dynamic: Number(/动态记忆桶:\s*(\d+)/.exec(text)?.[1] || 0),
    archive: Number(/归档记忆桶:\s*(\d+)/.exec(text)?.[1] || 0),
    size: /总存储大小:\s*([^\n]+)/.exec(text)?.[1]?.trim() || '',
    engine: /衰减引擎:\s*([^\n]+)/.exec(text)?.[1]?.trim() || ''
  };
  counts.total = counts.pinned + counts.dynamic + counts.archive;

  const buckets = [];
  let current = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const clean = line.trim();
    if (!clean || clean === '---' || clean.startsWith('===')) continue;

    let match = /^([📌💭])\s*\[([^\]]+)\]\s*主题:([^情]+?)\s*情感:(V[0-9.]+\/A[0-9.]+)\s*重要:(\d+)\s*权重:([0-9.]+)\s*标签:(.*)$/.exec(clean);
    if (match) {
      const mood = parseMood(match[4]);
      current = {
        id: match[2],
        pinned: match[1] === '📌',
        title: match[2],
        domain: splitMemoryList(match[3]),
        tags: splitMemoryList(match[7]),
        importance: Number(match[5]),
        weight: Number(match[6]),
        valence: mood.valence,
        arousal: mood.arousal,
        summary: '',
        keywords: []
      };
      buckets.push(current);
      continue;
    }

    match = /^(?:\[权重:([0-9.]+)\]\s*)?([📌💭])\s*(?:\[([^\]]+)\]\s*)?📌?\s*记忆桶:\s*([^\s]+)\s*\[主题:([^\]]*)\]\s*\[标签:([^\]]*)\]\s*\[情感:(V[0-9.]+\/A[0-9.]+)\]/.exec(clean);
    if (match) {
      const mood = parseMood(match[7]);
      current = {
        id: match[4],
        pinned: match[2] === '📌',
        title: match[3] || match[4],
        domain: splitMemoryList(match[5]),
        tags: splitMemoryList(match[6]),
        importance: null,
        weight: Number(match[1] || 0),
        valence: mood.valence,
        arousal: mood.arousal,
        summary: '',
        keywords: []
      };
      buckets.push(current);
      continue;
    }

    if (current && clean.startsWith('[摘要]')) {
      current.summary = clean.replace(/^\[摘要\]\s*/, '').replace(/\[\[|\]\]/g, '');
      continue;
    }
    if (current && clean.startsWith('[关键词]')) {
      current.keywords = splitMemoryList(clean.replace(/^\[关键词\]\s*/, ''));
    }
  }

  return { text, counts, buckets };
}

function MemoryStat({ label, value }) {
  return (
    <div className="memory-stat">
      <span>{label}</span>
      <strong>{value || 0}</strong>
    </div>
  );
}

function MemoryBucketCard({ bucket }) {
  const name = bucketDisplayName(bucket);
  const style = {
    '--memory-v': bucket.valence ?? 0.5,
    '--memory-a': bucket.arousal ?? 0.3
  };
  const tags = bucket.tags?.slice(0, 8) || [];
  return (
    <details className={`memory-bucket ${bucket.pinned ? 'pinned' : ''}`} style={style}>
      <summary>
        <div className="memory-bucket-top">
          <span className="memory-pin">{bucket.pinned ? '📌' : '💭'}</span>
          <strong>{name}</strong>
          <small>V{bucket.valence?.toFixed?.(1) || '0.5'} / A{bucket.arousal?.toFixed?.(1) || '0.3'}</small>
        </div>
        <div className="memory-bucket-meta">
          <span>{bucket.domain?.join(' / ') || '未分类'}</span>
          {bucket.weight ? <span>权重 {bucket.weight.toFixed(2)}</span> : null}
          {bucket.importance ? <span>重要 {bucket.importance}</span> : null}
        </div>
        {bucket.summary && <p>{shortText(bucket.summary, 96)}</p>}
      </summary>
      <div className="memory-bucket-detail">
        {bucket.summary && <p>{bucket.summary}</p>}
        <div className="memory-tags">
          {tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
        {bucket.keywords?.length > 0 && (
          <div className="memory-keywords">关键词：{bucket.keywords.join('、')}</div>
        )}
      </div>
    </details>
  );
}

function MemoryTab({ settings, setError, approveMcpTool }) {
  const [pulse, setPulse] = useState(null);
  const [query, setQuery] = useState('');
  const [approval, setApproval] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('pulse');
  const [localError, setLocalError] = useState('');

  async function loadPulse() {
    setLoading(true);
    setLocalError('');
    try {
      setApproval(null);
      const data = await apiGet(settings.serverUrl, '/api/memory/pulse?include_archive=true', settings.token);
      setPulse(data);
      setMode('pulse');
    } catch (err) {
      if (err.approvalRequired) {
        setApproval({ type: 'mcp_approval', content: err.message, meta: { tool: err.tool, action: 'pulse' } });
        return;
      }
      setLocalError(err.message);
      setError('');
    } finally {
      setLoading(false);
    }
  }

  async function breath() {
    setLoading(true);
    setLocalError('');
    try {
      setApproval(null);
      const data = await apiGet(settings.serverUrl, `/api/memory/breath?query=${encodeURIComponent(query)}`, settings.token);
      setPulse(data);
      setMode(query.trim() ? 'search' : 'float');
    } catch (err) {
      if (err.approvalRequired) {
        setApproval({ type: 'mcp_approval', content: err.message, meta: { tool: err.tool, action: 'breath' } });
        return;
      }
      setLocalError(err.message);
      setError('');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPulse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = useMemo(() => parseOmbreText(pulse), [pulse]);
  const pinned = parsed.buckets.filter((bucket) => bucket.pinned);
  const floating = parsed.buckets.filter((bucket) => !bucket.pinned);

  return (
    <section className="memory">
      <div className="memory-hero">
        <div>
          <span>ombre brain</span>
          <strong>{localError ? '暂时连不上' : '记忆库'}</strong>
        </div>
        <button onClick={loadPulse} disabled={loading}><Brain size={18} />刷新</button>
      </div>
      <div className="memory-stats">
        <MemoryStat label="固化" value={parsed.counts.pinned} />
        <MemoryStat label="动态" value={parsed.counts.dynamic} />
        <MemoryStat label="归档" value={parsed.counts.archive} />
        <MemoryStat label="总数" value={parsed.counts.total || parsed.buckets.length} />
      </div>
      {(parsed.counts.size || parsed.counts.engine) && (
        <div className="memory-subtle">
          {parsed.counts.size && <span>{parsed.counts.size}</span>}
          {parsed.counts.engine && <span>衰减引擎：{parsed.counts.engine}</span>}
          <span>{mode === 'pulse' ? '系统脉搏' : '浮现结果'}</span>
        </div>
      )}
      <div className="memory-search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') breath();
          }}
          placeholder="查一下之前..."
        />
        <button onClick={breath} disabled={loading}>{loading ? '...' : 'breath'}</button>
      </div>
      {approval && (
        <McpApprovalCard
          message={approval}
          approveMcpTool={approveMcpTool}
          onApproved={() => (approval.meta?.action === 'pulse' ? loadPulse() : breath())}
        />
      )}
      {localError && (
        <div className="memory-offline">
          <Brain size={22} />
          <strong>Théo 现在记不起东西</strong>
          <span>等 Ombre Brain 回来，再来这里刷新就好。</span>
        </div>
      )}
      {!localError && loading && !pulse && (
        <div className="memory-offline">
          <Loader2 size={22} className="spin" />
          <strong>正在翻记忆库</strong>
          <span>稍等一下。</span>
        </div>
      )}
      {!localError && !loading && pulse && parsed.buckets.length === 0 && (
        <div className="memory-offline">
          <Sparkles size={22} />
          <strong>没有浮现的记忆</strong>
          <span>换个关键词试试。</span>
        </div>
      )}
      {!localError && pinned.length > 0 && (
        <>
          <h3 className="memory-section-title">钉选的记忆</h3>
          <div className="memory-grid">
            {pinned.map((bucket, index) => <MemoryBucketCard key={`${bucket.id}-${index}`} bucket={bucket} />)}
          </div>
        </>
      )}
      {!localError && floating.length > 0 && (
        <>
          <h3 className="memory-section-title">{mode === 'pulse' ? '浮动的记忆' : '这次浮现'}</h3>
          <div className="memory-grid">
            {floating.map((bucket, index) => <MemoryBucketCard key={`${bucket.id}-${index}`} bucket={bucket} />)}
          </div>
        </>
      )}
    </section>
  );
}

const MEMORY_NAV_KEY = 'theo-memory-nav-v2';

function safeReadMemoryNav() {
  try {
    const saved = JSON.parse(localStorage.getItem(MEMORY_NAV_KEY) || '{}');
    return {
      layer: saved.layer || 'categories',
      category: saved.category || '',
      bucketId: saved.bucketId || ''
    };
  } catch {
    return { layer: 'categories', category: '', bucketId: '' };
  }
}

function ombreTextOf(payload) {
  const result = payload?.result?.result || payload?.result;
  if (typeof result?.structuredContent?.result === 'string') return result.structuredContent.result;
  return (result?.content || []).map((item) => item?.text || '').filter(Boolean).join('\n');
}

function splitOmbreList(value) {
  return String(value || '')
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function ombreMood(value) {
  const match = /V([0-9.]+)\/A([0-9.]+)/.exec(String(value || ''));
  return {
    valence: match ? Number(match[1]) : 0.5,
    arousal: match ? Number(match[2]) : 0.3
  };
}

function cleanOmbreText(value) {
  return String(value || '').replace(/\[\[|\]\]/g, '').trim();
}

function normalizeOmbreText(value) {
  return String(value || '').trim();
}

function looksLikeBucketHash(value) {
  return /^[a-f0-9]{8,}$/i.test(String(value || '').trim());
}

function firstSummaryKeywords(summary) {
  return Array.from(String(summary || '').matchAll(/\[\[([^\]]+)\]\]/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

function shortBucketId(id) {
  const value = String(id || '').trim();
  return value.length > 6 ? `${value.slice(0, 6)}…` : value;
}

function bucketDisplayName(bucket) {
  const direct = [
    bucket?.displayName,
    bucket?.display_name,
    bucket?.name,
    bucket?.title
  ].find((value) => value && !looksLikeBucketHash(value));
  if (direct) return String(direct).trim();

  const domains = (bucket?.domain || []).filter((item) => item && item !== '未分类');
  if (domains.length) return domains.slice(0, 2).join(' / ');

  const keywords = firstSummaryKeywords(bucket?.summary);
  if (keywords.length) return keywords.slice(0, 3).join(' / ');

  const tags = (bucket?.tags || []).filter(Boolean);
  if (tags.length) return tags.slice(0, 3).join(' / ');

  return shortBucketId(bucket?.id);
}

function syncBucketSummaryEntry(bucket) {
  if (!bucket || !bucket.summary) return;
  const summaryEntry = {
    id: `${bucket.id}-summary`,
    content: bucket.summary,
    tags: bucket.tags,
    importance: bucket.importance,
    createdAt: '',
    pinned: bucket.pinned,
    resolved: bucket.resolved,
    kind: 'summary'
  };
  const rest = (bucket.entries || []).filter((entry) => entry.kind !== 'summary');
  bucket.entries = [summaryEntry, ...rest];
}

function mergeMemoryBucket(base, detail) {
  if (!base) return detail || null;
  if (!detail) return base;
  const merged = {
    ...base,
    ...detail,
    id: base.id,
    title: detail.title || base.title,
    displayName: bucketDisplayName({ ...base, ...detail }),
    domain: detail.domain?.length ? detail.domain : base.domain,
    tags: detail.tags?.length ? detail.tags : base.tags,
    keywords: detail.keywords?.length ? detail.keywords : base.keywords,
    summary: detail.summary || base.summary,
    entries: detail.entries?.length ? detail.entries : base.entries
  };
  syncBucketSummaryEntry(merged);
  return merged;
}

function hydrateBucketSummariesFromText(buckets, text) {
  const lines = String(text || '').split(/\r?\n/);
  buckets.forEach((bucket) => {
    const start = lines.findIndex((line) => line.includes(`[${bucket.id}]`) || line.includes(` ${bucket.id} `) || line.trim().endsWith(bucket.id));
    if (start < 0) return;
    const block = [];
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (/^(📌|💭)\s*(?:\[[^\]]+\])?/.test(line) || /记忆桶\s+[A-Za-z0-9_-]{6,}/.test(line)) break;
      block.push(lines[index]);
    }

    let collecting = false;
    const summaryLines = [];
    for (const raw of block) {
      const line = raw.trim();
      if (!line) {
        if (collecting && summaryLines.length) summaryLines.push('');
        continue;
      }
      const label = /^(?:\[)?(摘要|summary|digest|content|description)(?:\])?\s*[:：]?\s*(.*)$/i.exec(line);
      if (label) {
        collecting = true;
        if (label[2]) summaryLines.push(label[2]);
        continue;
      }
      if (/^(?:\[)?(关键词|tags?|key\s*words?)(?:\])?\s*[:：]?/i.test(line)) {
        collecting = false;
        continue;
      }
      if (collecting) summaryLines.push(line);
    }

    const summary = summaryLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (summary) {
      bucket.summary = summary;
      syncBucketSummaryEntry(bucket);
    }
    bucket.displayName = bucketDisplayName(bucket);
  });
}

function parseOmbreBucketsV2(payload) {
  const text = ombreTextOf(payload);
  const counts = {
    pinned: Number(/固化记忆桶:\s*(\d+)/.exec(text)?.[1] || 0),
    dynamic: Number(/动态记忆桶:\s*(\d+)/.exec(text)?.[1] || 0),
    archive: Number(/归档记忆桶:\s*(\d+)/.exec(text)?.[1] || 0),
    size: /总存储大小:\s*([^\n]+)/.exec(text)?.[1]?.trim() || '',
    engine: /衰减引擎:\s*([^\n]+)/.exec(text)?.[1]?.trim() || ''
  };
  counts.total = counts.pinned + counts.dynamic + counts.archive;

  const buckets = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === '---' || line.startsWith('===')) continue;

    let match = /^(📌|💭)\s*\[([^\]]+)\]\s*主题:(.*?)\s*情感:(V[0-9.]+\/A[0-9.]+)\s*重要:(\d+)\s*权重:([0-9.]+)\s*标签:(.*)$/u.exec(line);
    if (match) {
      const mood = ombreMood(match[4]);
      current = {
        id: match[2],
        title: match[2],
        category: match[1] === '📌' ? 'pinned' : 'dynamic',
        pinned: match[1] === '📌',
        resolved: false,
        domain: splitOmbreList(match[3]),
        tags: splitOmbreList(match[7]),
        importance: Number(match[5]),
        weight: Number(match[6]),
        valence: mood.valence,
        arousal: mood.arousal,
        summary: '',
        keywords: [],
        entries: []
      };
      buckets.push(current);
      continue;
    }

    match = /^(?:\[权重:([0-9.]+)\]\s*)?(📌|💭)\s*(?:\[([^\]]+)\]\s*)?📌?\s*记忆桶:\s*([^\s]+)\s*\[主题:([^\]]*)\]\s*\[标签:([^\]]*)\]\s*\[情感:(V[0-9.]+\/A[0-9.]+)\]/u.exec(line);
    if (match) {
      const mood = ombreMood(match[7]);
      current = {
        id: match[4],
        title: match[3] || match[4],
        category: match[2] === '📌' ? 'pinned' : 'dynamic',
        pinned: match[2] === '📌',
        resolved: false,
        domain: splitOmbreList(match[5]),
        tags: splitOmbreList(match[6]),
        importance: null,
        weight: Number(match[1] || 0),
        valence: mood.valence,
        arousal: mood.arousal,
        summary: '',
        keywords: [],
        entries: []
      };
      buckets.push(current);
      continue;
    }

    if (current && line.startsWith('[摘要]')) {
      current.summary = normalizeOmbreText(line.replace(/^\[摘要\]\s*/, ''));
      current.entries = [{
        id: `${current.id}-summary`,
        content: current.summary,
        tags: current.tags,
        importance: current.importance,
        createdAt: '',
        pinned: current.pinned,
        resolved: current.resolved,
        kind: 'summary'
      }];
      continue;
    }
    if (current && line.startsWith('[关键词]')) {
      current.keywords = splitOmbreList(cleanOmbreText(line.replace(/^\[关键词\]\s*/, '')));
    }
  }

  hydrateBucketSummariesFromText(buckets, text);
  buckets.forEach((bucket) => {
    bucket.displayName = bucketDisplayName(bucket);
    syncBucketSummaryEntry(bucket);
  });

  return { text, counts, buckets };
}

function memoryCategoryMeta(id, parsed) {
  const map = {
    pinned: { id: 'pinned', label: '固化', count: parsed.counts.pinned, hint: '永久钉选的核心记忆' },
    dynamic: { id: 'dynamic', label: '动态', count: parsed.counts.dynamic, hint: '会随权重和时间浮动' },
    archive: { id: 'archive', label: '归档', count: parsed.counts.archive, hint: '沉底的旧记忆' },
    total: { id: 'total', label: '总数', count: parsed.counts.total || parsed.buckets.length, hint: '全部可见记忆桶' }
  };
  return id ? map[id] : map;
}

function filterMemoryBuckets(buckets, category, query) {
  const q = String(query || '').trim().toLowerCase();
  return buckets.filter((bucket) => {
    const inCategory = category === 'total'
      || (category === 'archive' ? bucket.category === 'archive' : bucket.category === category);
    if (!inCategory) return false;
    if (!q) return true;
    return [
      bucket.id,
      bucket.displayName,
      bucket.title,
      bucket.summary,
      ...(bucket.domain || []),
      ...(bucket.tags || []),
      ...(bucket.keywords || [])
    ].join(' ').toLowerCase().includes(q);
  });
}

function MemoryBreadcrumb({ layer, category, bucket, goBack, reset }) {
  const categoryLabel = memoryCategoryMeta(category, { counts: {}, buckets: [] })?.label || '';
  return (
    <div className="memory-breadcrumb">
      {layer !== 'categories' && (
        <button type="button" onClick={goBack} aria-label="返回上一层"><ArrowLeft size={16} /></button>
      )}
      <span onClick={reset}>memory</span>
      {categoryLabel && <><ChevronDown size={13} /><span>{categoryLabel}</span></>}
      {bucket && <><ChevronDown size={13} /><strong>{bucketDisplayName(bucket)}</strong></>}
    </div>
  );
}

function MemoryCategoryCard({ item, onClick }) {
  return (
    <button className={`memory-category-card ${item.id}`} type="button" onClick={onClick}>
      <span>{item.label}</span>
      <strong>{item.count || 0}</strong>
      <small>{item.hint}</small>
    </button>
  );
}

function memoryBucketTime(bucket) {
  return bucket.updatedAt || bucket.createdAt || bucket.lastUpdated || '';
}

function MemoryBucketRow({ bucket, onClick }) {
  const tags = bucket.tags?.slice(0, 6) || [];
  const name = bucketDisplayName(bucket);
  return (
    <button className="bucket-row" type="button" onClick={onClick}>
      <div className="bucket-head">
        <div className="bucket-name">
          {name}
          {bucket.pinned && <span className="bucket-pin">·</span>}
        </div>
        <div className="bucket-time">{memoryBucketTime(bucket)}</div>
      </div>
      <div className="bucket-snippet">{bucket.summary ? shortText(bucket.summary, 128) : '暂无摘要'}</div>
      <div className="bucket-tags">{tags.join(' ')}</div>
    </button>
  );
}

function MemoryEntryCard({ entry, bucket }) {
  const [open, setOpen] = useState(false);
  const content = entry.content || bucket.summary || '暂无摘要';
  const tags = entry.tags?.length ? entry.tags : bucket.tags || [];
  return (
    <article className="memory-entry-row">
      <button className={`memory-entry-text ${open ? 'open' : ''}`} type="button" onClick={() => setOpen((value) => !value)}>
        {content}
      </button>
      <div className="memory-entry-meta-line">
        <span>{tags.join(' ')}</span>
        {entry.importance || bucket.importance ? <span>importance {entry.importance || bucket.importance}</span> : null}
        {entry.createdAt ? <span>{entry.createdAt}</span> : null}
        <span>{entry.pinned || bucket.pinned ? 'pinned' : 'floating'}</span>
        <span>{entry.resolved || bucket.resolved ? 'resolved' : 'active'}</span>
      </div>
    </article>
  );
}

function MemoryTabV2({ settings, setError, approveMcpTool }) {
  const saved = useMemo(safeReadMemoryNav, []);
  const [pulse, setPulse] = useState(null);
  const [query, setQuery] = useState('');
  const [approval, setApproval] = useState(null);
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState('');
  const [layer, setLayer] = useState(saved.layer);
  const [category, setCategory] = useState(saved.category);
  const [bucketId, setBucketId] = useState(saved.bucketId);
  const [bucketDetails, setBucketDetails] = useState({});
  const [bucketDetailLoading, setBucketDetailLoading] = useState(false);

  useEffect(() => {
    localStorage.setItem(MEMORY_NAV_KEY, JSON.stringify({ layer, category, bucketId }));
  }, [layer, category, bucketId]);

  async function loadPulse() {
    setLoading(true);
    setLocalError('');
    try {
      setApproval(null);
      const data = await apiGet(settings.serverUrl, '/api/memory/pulse?include_archive=true', settings.token);
      setPulse(data);
    } catch (err) {
      if (err.approvalRequired) {
        setApproval({ type: 'mcp_approval', content: err.message, meta: { tool: err.tool, action: 'pulse' } });
        return;
      }
      setLocalError(err.message);
      setError('');
    } finally {
      setLoading(false);
    }
  }

  async function breath() {
    setLoading(true);
    setLocalError('');
    try {
      setApproval(null);
      const data = await apiGet(settings.serverUrl, `/api/memory/breath?query=${encodeURIComponent(query)}`, settings.token);
      setPulse(data);
    } catch (err) {
      if (err.approvalRequired) {
        setApproval({ type: 'mcp_approval', content: err.message, meta: { tool: err.tool, action: 'breath' } });
        return;
      }
      setLocalError(err.message);
      setError('');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPulse();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = useMemo(() => parseOmbreBucketsV2(pulse), [pulse]);
  const categoryItems = Object.values(memoryCategoryMeta(null, parsed));
  const visibleBuckets = filterMemoryBuckets(parsed.buckets, category || 'total', query);
  const baseSelectedBucket = parsed.buckets.find((bucket) => bucket.id === bucketId) || visibleBuckets[0] || null;
  const selectedBucket = bucketId && bucketDetails[bucketId]
    ? mergeMemoryBucket(baseSelectedBucket, bucketDetails[bucketId])
    : baseSelectedBucket;

  function resetNav() {
    setLayer('categories');
    setCategory('');
    setBucketId('');
  }

  function goBack() {
    if (layer === 'bucket') {
      setLayer('buckets');
      setBucketId('');
    } else {
      resetNav();
    }
  }

  function openCategory(id) {
    setCategory(id);
    setBucketId('');
    setLayer('buckets');
  }

  async function loadBucketDetail(bucket) {
    setBucketDetailLoading(true);
    try {
      const data = await apiGet(settings.serverUrl, `/api/memory/breath?query=${encodeURIComponent(bucket.id)}`, settings.token);
      const detailParsed = parseOmbreBucketsV2(data);
      const detail = detailParsed.buckets.find((item) => item.id === bucket.id) || detailParsed.buckets[0] || null;
      if (detail) {
        setBucketDetails((prev) => ({ ...prev, [bucket.id]: mergeMemoryBucket(bucket, detail) }));
      }
      if (detailParsed.buckets[0]) {
        console.debug('[memory] breath bucket sample', detailParsed.buckets[0]);
      }
    } catch (err) {
      console.warn('[memory] bucket detail breath failed', err);
    } finally {
      setBucketDetailLoading(false);
    }
  }

  function openBucket(bucket) {
    setBucketId(bucket.id);
    setLayer('bucket');
    loadBucketDetail(bucket);
  }

  return (
    <section className="memory">
      <MemoryBreadcrumb
        layer={layer}
        category={category}
        bucket={layer === 'bucket' ? selectedBucket : null}
        goBack={goBack}
        reset={resetNav}
      />

      <div className="mem-head">
        <h2>Ombre Brain</h2>
        <button className="refresh-link" onClick={loadPulse} disabled={loading}><Activity size={14} />刷新</button>
      </div>

      <div className="stats">
        {categoryItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`stat ${category === item.id ? 'active' : ''}`}
            onClick={() => openCategory(item.id)}
          >
            <div className={`stat-val ${item.id === 'archive' && !item.count ? 'muted' : ''}`}>{item.count || 0}</div>
            <div className="stat-key">{item.label}</div>
          </button>
        ))}
      </div>

      <div className="meta-line">
        {parsed.counts.size && <span>{parsed.counts.size}</span>}
        {parsed.counts.size && parsed.counts.engine && <span className="dot" />}
        {parsed.counts.engine && <span>{parsed.counts.engine}</span>}
      </div>

      <div className="memory-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') breath();
          }}
          placeholder={layer === 'categories' ? '查一下之前...' : '过滤本层 bucket...'}
        />
        <button className="breath-button" onClick={breath} disabled={loading}>{loading ? '...' : 'breath'}</button>
      </div>

      {approval && (
        <McpApprovalCard
          message={approval}
          approveMcpTool={approveMcpTool}
          onApproved={() => (approval.meta?.action === 'pulse' ? loadPulse() : breath())}
        />
      )}

      {localError && (
        <div className="memory-offline">
          <Brain size={22} />
          <strong>Théo 现在记不起东西</strong>
          <span>等 Ombre Brain 回来，再来这里刷新就好。</span>
        </div>
      )}

      {!localError && loading && !pulse && (
        <div className="memory-offline">
          <Loader2 size={22} className="spin" />
          <strong>正在翻记忆库</strong>
          <span>稍等一下。</span>
        </div>
      )}

      {!localError && layer === 'categories' && (
        query.trim() ? (
          visibleBuckets.length === 0 ? (
            <div className="memory-empty-hint">没有匹配的 bucket。</div>
          ) : (
            <div className="bucket-list">
              {visibleBuckets.map((bucket, index) => (
                <MemoryBucketRow key={`${bucket.id}-${index}`} bucket={bucket} onClick={() => openBucket(bucket)} />
              ))}
            </div>
          )
        ) : (
          <div className="memory-empty-hint">点上面的数字，进入对应的记忆层。</div>
        )
      )}

      {!localError && layer === 'buckets' && (
        <>
          <h3 className="memory-section-title">{memoryCategoryMeta(category, parsed)?.label || '全部'} bucket</h3>
          {visibleBuckets.length === 0 ? (
            <div className="memory-offline">
              <Sparkles size={22} />
              <strong>没有匹配的 bucket</strong>
              <span>换个关键词试试。</span>
            </div>
          ) : (
            <div className="bucket-list">
              {visibleBuckets.map((bucket, index) => (
                <MemoryBucketRow key={`${bucket.id}-${index}`} bucket={bucket} onClick={() => openBucket(bucket)} />
              ))}
            </div>
          )}
        </>
      )}

      {!localError && layer === 'bucket' && selectedBucket && (
        <>
          <div className="memory-bucket-summary">
            <strong>{bucketDisplayName(selectedBucket)}</strong>
            <span>{selectedBucket.domain?.join(' / ') || '未分类'}</span>
          </div>
          <h3 className="memory-section-title">内容</h3>
          {bucketDetailLoading && <div className="memory-empty-hint">正在读取 bucket 详情...</div>}
          <div className="memory-entry-list">
            {(selectedBucket.entries?.length ? selectedBucket.entries : [{ id: `${selectedBucket.id}-fallback`, content: selectedBucket.summary }]).map((entry) => (
              <MemoryEntryCard key={entry.id} entry={entry} bucket={selectedBucket} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function SettingsSheet({ settings, setSettings, close }) {
  const [pushMessage, setPushMessage] = useState('');
  const [modelMessage, setModelMessage] = useState('');
  const [persistModel, setPersistModel] = useState(false);
  const [customModelMode, setCustomModelMode] = useState(Boolean(settings.model && !builtInModelValues.has(settings.model)));
  const modelSelectValue = customModelMode ? '__custom' : (builtInModelValues.has(settings.model) ? settings.model : '');
  const typingIndex = Math.max(0, typingSpeedOptions.findIndex((item) => item.value === settings.typingSpeed));
  const backgroundOpacity = Number(settings.backgroundOpacity ?? 88);
  function uploadBackground(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSettings({ ...settings, backgroundImage: reader.result });
    reader.readAsDataURL(file);
  }
  function clearBackground() {
    setSettings({ ...settings, backgroundImage: '' });
  }
  async function enablePush() {
    try {
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        setPushMessage('当前浏览器不支持 Web Push');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPushMessage('推送权限未开启');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const vapid = await apiGet(settings.serverUrl, '/api/vapid', settings.token);
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.publicKey)
      });
      await apiPost(settings.serverUrl, '/api/subscribe', settings.token, subscription.toJSON());
      setPushMessage('推送已开通');
    } catch (error) {
      setPushMessage(error.message);
    }
  }

  async function switchModel(model, persist = persistModel) {
    const nextModel = String(model || '').trim();
    try {
      setModelMessage('Switching model...');
      const data = await apiPost(settings.serverUrl, '/api/model/switch', settings.token, {
        model: nextModel,
        persist,
        conversation_id: settings.conversationId || 'default'
      });
      setSettings({ ...settings, model: nextModel });
      setModelMessage(`Model switched: ${data.label || nextModel || 'Server default'}`);
    } catch (error) {
      setModelMessage(`Model switch failed: ${error.message}`);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="settings-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          <div>
            <span>control room</span>
            <h2>设置</h2>
          </div>
          <button className="mini-close" onClick={close}>完成</button>
        </div>
        <label>
          服务器
          <input value={settings.serverUrl} onChange={(e) => setSettings({ ...settings, serverUrl: e.target.value })} />
        </label>
        <label>
          Token
          <input value={settings.token} onChange={(e) => setSettings({ ...settings, token: e.target.value })} type="password" />
        </label>
        <label>
          主通道模型
          <select
            value={modelSelectValue}
            onChange={(e) => {
              const value = e.target.value;
              if (value === '__custom') {
                setCustomModelMode(true);
                return;
              }
              setCustomModelMode(false);
              switchModel(value);
            }}
          >
            {modelChoices.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        {customModelMode && (
          <label>
            自定义模型 ID
            <input
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value.trim() })}
              placeholder="例如完整模型 ID"
            />
            <button type="button" onClick={() => switchModel(settings.model)}>Apply model</button>
          </label>
        )}
        <label className="toggle-row">
          Persist as default
          <input checked={persistModel} onChange={(e) => setPersistModel(e.target.checked)} type="checkbox" />
        </label>
        {modelMessage && <p className="settings-note">{modelMessage}</p>}
        <label>
          立绘 URL
          <input value={settings.portraitUrl} onChange={(e) => setSettings({ ...settings, portraitUrl: e.target.value })} />
        </label>
        <div className="settings-background-card">
          <strong>背景图</strong>
          <div className="settings-background-preview" style={settings.backgroundImage ? { backgroundImage: `url(${settings.backgroundImage})` } : undefined}>
            {!settings.backgroundImage && <span>暂无背景图</span>}
          </div>
          <div className="settings-background-actions">
            <label className="settings-upload-button">
              上传图片
              <input type="file" accept="image/*" onChange={uploadBackground} />
            </label>
            <button type="button" onClick={clearBackground}>清除</button>
          </div>
          <label>
            不透明度
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={backgroundOpacity}
              onChange={(e) => setSettings({ ...settings, backgroundOpacity: Number(e.target.value) })}
            />
            <p className="settings-note">{backgroundOpacity}%</p>
          </label>
        </div>
        <label className="toggle-row">
          <Volume2 size={18} />
          TTS
          <input checked={settings.tts} onChange={(e) => setSettings({ ...settings, tts: e.target.checked })} type="checkbox" />
        </label>
        <label className="toggle-row">
          <Brain size={18} />
          Thinking
          <input checked={settings.showThinking} onChange={(e) => setSettings({ ...settings, showThinking: e.target.checked })} type="checkbox" />
        </label>
        <label>
          Typing speed
          <input
            type="range"
            min="0"
            max={typingSpeedOptions.length - 1}
            step="1"
            value={typingIndex}
            onChange={(e) => {
              const next = typingSpeedOptions[Number(e.target.value)] || typingSpeedOptions[1];
              setSettings({ ...settings, typingSpeed: next.value });
            }}
          />
          <p className="settings-note">current: {getTypingSpeed(settings.typingSpeed).label}</p>
        </label>
        <button onClick={enablePush}>开通推送</button>
        {pushMessage && <p className="settings-note">{pushMessage}</p>}
        <button className="danger" onClick={() => setSettings({ ...settings, token: '' })}>紧急停机</button>
      </div>
    </div>
  );
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/chat/sw.js', { scope: '/chat/' })
      .then((registration) => registration.update())
      .catch(() => {});
  });
}

createRoot(document.getElementById('root')).render(<App />);
