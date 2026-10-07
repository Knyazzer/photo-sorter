const fs = require('fs/promises');
const path = require('path');
const { fromRelative, assertInside, moveFileStrict, validateHallName, RAW_DIR, PEOPLE_DIR, EQUIPMENT_DIR } = require('./files');
const { isImageFile, isThumbnail } = require('./photo-name');

const MAX_FILE_BYTES = Math.max(10 * 1024 * 1024, Number(process.env.PHOTO_SORTER_MAX_UPLOAD_FILE_BYTES || 300 * 1024 * 1024));
const MAX_CHUNK_BYTES = Math.max(256 * 1024, Number(process.env.PHOTO_SORTER_MAX_UPLOAD_CHUNK_BYTES || 8 * 1024 * 1024));
const locks = new Map();

function httpError(message, statusCode = 400, extra = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function normalizeRelativeUploadPath(input) {
  const value = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = value.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..' || part.includes('\0'))) throw httpError('Некорректный путь файла');
  if (parts.length < 2) throw httpError('Файл должен находиться внутри папки зала');
  if (parts.length > 4) throw httpError('Слишком глубокая структура папок');
  const hall = validateHallName(parts[0]);
  const filename = parts[parts.length - 1];
  if (!isImageFile(filename) || isThumbnail(filename)) throw httpError('Разрешена загрузка только исходных фотографий');

  // Старый формат Hall/photo.jpg автоматически становится Hall/raw/photo.jpg.
  if (parts.length === 2) return path.join(hall, RAW_DIR, filename);

  const section = parts[1];
  if (![RAW_DIR, PEOPLE_DIR, EQUIPMENT_DIR].includes(section)) {
    throw httpError(`Неизвестный раздел «${section}». Ожидается raw, Люди или Оборудование`);
  }
  if ((section === RAW_DIR || section === EQUIPMENT_DIR) && parts.length !== 3) {
    throw httpError(`В «${section}» не поддерживаются дополнительные вложенные папки`);
  }
  if (section === PEOPLE_DIR && ![3, 4].includes(parts.length)) throw httpError('Некорректная структура папки «Люди»');
  return path.join(...parts);
}

async function statOrNull(filePath) {
  try { return await fs.stat(filePath); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

async function safeTarget(root, relativePath) {
  const normalized = normalizeRelativeUploadPath(relativePath);
  const target = fromRelative(root, normalized);
  const parent = path.dirname(target);
  await fs.mkdir(parent, { recursive:true });
  const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(parent)]);
  assertInside(realRoot, realParent);
  return { normalized, target, part:`${target}.upload-part` };
}

async function uploadStatus(root, relativePath, totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isSafeInteger(total) || total < 0 || total > MAX_FILE_BYTES) throw httpError('Некорректный размер файла', 400);
  const { normalized, target, part } = await safeTarget(root, relativePath);
  const finalStat = await statOrNull(target);
  if (finalStat) {
    if (finalStat.size === total) return { path:normalized, received:total, total, complete:true };
    return { path:normalized, received:finalStat.size, total, complete:false, conflict:true };
  }
  const partial = await statOrNull(part);
  return { path:normalized, received:partial?.size || 0, total, complete:false, conflict:false };
}

async function withFileLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  locks.set(key, queued);
  await previous;
  try { return await fn(); }
  finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function appendChunk(root, relativePath, totalBytes, offsetBytes, chunk) {
  const total = Number(totalBytes);
  const offset = Number(offsetBytes);
  if (!Number.isSafeInteger(total) || total <= 0 || total > MAX_FILE_BYTES) throw httpError('Некорректный размер файла');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) throw httpError('Некорректное смещение');
  if (!Buffer.isBuffer(chunk) || chunk.length <= 0 || chunk.length > MAX_CHUNK_BYTES) throw httpError('Некорректный размер chunk', 413);
  if (offset + chunk.length > total) throw httpError('Chunk выходит за размер файла');

  const { normalized, target, part } = await safeTarget(root, relativePath);
  return withFileLock(target, async () => {
    const finalStat = await statOrNull(target);
    if (finalStat) {
      if (finalStat.size === total) return { path:normalized, received:total, total, complete:true };
      throw httpError('В целевой папке уже существует файл с таким именем и другим размером', 409);
    }
    const partial = await statOrNull(part);
    const received = partial?.size || 0;
    if (received !== offset) throw httpError('Смещение не совпадает с уже загруженными данными', 409, { expectedOffset:received });
    await fs.appendFile(part, chunk);
    const next = offset + chunk.length;
    if (next === total) {
      await moveFileStrict(part, target);
      return { path:normalized, received:total, total, complete:true };
    }
    return { path:normalized, received:next, total, complete:false };
  });
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_CHUNK_BYTES,
  normalizeRelativeUploadPath,
  uploadStatus,
  appendChunk,
};
