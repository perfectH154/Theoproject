const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../../config');

// 书籍存到 Claude Code 的工作目录内，这样 Théo(claude -p，cwd=workdir)
// 能用自带的文件工具直接读取章节、用户高亮和笔记。
function baseDir() {
  return path.join(config.claude.workdir, 'books');
}

function uploadsDir() {
  return path.join(baseDir(), '.uploads');
}

function booksDir() {
  return baseDir();
}

function bookDir(bookId) {
  return path.join(baseDir(), sanitizeId(bookId));
}

function chaptersDir(bookId) {
  return path.join(bookDir(bookId), 'chapters');
}

function chapterDir(bookId, num) {
  return path.join(chaptersDir(bookId), String(num));
}

function imagesDir(bookId) {
  return path.join(bookDir(bookId), 'images');
}

function manifestPath(bookId) {
  return path.join(bookDir(bookId), 'manifest.json');
}

// 防目录穿越：bookId / filename 只允许安全字符。
function sanitizeId(value) {
  const v = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!v || v === '.' || v === '..') throw new Error('非法 bookId');
  return v;
}

async function ensureBookDir(bookId) {
  await fsp.mkdir(chaptersDir(bookId), { recursive: true });
}

async function ensureChapterDir(bookId, num) {
  await fsp.mkdir(chapterDir(bookId, num), { recursive: true });
}

async function ensureImagesDir(bookId) {
  await fsp.mkdir(imagesDir(bookId), { recursive: true });
}

async function ensureUploadsDir() {
  await fsp.mkdir(uploadsDir(), { recursive: true });
}

async function readManifest(bookId) {
  try {
    return JSON.parse(await fsp.readFile(manifestPath(bookId), 'utf-8'));
  } catch {
    return null;
  }
}

async function writeManifest(manifest) {
  await ensureBookDir(manifest.bookId);
  await fsp.writeFile(manifestPath(manifest.bookId), JSON.stringify(manifest, null, 2), 'utf-8');
}

async function listManifests() {
  let entries;
  try {
    entries = await fsp.readdir(baseDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifest = await readManifest(entry.name);
    if (manifest) out.push(manifest);
  }
  return out;
}

module.exports = {
  baseDir,
  uploadsDir,
  booksDir,
  bookDir,
  chaptersDir,
  chapterDir,
  imagesDir,
  manifestPath,
  sanitizeId,
  ensureBookDir,
  ensureChapterDir,
  ensureImagesDir,
  ensureUploadsDir,
  readManifest,
  writeManifest,
  listManifests,
  // 同步存在性检查，路由里偶尔用。
  existsSync: fs.existsSync
};
