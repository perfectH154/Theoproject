const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { extension } = require('mime-types');
const config = require('../config');
const { ensureDir } = require('../utils/fs');

ensureDir(config.uploadDir);
ensureDir(config.audioDir);
ensureDir(config.tmpDir);

const imageSignatures = [
  { mime: 'image/png', ext: '.png', test: (buf) => buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', ext: '.jpg', test: (buf) => buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff },
  { mime: 'image/webp', ext: '.webp', test: (buf) => buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' },
  { mime: 'image/gif', ext: '.gif', test: (buf) => ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString()) }
];

function decodeBase64Payload(content) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(content);
  if (match) {
    return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
  }
  return { mime: '', buffer: Buffer.from(content, 'base64') };
}

function detectImage(buffer) {
  return imageSignatures.find((sig) => sig.test(buffer)) || null;
}

function saveImageBase64(content) {
  const { mime, buffer } = decodeBase64Payload(content);
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > config.limits.maxImageBytes) throw new Error('图片超过 10MB 上限');

  const detected = detectImage(buffer);
  if (!detected) throw new Error('图片格式不在白名单内');
  if (mime && mime !== detected.mime) throw new Error('图片 MIME 与文件内容不一致');
  if (!config.limits.allowedImageMime.has(detected.mime)) throw new Error(`不允许的图片 MIME：${detected.mime}`);

  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${detected.ext}`;
  const filePath = path.join(config.uploadDir, name);
  fs.writeFileSync(filePath, buffer, { mode: 0o640 });
  return { path: filePath, mime: detected.mime, size: buffer.length, name };
}

function audioExtFromMime(mime) {
  if (!mime) return '.audio';
  const ext = extension(mime);
  return ext ? `.${ext}` : '.audio';
}

function saveAudioBase64(content, meta = {}) {
  const { mime, buffer } = decodeBase64Payload(content);
  if (!buffer.length) throw new Error('音频内容为空');
  const effectiveMime = (mime || meta.mime || 'application/octet-stream').toLowerCase();
  const ext = audioExtFromMime(effectiveMime);
  const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const filePath = path.join(config.audioDir, name);
  fs.writeFileSync(filePath, buffer, { mode: 0o640 });
  return { path: filePath, mime: effectiveMime, size: buffer.length, name };
}

module.exports = { saveImageBase64, saveAudioBase64 };
