const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const { parseDocument } = require('htmlparser2');
const { textContent } = require('domutils');
const storage = require('./bookStorage');

// 从 ReadingIsFun(MIT)的 epubParser 移植：纯正则 + JSZip，不依赖浏览器。
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.tiff']);

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function resolveHref(base, href) {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  return dir + href;
}

async function parseEpub({ filePath, onEvent = () => {} }) {
  const emit = (message) => onEvent({ type: 'log', message });

  emit('读取 EPUB 文件...');
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);

  const containerXml = await zip.file('META-INF/container.xml')?.async('string');
  if (!containerXml) throw new Error('无效 EPUB：缺少 container.xml');
  const opfPath = extractAttr(containerXml, 'rootfile', 'full-path');
  if (!opfPath) throw new Error('无效 EPUB：找不到 rootfile');

  const opfXml = await zip.file(opfPath)?.async('string');
  if (!opfXml) throw new Error(`无效 EPUB：缺少 ${opfPath}`);
  const metadata = extractMetadata(opfXml);
  const bookId = slugify(metadata.title || 'untitled') || `book-${Date.now()}`;
  emit(`书名:《${metadata.title}》 作者:${metadata.author}`);

  const manifestItems = extractManifestItems(opfXml);
  const spineIds = extractSpineIds(opfXml);
  const spineHrefs = spineIds.map((id) => manifestItems.get(id)).filter(Boolean);
  const resolvedHrefs = spineHrefs.map((href) => resolveHref(opfPath, href));

  const tocTitles = await extractTocTitles(zip, opfXml, opfPath);
  const coverImage = extractCoverImage(opfXml, manifestItems);

  const imageMap = new Map();
  await storage.ensureImagesDir(bookId);
  const imgDir = storage.imagesDir(bookId);
  let imageCount = 0;
  for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    const ext = zipPath.slice(zipPath.lastIndexOf('.')).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const imgName = zipPath.split('/').pop() || zipPath;
    await writeFile(path.join(imgDir, imgName), await zipEntry.async('nodebuffer'));
    imageMap.set(zipPath, imgName);
    imageCount += 1;
  }
  if (imageCount > 0) emit(`抽取 ${imageCount} 张图片`);

  const hrefToChapter = new Map();
  const navIds = extractNavIds(opfXml);
  const items = [];
  let num = 0;
  for (let i = 0; i < resolvedHrefs.length; i += 1) {
    if (navIds.has(spineIds[i])) continue;
    const href = resolvedHrefs[i];
    if (!zip.file(href)) continue;
    num += 1;
    items.push({ idx: i, href, spineHref: spineHrefs[i], num });
    hrefToChapter.set(href, num);
    hrefToChapter.set(spineHrefs[i], num);
    hrefToChapter.set(href.split('/').pop() || href, num);
  }

  const chapters = [];
  for (const item of items) {
    const raw = await zip.file(item.href)?.async('string');
    if (!raw) continue;

    let body = extractBody(raw);
    body = body.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    body = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    const fileName = item.href.split('/').pop() || item.href;
    const plainText = htmlToText(body);
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    const title = tocTitles.get(item.spineHref)
      || tocTitles.get(fileName)
      || extractHtmlTitle(body)
      || `Section ${item.num}`;

    const hrefDir = item.href.includes('/') ? item.href.slice(0, item.href.lastIndexOf('/') + 1) : '';
    body = body.replace(/(<a\s[^>]*href=")([^"]*)/gi, (_m, prefix, href) => {
      if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) return `${prefix}${href}`;
      const target = href.split('#')[0];
      const resolved = target.startsWith('/') ? target : hrefDir + target;
      const ch = hrefToChapter.get(resolved) || hrefToChapter.get(target) || hrefToChapter.get(target.split('/').pop() || target);
      return ch ? `${prefix}#theo-chapter-${ch}` : `${prefix}${href}`;
    });

    const chapterImages = [];
    body = body.replace(/(<img\s[^>]*src=")([^"]*)/gi, (_m, prefix, src) => {
      const resolvedSrc = src.startsWith('/') || src.startsWith('http') ? src : hrefDir + src;
      const imgName = imageMap.get(resolvedSrc) || findImageByName(imageMap, src);
      if (imgName) {
        if (!chapterImages.includes(imgName)) chapterImages.push(imgName);
        return `${prefix}/api/books/${bookId}/images/${imgName}`;
      }
      return `${prefix}${src}`;
    });

    emit(`${item.num}:《${title}》(${wordCount} 词${chapterImages.length ? `，${chapterImages.length} 图` : ''})`);

    await storage.ensureChapterDir(bookId, item.num);
    const dir = storage.chapterDir(bookId, item.num);
    await Promise.all([
      writeFile(path.join(dir, 'raw.html'), body, 'utf-8'),
      writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ number: item.num, title, sourceFile: fileName, wordCount, images: chapterImages }, null, 2), 'utf-8')
    ]);

    chapters.push({ number: item.num, title, sourceFile: fileName, wordCount, images: chapterImages });
  }

  if (chapters.length === 0) throw new Error('EPUB 里没有解析到章节');

  const epubFileName = filePath.split('/').pop() || filePath;
  const manifest = {
    bookId,
    bookTitle: metadata.title,
    bookAuthor: metadata.author,
    language: metadata.language,
    coverImage: coverImage ? (imageMap.get(resolveHref(opfPath, coverImage)) || null) : null,
    epubFile: epubFileName,
    totalChapters: chapters.length,
    parsedAt: new Date().toISOString(),
    chapters
  };
  await storage.writeManifest(manifest);

  emit(`完成！导入 ${chapters.length} 章。`);
  onEvent({ type: 'done', bookId });
  return bookId;
}

