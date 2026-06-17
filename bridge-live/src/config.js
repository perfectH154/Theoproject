const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`环境变量 ${name} 必须是整数`);
  }
  return value;
}

function listFromEnv(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

const dataDir = process.env.DATA_DIR || '/var/lib/companion';

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: intFromEnv('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  bridgeToken: process.env.BRIDGE_TOKEN || '',
  wsPath: process.env.WS_PATH || '/ws',
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'companion.db'),
  uploadDir: process.env.UPLOAD_DIR || path.join(dataDir, 'uploads'),
  audioDir: process.env.AUDIO_DIR || path.join(dataDir, 'audio'),
  tmpDir: process.env.TMP_DIR || path.join(dataDir, 'tmp'),
  frontendDir: process.env.FRONTEND_DIR || '/opt/companion/frontend',
  claude: {
    workdir: process.env.CLAUDE_WORKDIR || '/opt/companion/claude',
    turnScript: process.env.CLAUDE_TURN_SCRIPT || '/opt/companion/bridge/scripts/claude_turn.sh',
    mcpConfig: process.env.CLAUDE_MCP_CONFIG || '/opt/companion/claude/.mcp.json',
    model: process.env.CLAUDE_MODEL || '',
    verbose: process.env.CLAUDE_VERBOSE !== '0',
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || 'default',
    restartDelayMs: intFromEnv('CLAUDE_RESTART_DELAY_MS', 2000),
    turnTimeoutMs: intFromEnv('CLAUDE_TURN_TIMEOUT_MS', 180000)
  },
  limits: {
    maxTextChars: intFromEnv('MAX_TEXT_CHARS', 8000),
    maxImageBytes: intFromEnv('MAX_IMAGE_BYTES', 10 * 1024 * 1024),
    maxUploadBytes: intFromEnv('MAX_UPLOAD_BYTES', 20 * 1024 * 1024),
    maxAttachmentTextChars: intFromEnv('MAX_ATTACHMENT_TEXT_CHARS', 12000),
    allowedImageMime: new Set(listFromEnv('ALLOWED_IMAGE_MIME', ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])),
    allowedUploadMime: new Set(listFromEnv('ALLOWED_UPLOAD_MIME', [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/heic',
      'image/heif',
      'application/pdf',
      'text/plain',
      'text/markdown',
      'application/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ])),
    rateLimitPerMinute: intFromEnv('RATE_LIMIT_PER_MINUTE', 60),
    authFailLimit: intFromEnv('AUTH_FAIL_LIMIT', 5),
    authBanMs: intFromEnv('AUTH_BAN_MS', 30 * 60 * 1000)
  },
  stt: {
    mode: process.env.STT_MODE || 'off',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
    whisperCppBin: process.env.WHISPER_CPP_BIN || '/usr/local/bin/whisper-cli',
    whisperModelPath: process.env.WHISPER_MODEL_PATH || '/opt/models/ggml-base.bin',
    language: process.env.WHISPER_LANGUAGE || 'zh'
  },
  tts: {
    mode: process.env.TTS_MODE || 'off',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.VOICE_ID || '',
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
    outputFormat: process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128'
  },
  ombre: {
    mcpHttpUrl: process.env.OMBRE_MCP_HTTP_URL || '',
    authHeaderName: process.env.OMBRE_MCP_AUTH_HEADER_NAME || '',
    authHeaderValue: process.env.OMBRE_MCP_AUTH_HEADER_VALUE || '',
    defaultApprovedTools: new Set(listFromEnv('DEFAULT_APPROVED_MCP_TOOLS', ['MCP_OMBRE_PULSE', 'MCP_OMBRE_BREATH']))
  },
  push: {
    openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openRouterBaseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    model: process.env.PUSH_MODEL || 'anthropic/claude-haiku-4.5',
    enabled: process.env.PUSH_ENABLED === 'true',
    sessionId: process.env.PUSH_SESSION_ID || 'default',
    times: listFromEnv('PUSH_TIMES', ['07:30', '12:30', '15:00', '19:00', '22:30']),
    timezone: process.env.PUSH_TIMEZONE || 'Asia/Shanghai',
    minGapMinutes: intFromEnv('PUSH_MIN_GAP_MINUTES', 120),
    deciderMaxTokens: intFromEnv('PUSH_DECIDER_MAX_TOKENS', 5),
    generatorMaxTokens: intFromEnv('PUSH_GENERATOR_MAX_TOKENS', 200),
    personaPath: process.env.CLAUDE_PERSONA_PATH || '/root/.claude/CLAUDE.md',
    dreamEventsToken: process.env.DREAM_EVENTS_TOKEN || '',
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:you@example.com'
  },
  dash: {
    theoSinceDate: process.env.THEO_SINCE_DATE || '',
    theoMarriedDate: process.env.THEO_MARRIED_DATE || ''
  }
};

if (!config.bridgeToken || config.bridgeToken === 'replace-with-32-byte-random-token') {
  console.warn('[config] BRIDGE_TOKEN 还是空或示例值。生产环境必须设置 32 字节随机 token。');
}

module.exports = config;
