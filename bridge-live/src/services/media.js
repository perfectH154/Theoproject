const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
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
  { mime: 'image/gif', ext: '.gif', test: (buf) => ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString()) },
  { mime: 'image/heic', ext: '.heic', test: (buf) => buf.subarray(4, 12).toString().includes('ftypheic') || buf.subarray(4, 12).toString().includes('ftypheix') },
  { mime: 'image/heif', ext: '.heif', test: (buf) => buf.subarray(4, 12).toString().includes('ftypheif') || buf.subarray(4, 12).toString().includes('ftypmif1') }
];

const uploadMimeExtensions = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/markdown': '.md',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};

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

function normalizeConversationId(conversationId) {
  return String(conversationId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
}

function detectUploadMime(file) {
  const buffer = file.buffer || Buffer.alloc(0);
  const image = detectImage(buffer);
  if (image) return image;
  const declared = String(file.mimetype || 'application/octet-stream').toLowerCase();
  if (config.limits.allowedUploadMime.has(declared)) {
    return { mime: declared, ext: uploadMimeExtensions[declared] || `.${extension(declared) || 'bin'}` };
  }
  const originalExt = path.extname(file.originalname || '').toLowerCase();
  if (originalExt === '.md') return { mime: 'text/markdown', ext: '.md' };
  if (originalExt === '.txt') return { mime: 'text/plain', ext: '.txt' };
  throw new Error(`unsupported file type: ${declared}`);
}

function saveUploadedFile(file, { conversationId = 'default' } = {}) {
  if (!file?.buffer?.length) throw new Error('file is empty');
  if (file.buffer.length > config.limits.maxUploadBytes) throw new Error('file exceeds upload limit');
  const detected = detectUploadMime(file);
  if (!config.limits.allowedUploadMime.has(detected.mime)) {
    throw new Error(`file MIME not allowed: ${detected.mime}`);
  }

  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const fileId = `${Date.now()}-${hash.slice(0, 16)}`;
  const convDir = path.join(config.uploadDir, normalizeConversationId(conversationId), 'staging');
  ensureDir(convDir);
  const safeOriginal = String(file.originalname || 'attachment').replace(/[^\w.\-()\u4e00-\u9fff ]/g, '_').slice(0, 120);
  const fileName = `${fileId}${detected.ext}`;
  const filePath = path.join(convDir, fileName);
  fs.writeFileSync(filePath, file.buffer, { mode: 0o640 });
  return {
    id: fileId,
    file_id: fileId,
    file_path: filePath,
    url: `/api/files/${encodeURIComponent(fileId)}`,
    name: safeOriginal,
    originalName: safeOriginal,
    type: detected.mime.startsWith('image/') ? 'image' : 'document',
    mime: detected.mime,
    size: file.buffer.length,
    hash
  };
}

function resolveAttachmentPath(attachment) {
  const filePath = String(attachment?.file_path || attachment?.path || '');
  const resolvedBase = path.resolve(config.uploadDir);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error('invalid attachment path');
  }
  return resolved;
}

function findAttachmentById(fileId) {
  const clean = String(fileId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return null;
  const stack = [config.uploadDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.startsWith(`${clean}.`)) {
        return full;
      }
    }
  }
  return null;
}

function trimAttachmentText(text) {
  const clean = String(text || '').replace(/\r/g, '').trim();
  const max = config.limits.maxAttachmentTextChars;
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n\n[attachment text truncated at ${max} chars]`;
}

async function extractAttachmentText(attachment) {
  const mime = String(attachment?.mime || '').toLowerCase();
  const filePath = resolveAttachmentPath(attachment);
  if (!fs.existsSync(filePath)) throw new Error(`attachment missing: ${attachment?.name || attachment?.file_id}`);

  if (mime.startsWith('image/')) return '';
  if (mime === 'text/plain' || mime === 'text/markdown' || mime === 'application/markdown') {
    return trimAttachmentText(fs.readFileSync(filePath, 'utf8'));
  }
  if (mime === 'application/pdf') {
    const data = await pdfParse(fs.readFileSync(filePath));
    return trimAttachmentText(data.text || '');
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ path: filePath });
    return trimAttachmentText(result.value || '');
  }
  return '';
}

async function buildAttachmentPrompt(attachments = []) {
  const parts = [];
  const normalized = [];
  for (const item of attachments || []) {
    const attachment = {
      id: item.id || item.file_id,
      file_id: item.file_id || item.id,
      file_path: item.file_path || item.path,
      url: item.url,
      name: item.name || item.filename || item.file_id || 'attachment',
      originalName: item.originalName || item.name || item.filename || item.file_id || 'attachment',
      type: item.type || 'document',
      mime: item.mime || 'application/octet-stream',
      size: Number(item.size || 0)
    };
    const filePath = resolveAttachmentPath(attachment);
    attachment.file_path = filePath;
    normalized.push(attachment);
    if (String(attachment.mime).startsWith('image/')) {
      parts.push(`Image attachment: ${attachment.name}\nMIME: ${attachment.mime}\nClaude Code file reference: @${filePath}\nPath: ${filePath}`);
      continue;
    }
    const text = await extractAttachmentText(attachment);
    parts.push([
      `Document attachment: ${attachment.name}`,
      `MIME: ${attachment.mime}`,
      `Path: ${filePath}`,
      text ? `Extracted content:\n${text}` : '[No extractable text]'
    ].join('\n'));
  }
  return { attachments: normalized, prompt: parts.join('\n\n---\n\n') };
}

module.exports = {
  saveImageBase64,
  saveAudioBase64,
  saveUploadedFile,
  buildAttachmentPrompt,
  findAttachmentById
};
