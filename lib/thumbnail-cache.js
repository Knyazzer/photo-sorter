const fs = require('fs/promises');
const path = require('path');
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* npm install will enable thumbnail generation */ }
const { fromRelative } = require('./files');

const CACHE_DIR = path.resolve(process.env.PHOTO_SORTER_CACHE || path.join(__dirname, '..', 'data', 'thumb-cache'));
const inflight = new Map();

const VARIANTS = Object.freeze({
  grid: { width: 360, height: 270, quality: 68, effort: 2 },
  preview: { width: 1280, height: 960, quality: 78, effort: 3 },
});

function safeToken(value, fallback = 'unknown') {
  const clean = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return clean || fallback;
}

function photoRevision(photo) {
  const hash = photo?.content_hash || photo?.contentRevision;
  if (hash) return safeToken(String(hash).slice(0, 24));
  const size = photo?.size_bytes ?? photo?.sizeBytes ?? 0;
  const mtime = photo?.mtime_ms ?? photo?.mtimeMs ?? 0;
  return safeToken(`${size}-${Math.round(Number(mtime) || 0)}`);
}

function photoRelativePath(photo) {
  return photo?.current_relative_path || photo?.relativePath || '';
}

function thumbnailPath(photo, variant = 'grid') {
  const preset = VARIANTS[variant];
  if (!preset) throw new Error(`Неизвестный размер thumbnail: ${variant}`);
  return path.join(CACHE_DIR, `${safeToken(photo.id)}-${photoRevision(photo)}-${variant}.webp`);
}

async function exists(filePath) {
  try { return (await fs.stat(filePath)).isFile(); } catch (_) { return false; }
}

async function ensureThumbnail(root, photo, variant = 'grid') {
  if (!sharp) throw new Error('Модуль sharp не установлен');
  if (!photo?.id) throw new Error('Для thumbnail требуется photo_id');
  const sourceRelative = photoRelativePath(photo);
  if (!sourceRelative) throw new Error('У фотографии отсутствует путь');

  const preset = VARIANTS[variant];
  if (!preset) throw new Error(`Неизвестный размер thumbnail: ${variant}`);

  const target = thumbnailPath(photo, variant);
  if (await exists(target)) return target;
  if (inflight.has(target)) return inflight.get(target);

  const job = (async () => {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const source = fromRelative(root, sourceRelative);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp.webp`;
    try {
      await sharp(source, { failOn: 'warning', sequentialRead: true })
        .rotate()
        .resize({ width:preset.width, height:preset.height, fit:'inside', withoutEnlargement:true })
        .webp({ quality:preset.quality, effort:preset.effort, smartSubsample:true })
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

async function warmThumbnails(root, photos, { variant = 'grid', concurrency = 2, onProgress = null } = {}) {
  if (!sharp) return { total:photos?.length || 0, generated:0, failed:0, skipped:true };
  const queue = (photos || []).filter(photo => photo && !photo.missing && photo.id && photoRelativePath(photo));
  const total = queue.length;
  let next = 0;
  let generated = 0;
  let failed = 0;

  const workers = Array.from({ length:Math.max(1, Math.min(8, Number(concurrency) || 2)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= total) return;
      try {
        await ensureThumbnail(root, queue[index], variant);
        generated += 1;
      } catch (_) {
        failed += 1;
      }
      if (onProgress) onProgress({ done:generated + failed, total, generated, failed });
    }
  });

  await Promise.all(workers);
  return { total, generated, failed, skipped:false };
}

module.exports = { CACHE_DIR, VARIANTS, ensureThumbnail, warmThumbnails, thumbnailPath };
