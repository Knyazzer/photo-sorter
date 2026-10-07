const fs = require('fs/promises');
const path = require('path');
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* npm install will enable thumbnail generation */ }
const { fromRelative } = require('./files');

const CACHE_DIR = path.resolve(process.env.PHOTO_SORTER_CACHE || path.join(__dirname, '..', 'data', 'thumb-cache'));
const inflight = new Map();

function safeToken(value, fallback = 'unknown') {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return clean || fallback;
}

function thumbnailPath(photo) {
  const revision = safeToken(photo.content_hash ? String(photo.content_hash).slice(0, 20) : `${photo.size_bytes || 0}-${Math.round(photo.mtime_ms || 0)}`);
  return path.join(CACHE_DIR, `${safeToken(photo.id)}-${revision}.webp`);
}

async function exists(filePath) {
  try { return (await fs.stat(filePath)).isFile(); } catch (_) { return false; }
}

async function ensureThumbnail(root, photo) {
  if (!sharp) throw new Error('Модуль sharp не установлен');
  const target = thumbnailPath(photo);
  if (await exists(target)) return target;
  if (inflight.has(target)) return inflight.get(target);

  const job = (async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const source = fromRelative(root, photo.current_relative_path);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp.webp`;
    try {
      await sharp(source, { failOn: 'warning' })
        .rotate()
        .resize({ width: 560, height: 420, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76, effort: 3 })
        .toFile(temp);
      try {
        await fs.rename(temp, target);
      } catch (err) {
        if (!(await exists(target))) throw err;
        try { await fs.unlink(temp); } catch (_) {}
      }
      return target;
    } catch (err) {
      try { await fs.unlink(temp); } catch (_) {}
      throw err;
    }
  })();

  inflight.set(target, job);
  try { return await job; }
  finally { inflight.delete(target); }
}

module.exports = { CACHE_DIR, ensureThumbnail, thumbnailPath };