// --- Helpers（与原项目逻辑一致）---

function extractBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : html;
}

function extractHtmlTitle(html) {
  for (const tag of ['h1', 'h2', 'h3']) {
    const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m) {
      const text = m[1].replace(/<[^>]*>/g, '').trim();
      if (text.length > 0 && text.length < 200) return text;
    }
  }
  return null;
}

function htmlToText(html) {
  const doc = parseDocument(html);
  return textContent(doc).replace(/\s+/g, ' ').trim();
}

function extractAttr(xml, tag, attr) {
  return xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, 'i'))?.[1] || null;
}

function extractMetadata(opfXml) {
  return {
    title: opfXml.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/i)?.[1]?.trim() || 'Untitled',
    author: opfXml.match(/<dc:creator[^>]*>([^<]*)<\/dc:creator>/i)?.[1]?.trim() || 'Unknown',
    language: opfXml.match(/<dc:language[^>]*>([^<]*)<\/dc:language>/i)?.[1]?.trim() || 'en'
  };
}

function extractManifestItems(opfXml) {
  const map = new Map();
  const re = /<item\s([^>]*)>/gi;
  let m;
  while ((m = re.exec(opfXml))) {
    const attrs = m[1];
    const id = attrs.match(/id="([^"]*)"/)?.[1];
    const href = attrs.match(/href="([^"]*)"/)?.[1];
    if (id && href) map.set(id, href);
  }
  return map;
}

function extractSpineIds(opfXml) {
  const ids = [];
  const re = /<itemref\s[^>]*idref="([^"]*)"/gi;
  let m;
  while ((m = re.exec(opfXml))) ids.push(m[1]);
  return ids;
}

function extractNavIds(opfXml) {
  const ids = new Set();
  const re = /<item\s([^>]*)>/gi;
  let m;
  while ((m = re.exec(opfXml))) {
    if (/properties="[^"]*nav[^"]*"/i.test(m[1])) {
      const id = m[1].match(/id="([^"]*)"/)?.[1];
      if (id) ids.add(id);
    }
  }
  return ids;
}

function findImageByName(imageMap, src) {
  const name = src.split('/').pop() || src;
  for (const [, saved] of imageMap) {
    if (saved === name) return saved;
  }
  return null;
}

async function extractTocTitles(zip, opfXml, opfPath) {
  const titles = new Map();

  const ncxId = opfXml.match(/<spine[^>]*toc="([^"]*)"/i)?.[1];
  if (ncxId) {
    const items = extractManifestItems(opfXml);
    const ncxHref = items.get(ncxId);
    if (ncxHref) {
      const ncxXml = await zip.file(resolveHref(opfPath, ncxHref))?.async('string');
      if (ncxXml) {
        const re = /<navPoint[^>]*>[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\s[^>]*src="([^"]*)"[^>]*\/>[\s\S]*?<\/navPoint>/gi;
        let m;
        while ((m = re.exec(ncxXml))) {
          const label = m[1].replace(/<[^>]*>/g, '').trim();
          if (label) titles.set(m[2].split('#')[0], label);
        }
      }
    }
  }

  if (titles.size === 0) {
    let navHref;
    const re = /<item\s([^>]*)>/gi;
    let m;
    while ((m = re.exec(opfXml))) {
      if (/properties="[^"]*nav[^"]*"/i.test(m[1])) {
        navHref = m[1].match(/href="([^"]*)"/)?.[1];
        break;
      }
    }
    if (navHref) {
      const navXml = await zip.file(resolveHref(opfPath, navHref))?.async('string');
      if (navXml) {
        const aRe = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m2;
        while ((m2 = aRe.exec(navXml))) {
          const label = m2[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          if (label) titles.set(m2[1].split('#')[0], label);
        }
      }
    }
  }

  return titles;
}

function extractCoverImage(opfXml, manifestItems) {
  const metaCover = opfXml.match(/<meta\s[^>]*name="cover"[^>]*content="([^"]*)"/i)?.[1];
  if (metaCover) {
    const href = manifestItems.get(metaCover);
    if (href) return href;
  }
  const re = /<item\s([^>]*)>/gi;
  let m;
  while ((m = re.exec(opfXml))) {
    if (/properties="[^"]*cover-image[^"]*"/i.test(m[1])) {
      return m[1].match(/href="([^"]*)"/)?.[1] || null;
    }
  }
  return null;
}

module.exports = { parseEpub };
