const defaults = {
  serverUrl: window.location.origin,
  token: '',
  tts: false,
  model: '',
  showThinking: true,
  typingSpeed: 'normal',
  theme: 'system',
  sessionId: 'default',
  conversationId: 'default',
  portraitUrl: '',
  backgroundImage: '',
  backgroundOpacity: 88
};

const CHAT_CACHE_KEY = 'theo-chat-cache-v2';

export function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('theo-settings') || '{}') };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings) {
  localStorage.setItem('theo-settings', JSON.stringify(settings));
}

function loadChatCache() {
  try {
    return JSON.parse(localStorage.getItem(CHAT_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveChatCache(cache) {
  localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify(cache));
}

function cacheScopeKey(sessionId, conversationId) {
  return `${sessionId || 'default'}::${conversationId || 'default'}`;
}

export function loadConversationMessages(sessionId, conversationId) {
  const cache = loadChatCache();
  const scope = cache[cacheScopeKey(sessionId, conversationId)];
  return Array.isArray(scope?.messages) ? scope.messages : [];
}

export function saveConversationMessages(sessionId, conversationId, messages) {
  const cache = loadChatCache();
  cache[cacheScopeKey(sessionId, conversationId)] = {
    updatedAt: Date.now(),
    messages
  };
  saveChatCache(cache);
}
