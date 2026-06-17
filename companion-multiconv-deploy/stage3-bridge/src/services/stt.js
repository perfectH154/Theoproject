const { spawn } = require('node:child_process');
const fs = require('node:fs');
const config = require('../config');

async function transcribeWithOpenAI(filePath) {
  if (!config.stt.openaiApiKey) {
    throw new Error('STT_MODE=openai 需要配置 OPENAI_API_KEY');
  }
  const form = new FormData();
  const blob = new Blob([fs.readFileSync(filePath)]);
  form.append('file', blob, filePath.split('/').pop());
  form.append('model', config.stt.openaiModel);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.stt.openaiApiKey}` },
    body: form
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Whisper 转写失败：${res.status} ${text}`);
  }
  const data = await res.json();
  return data.text || '';
}

function transcribeWithWhisperCpp(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', config.stt.whisperModelPath,
      '-f', filePath,
      '-l', config.stt.language,
      '-nt'
    ];
    const child = spawn(config.stt.whisperCppBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`whisper.cpp 转写失败，退出码 ${code}：${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function transcribeAudio(filePath) {
  if (config.stt.mode === 'openai') return transcribeWithOpenAI(filePath);
  if (config.stt.mode === 'whispercpp') return transcribeWithWhisperCpp(filePath);
  throw new Error('STT 未启用。请配置 STT_MODE=openai 或 STT_MODE=whispercpp');
}

module.exports = { transcribeAudio };
