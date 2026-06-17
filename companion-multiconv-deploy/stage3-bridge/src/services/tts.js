const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { ensureDir } = require('../utils/fs');

ensureDir(config.audioDir);

function shouldSynthesize(meta = {}) {
  if (config.tts.mode === 'always') return true;
  if (config.tts.mode === 'on_demand' && meta.tts === true) return true;
  return false;
}

function audioUrlForFile(fileName, token = '') {
  const relative = `/audio/${fileName}`;
  const url = config.tts.publicBaseUrl ? new URL(relative, config.tts.publicBaseUrl) : new URL(relative, 'http://127.0.0.1');
  if (token) url.searchParams.set('token', token);
  if (!config.tts.publicBaseUrl) return `${url.pathname}${url.search}`;
  return url.toString();
}

function hashText(text) {
  const input = [
    config.tts.voiceId,
    config.tts.modelId,
    config.tts.outputFormat,
    text
  ].join('\n');
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function synthesizeSpeech(text, options = {}) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  if (!config.tts.elevenLabsApiKey) {
    throw new Error('TTS 已启用，但 ELEVENLABS_API_KEY 未配置');
  }
  if (!config.tts.voiceId) {
    throw new Error('TTS 已启用，但 VOICE_ID 未配置');
  }

  const hash = hashText(clean);
  const fileName = `${hash}.mp3`;
  const filePath = path.join(config.audioDir, fileName);
  if (fs.existsSync(filePath)) {
    return { url: audioUrlForFile(fileName, options.token), path: filePath, cached: true };
  }

  const endpoint = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${config.tts.voiceId}`);
  endpoint.searchParams.set('output_format', config.tts.outputFormat);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'xi-api-key': config.tts.elevenLabsApiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text: clean,
      model_id: config.tts.modelId,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`ElevenLabs TTS 失败：${response.status} ${detail}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(filePath, Buffer.from(arrayBuffer), { mode: 0o640 });
  return { url: audioUrlForFile(fileName, options.token), path: filePath, cached: false };
}

module.exports = { shouldSynthesize, synthesizeSpeech };
