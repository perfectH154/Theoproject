const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
}

function safeJoin(baseDir, fileName) {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, fileName);
  if (!resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error('非法文件路径');
  }
  return resolved;
}

module.exports = { ensureDir, safeJoin };
