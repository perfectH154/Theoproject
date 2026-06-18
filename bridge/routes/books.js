const express = require('express');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');
const logger = require('../logger');
const { httpAuth } = require('../security');
const storage = require('../services/books/bookStorage');
const { parseEpub } = require('../services/books/epubParser');

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff'
};

// 「问 Théo」的后台任务表：jobId -> { status, text, error, at }。
// 因为 Claude 读一章再回复常常超过 Cloudflare 的 ~100s HTTP 上限，
// 所以改成「先秒回 jobId，后台跑，前端轮询结果」，避免 524 超时。
const bookJobs = new Map();
const jobCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of bookJobs) {
    if (now - job.at > 30 * 60 * 1000) bookJobs.delete(id);
  }
}, 5 * 60 * 1000);
if (typeof jobCleanup.unref === 'function') jobCleanup.unref();

// 章节正文图片 / 原始 epub 由 epub.js、<img> 加载，带不了 Authorization 头，
// 所以这两类静态资源允许用 ?token= 验证。
function assetAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = bearer || req.query.token;
  if (token && token === config.bridgeToken) return next();
  res.status(401).json({ ok: false, error: 'unauthorized' });
}

function num(req, name) {
  return Number.parseInt(req.params[name], 10);
}

function createBookRouter(claudeManager) {
  const router = express.Router();

  router.get('/', httpAuth, async (_req, res) => {
    res.json({ ok: true, books: await storage.listManifests() });
  });

  router.post('/import-epub', httpAuth, express.raw({ type: '*/*', limit: '200mb' }), async (req, res) => {
    try {
      const rawName = req.headers['x-filename'];
      const filename = typeof rawName === 'string' ? decodeURIComponent(rawName) : '';
      if (!filename.toLowerCase().endsWith('.epub')) {
        res.status(400).json({ ok: false, error: '文件名必须以 .epub 结尾' });
        return;
      }
      const buf = req.body;
      if (!buf || !buf.length) {
        res.status(400).json({ ok: false, error: '空文件' });
        return;
      }
      await storage.ensureUploadsDir();
      const safeName = `${Date.now()}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const dest = path.join(storage.uploadsDir(), safeName);
      await fsp.writeFile(dest, buf);

      const bookId = await parseEpub({ filePath: dest, onEvent: () => {} });
      const manifest = await storage.readManifest(bookId);
      logger.info('epub 导入完成', { bookId, chapters: manifest?.totalChapters });
      res.json({ ok: true, bookId, manifest });
    } catch (error) {
      logger.warn('epub 导入失败', { message: error.message });
      res.status(400).json({ ok: false, error: error.message });
    }
  });

  router.delete('/:bookId', httpAuth, async (req, res) => {
    try {
      await fsp.rm(storage.bookDir(req.params.bookId), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/:bookId/manifest', httpAuth, async (req, res) => {
    const manifest = await storage.readManifest(req.params.bookId);
    if (!manifest) {
      res.status(404).json({ ok: false, error: '书不存在' });
      return;
    }
    res.json(manifest);
  });

  router.get('/:bookId/chapters/:number', httpAuth, async (req, res) => {
    try {
      const dir = storage.chapterDir(req.params.bookId, num(req, 'number'));
      const [metaRaw, content] = await Promise.all([
        fsp.readFile(path.join(dir, 'metadata.json'), 'utf-8'),
        fsp.readFile(path.join(dir, 'raw.html'), 'utf-8')
      ]);
      const meta = JSON.parse(metaRaw);
      res.json({ number: meta.number, title: meta.title, sourceFile: meta.sourceFile, content });
    } catch {
      res.status(404).json({ ok: false, error: '章节不存在' });
    }
  });

  router.get('/:bookId/notes/:number', httpAuth, async (req, res) => {
    try {
      const content = await fsp.readFile(path.join(storage.chapterDir(req.params.bookId, num(req, 'number')), 'notes.md'), 'utf-8');
      res.json({ content });
    } catch {
      res.json({ content: '' });
    }
  });

  router.put('/:bookId/notes/:number', httpAuth, express.json({ limit: '2mb' }), async (req, res) => {
    const dir = storage.chapterDir(req.params.bookId, num(req, 'number'));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'notes.md'), String(req.body?.content ?? ''), 'utf-8');
    res.json({ ok: true });
  });

  router.get('/:bookId/highlights/:number', httpAuth, async (req, res) => {
    try {
      const raw = await fsp.readFile(path.join(storage.chapterDir(req.params.bookId, num(req, 'number')), 'highlights.json'), 'utf-8');
      res.json(JSON.parse(raw));
    } catch {
      res.json({ highlights: [] });
    }
  });

  router.put('/:bookId/highlights/:number', httpAuth, express.json({ limit: '4mb' }), async (req, res) => {
    const dir = storage.chapterDir(req.params.bookId, num(req, 'number'));
    await fsp.mkdir(dir, { recursive: true });
    const highlights = Array.isArray(req.body?.highlights) ? req.body.highlights : [];
    await fsp.writeFile(path.join(dir, 'highlights.json'), JSON.stringify({ highlights }, null, 2), 'utf-8');
    res.json({ ok: true });
  });

  router.get('/:bookId/progress', httpAuth, async (req, res) => {
    try {
      const raw = await fsp.readFile(path.join(storage.bookDir(req.params.bookId), 'progress.json'), 'utf-8');
      res.json(JSON.parse(raw));
    } catch {
      res.json({ percentage: 0, lastChapter: 1, lastLocation: null });
    }
  });

  router.put('/:bookId/progress', httpAuth, express.json({ limit: '64kb' }), async (req, res) => {
    await fsp.writeFile(
      path.join(storage.bookDir(req.params.bookId), 'progress.json'),
      JSON.stringify({
        percentage: req.body?.percentage ?? 0,
        lastChapter: req.body?.lastChapter ?? 1,
        lastLocation: req.body?.lastLocation ?? null
      }),
      'utf-8'
    );
    res.json({ ok: true });
  });

  router.get('/:bookId/epub', assetAuth, async (req, res) => {
    try {
      const manifest = await storage.readManifest(req.params.bookId);
      if (!manifest) throw new Error('not found');
      const buf = await fsp.readFile(path.join(storage.uploadsDir(), manifest.epubFile));
      res.setHeader('Content-Type', 'application/epub+zip');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(buf);
    } catch {
      res.status(404).json({ ok: false, error: 'epub 不存在' });
    }
  });

  router.get('/:bookId/images/:filename', assetAuth, async (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('/') || filename.includes('..')) {
      res.status(400).json({ ok: false, error: '非法文件名' });
      return;
    }
    try {
      const buf = await fsp.readFile(path.join(storage.imagesDir(req.params.bookId), filename));
      res.setHeader('Content-Type', MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      res.send(buf);
    } catch {
      res.status(404).json({ ok: false, error: '图片不存在' });
    }
  });

  // 「问 Théo」：立刻返回 jobId，后台跑 Claude turn，前端轮询 chat-result。
  router.post('/:bookId/chat', httpAuth, express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const bookId = storage.sanitizeId(req.params.bookId);
      const chapterNumber = Number.parseInt(req.body?.chapterNumber, 10);
      const content = String(req.body?.content || '').trim();
      const selection = String(req.body?.selection || '').trim();
      if (!content) {
        res.status(400).json({ ok: false, error: '内容不能为空' });
        return;
      }
      const manifest = await storage.readManifest(bookId);
      if (!manifest) {
        res.status(404).json({ ok: false, error: '书不存在' });
        return;
      }
      const chapter = manifest.chapters.find((c) => c.number === chapterNumber) || manifest.chapters[0];
      const chapterDir = storage.chapterDir(bookId, chapter.number);

      const sessionFile = path.join(chapterDir, 'theo-session.json');
      let resumeSessionId = '';
      try {
        resumeSessionId = JSON.parse(await fsp.readFile(sessionFile, 'utf-8')).claudeSessionId || '';
      } catch {
        // 第一次讨论，没有续聊 id。
      }

      const rel = `books/${bookId}/chapters/${chapter.number}`;
      const prompt = [
        '[阅读陪伴模式]',
        `用户正在读《${manifest.bookTitle}》(作者 ${manifest.bookAuthor}) 第 ${chapter.number} 章「${chapter.title}」。`,
        '相关文件（都在你的工作目录里，请用文件工具读取，不要凭空猜测原文）：',
        `- 本章正文：${rel}/raw.html`,
        `- 用户的高亮：${rel}/highlights.json（可能不存在，存在就读）`,
        `- 用户的笔记：${rel}/notes.md（可能不存在，存在就读）`,
        `- 全书目录：books/${bookId}/manifest.json（需要跨章时可 grep books/${bookId}/）`,
        '',
        selection ? `用户此刻选中的原文片段：\n「${selection}」\n` : '',
        `用户对你说：\n${content}`,
        '',
        '请先读上述文件理解上下文，再用用户的语言、简洁地和ta讨论。引用原文时点明位置。'
      ].filter(Boolean).join('\n');

      const jobId = crypto.randomUUID();
      bookJobs.set(jobId, { status: 'pending', at: Date.now() });
      res.json({ ok: true, jobId, chapterNumber: chapter.number });

      // 后台执行，不阻塞 HTTP 响应。
      (async () => {
        try {
          const result = await claudeManager.runTurn(prompt, { resumeSessionId });
          if (result.claudeSessionId) {
            await fsp.mkdir(chapterDir, { recursive: true });
            await fsp.writeFile(sessionFile, JSON.stringify({ claudeSessionId: result.claudeSessionId }), 'utf-8');
          }
          bookJobs.set(jobId, { status: 'done', text: result.text || '[无文本回复]', at: Date.now() });
        } catch (error) {
          logger.warn('book chat 后台失败', { message: error.message });
          bookJobs.set(jobId, { status: 'error', error: error.message, at: Date.now() });
        }
      })();
    } catch (error) {
      logger.warn('book chat 启动失败', { message: error.message });
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  router.get('/:bookId/chat-result/:jobId', httpAuth, (req, res) => {
    const job = bookJobs.get(req.params.jobId);
    if (!job) {
      res.json({ status: 'unknown' });
      return;
    }
    res.json(job);
  });

  return router;
}

module.exports = { createBookRouter };
