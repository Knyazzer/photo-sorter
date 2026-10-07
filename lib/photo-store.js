const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.PHOTO_SORTER_DATA || path.join(__dirname, '..', 'data'));
const DB_FILE = path.join(DATA_DIR, 'photo-sorter.sqlite');
require('fs').mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS halls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hall_id INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(hall_id, name)
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  hall_id INTEGER NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  current_filename TEXT NOT NULL,
  current_relative_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('raw','people','person','equipment','missing')),
  category TEXT CHECK(category IN ('people','equipment') OR category IS NULL),
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  shot_at TEXT,
  photo_number TEXT,
  size_bytes INTEGER,
  mtime_ms REAL,
  metadata_json TEXT,
  content_hash TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  missing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_photos_hall_status ON photos(hall_id, status);
CREATE INDEX IF NOT EXISTS idx_photos_person ON photos(person_id);
CREATE INDEX IF NOT EXISTS idx_photos_missing ON photos(missing);
CREATE INDEX IF NOT EXISTS idx_photos_content_hash ON photos(content_hash);

CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  old_filename TEXT NOT NULL,
  new_filename TEXT NOT NULL,
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  old_person_id INTEGER,
  new_person_id INTEGER,
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_operations_undo ON operations(user_id, undone_at, id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  mode TEXT,
  hall TEXT,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions(last_seen_at);
`);

// Lightweight migration for databases created by early 2.0 builds.
try { db.exec('ALTER TABLE photos ADD COLUMN content_hash TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE photos ADD COLUMN version INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_photos_content_hash ON photos(content_hash)'); } catch (_) {}

const now = () => new Date().toISOString();

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value == null ? null : String(value));
}

function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
}

function setSelectedRoot(root) {
  setSetting('selected_root', path.resolve(root));
  return path.resolve(root);
}

function getSelectedRoot() {
  return getSetting('selected_root');
}

function ensureHall(name) {
  const stamp = now();
  db.prepare('INSERT INTO halls(name,created_at) VALUES(?,?) ON CONFLICT(name) DO NOTHING').run(name, stamp);
  return db.prepare('SELECT * FROM halls WHERE name=? COLLATE NOCASE').get(name);
}

function listHalls() {
  return db.prepare('SELECT id,name FROM halls ORDER BY name COLLATE NOCASE').all();
}

function getHallByName(name) {
  return db.prepare('SELECT * FROM halls WHERE name=? COLLATE NOCASE').get(name) || null;
}

function ensurePerson(hallId, name) {
  const stamp = now();
  db.prepare(`INSERT INTO people(hall_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(hall_id,name) DO UPDATE SET updated_at=excluded.updated_at`).run(hallId, name, stamp, stamp);
  return db.prepare('SELECT * FROM people WHERE hall_id=? AND name=? COLLATE NOCASE').get(hallId, name);
}

function createPerson(hallId, name) {
  const stamp = now();
  const info = db.prepare('INSERT INTO people(hall_id,name,created_at,updated_at) VALUES(?,?,?,?)').run(hallId, name, stamp, stamp);
  return db.prepare('SELECT * FROM people WHERE id=?').get(info.lastInsertRowid);
}

function listPeopleByHall(hallId) {
  return db.prepare(`
    SELECT p.*, COUNT(ph.id) AS photo_count
    FROM people p
    LEFT JOIN photos ph ON ph.person_id=p.id AND ph.missing=0
    WHERE p.hall_id=?
    GROUP BY p.id
    ORDER BY p.name COLLATE NOCASE
  `).all(hallId);
}

function getPerson(id) {
  return db.prepare('SELECT * FROM people WHERE id=?').get(id) || null;
}

function renamePerson(id, name) {
  db.prepare('UPDATE people SET name=?, updated_at=? WHERE id=?').run(name, now(), id);
  return getPerson(id);
}

function deletePerson(id) {
  db.prepare('DELETE FROM people WHERE id=?').run(id);
}

function findPhotoByPath(relativePath) {
  return db.prepare(`
    SELECT ph.*, h.name AS hall_name, p.name AS person_name
    FROM photos ph
    JOIN halls h ON h.id=ph.hall_id
    LEFT JOIN people p ON p.id=ph.person_id
    WHERE ph.current_relative_path=?
  `).get(relativePath) || null;
}

function findMissingPhotoByHash(contentHash, sizeBytes) {
  if (!contentHash) return null;
  const rows = db.prepare(`
    SELECT ph.*, h.name AS hall_name, p.name AS person_name
    FROM photos ph
    JOIN halls h ON h.id=ph.hall_id
    LEFT JOIN people p ON p.id=ph.person_id
    WHERE ph.content_hash=? AND ph.size_bytes=? AND ph.missing=1
    LIMIT 2
  `).all(contentHash, sizeBytes);
  return rows.length === 1 ? rows[0] : null;
}

function getPhoto(id) {
  return db.prepare(`
    SELECT ph.*, h.name AS hall_name, p.name AS person_name
    FROM photos ph
    JOIN halls h ON h.id=ph.hall_id
    LEFT JOIN people p ON p.id=ph.person_id
    WHERE ph.id=?
  `).get(id) || null;
}

function getPhotos(ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(()=>'?').join(',');
  return db.prepare(`
    SELECT ph.*, h.name AS hall_name, p.name AS person_name
    FROM photos ph
    JOIN halls h ON h.id=ph.hall_id
    LEFT JOIN people p ON p.id=ph.person_id
    WHERE ph.id IN (${placeholders})
  `).all(...ids);
}

function listPhotos({ hallId = null, statuses = null, includeMissing = false } = {}) {
  const where = [];
  const params = [];
  if (hallId != null) { where.push('ph.hall_id=?'); params.push(hallId); }
  if (statuses?.length) {
    where.push(`ph.status IN (${statuses.map(()=>'?').join(',')})`);
    params.push(...statuses);
  }
  if (!includeMissing) where.push('ph.missing=0');
  return db.prepare(`
    SELECT ph.*, h.name AS hall_name, p.name AS person_name
    FROM photos ph
    JOIN halls h ON h.id=ph.hall_id
    LEFT JOIN people p ON p.id=ph.person_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY h.name COLLATE NOCASE, COALESCE(ph.shot_at,''), ph.photo_number+0, ph.current_filename COLLATE NOCASE
  `).all(...params);
}

function markAllMissing() {
  db.prepare('UPDATE photos SET missing=1, updated_at=?').run(now());
}

function upsertScannedPhoto({
  hallId, currentRelativePath, currentFilename, originalFilename, status, category = null,
  personId = null, shotAt = null, photoNumber = null, sizeBytes = null, mtimeMs = null, metadata = null, contentHash = null,
}) {
  const existing = findPhotoByPath(currentRelativePath);
  const stamp = now();
  if (existing) {
    db.prepare(`UPDATE photos SET hall_id=?, current_filename=?, status=?, category=?, person_id=?, shot_at=COALESCE(?,shot_at), photo_number=COALESCE(?,photo_number), size_bytes=?, mtime_ms=?, metadata_json=COALESCE(?,metadata_json), content_hash=COALESCE(?,content_hash), missing=0, updated_at=? WHERE id=?`)
      .run(hallId, currentFilename, status, category, personId, shotAt, photoNumber, sizeBytes, mtimeMs, metadata ? JSON.stringify(metadata) : null, contentHash, stamp, existing.id);
    return getPhoto(existing.id);
  }
  const moved = findMissingPhotoByHash(contentHash, sizeBytes);
  if (moved) {
    db.prepare(`UPDATE photos SET hall_id=?, current_filename=?, current_relative_path=?, status=?, category=?, person_id=?, shot_at=COALESCE(?,shot_at), photo_number=COALESCE(?,photo_number), size_bytes=?, mtime_ms=?, metadata_json=COALESCE(?,metadata_json), content_hash=COALESCE(?,content_hash), missing=0, updated_at=? WHERE id=?`)
      .run(hallId, currentFilename, currentRelativePath, status, category, personId, shotAt, photoNumber, sizeBytes, mtimeMs, metadata ? JSON.stringify(metadata) : null, contentHash, stamp, moved.id);
    db.prepare('UPDATE photos SET version=version+1 WHERE id=?').run(moved.id);
    return getPhoto(moved.id);
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO photos(id,hall_id,original_filename,current_filename,current_relative_path,status,category,person_id,shot_at,photo_number,size_bytes,mtime_ms,metadata_json,content_hash,version,missing,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
    .run(id, hallId, originalFilename || currentFilename, currentFilename, currentRelativePath, status, category, personId, shotAt, photoNumber, sizeBytes, mtimeMs, metadata ? JSON.stringify(metadata) : null, contentHash, stamp, stamp);
  return getPhoto(id);
}

function updatePhoto(id, patch, expectedVersion = null) {
  const allowed = ['current_filename','current_relative_path','status','category','person_id','shot_at','photo_number','size_bytes','mtime_ms','metadata_json','content_hash','missing','original_filename'];
  const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));
  if (!entries.length) return getPhoto(id);
  const sql = entries.map(([k]) => `${k}=?`).join(', ');
  const values = entries.map(([,v]) => kJson(v));
  values.push(now());
  let info;
  if (expectedVersion == null) {
    values.push(id);
    info = db.prepare(`UPDATE photos SET ${sql}, version=version+1, updated_at=? WHERE id=?`).run(...values);
  } else {
    values.push(id, Number(expectedVersion));
    info = db.prepare(`UPDATE photos SET ${sql}, version=version+1, updated_at=? WHERE id=? AND version=?`).run(...values);
  }
  if (!info.changes) {
    const err = new Error('Фотография уже была изменена в другой сессии. Состояние будет обновлено.');
    err.statusCode = 409;
    throw err;
  }
  return getPhoto(id);
}

function kJson(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return JSON.stringify(value);
  return value;
}

function createBatchId() { return crypto.randomUUID(); }

function logOperation(op) {
  db.prepare(`INSERT INTO operations(batch_id,user_id,photo_id,action,from_path,to_path,old_filename,new_filename,old_status,new_status,old_person_id,new_person_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(op.batchId, op.userId || 'local', op.photoId, op.action, op.fromPath, op.toPath, op.oldFilename, op.newFilename, op.oldStatus, op.newStatus, op.oldPersonId ?? null, op.newPersonId ?? null, now());
}

function latestUndoBatch(userId = 'local') {
  const row = db.prepare('SELECT batch_id FROM operations WHERE user_id=? AND undone_at IS NULL ORDER BY id DESC LIMIT 1').get(userId);
  if (!row) return [];
  return db.prepare('SELECT * FROM operations WHERE batch_id=? AND user_id=? AND undone_at IS NULL ORDER BY id DESC').all(row.batch_id, userId);
}

function markBatchUndone(batchId) {
  db.prepare('UPDATE operations SET undone_at=? WHERE batch_id=? AND undone_at IS NULL').run(now(), batchId);
}

function invalidateUndo(userId = 'local') {
  db.prepare('UPDATE operations SET undone_at=? WHERE user_id=? AND undone_at IS NULL').run(now(), userId);
}

function photosForPerson(personId) {
  return db.prepare(`
    SELECT ph.*, h.name AS hall_name, p.name AS person_name
    FROM photos ph
    JOIN halls h ON h.id=ph.hall_id
    LEFT JOIN people p ON p.id=ph.person_id
    WHERE ph.person_id=? AND ph.missing=0
    ORDER BY ph.current_filename COLLATE NOCASE
  `).all(personId);
}


function touchSession(id, { mode = null, hall = null } = {}) {
  id = String(id || '').trim();
  if (!id) return null;
  const stamp = now();
  const short = id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase() || 'LOCAL';
  const displayName = `Сессия ${short}`;
  db.prepare(`INSERT INTO sessions(id,display_name,mode,hall,last_seen_at) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET mode=excluded.mode, hall=excluded.hall, last_seen_at=excluded.last_seen_at`)
    .run(id, displayName, mode, hall, stamp);
  return db.prepare('SELECT * FROM sessions WHERE id=?').get(id) || null;
}

function listActiveSessions(maxAgeSeconds = 90) {
  const cutoff = new Date(Date.now() - Number(maxAgeSeconds || 90) * 1000).toISOString();
  return db.prepare('SELECT id,display_name,mode,hall,last_seen_at FROM sessions WHERE last_seen_at>=? ORDER BY last_seen_at DESC').all(cutoff);
}

function invalidateAllUndo() {
  db.prepare('UPDATE operations SET undone_at=? WHERE undone_at IS NULL').run(now());
}

function resetProjectData() {
  transaction(() => {
    db.exec('DELETE FROM operations; DELETE FROM photos; DELETE FROM people; DELETE FROM halls;');
  });
}

module.exports = {
  DB_FILE,
  db,
  transaction,
  setSetting,
  getSetting,
  setSelectedRoot,
  getSelectedRoot,
  ensureHall,
  listHalls,
  getHallByName,
  ensurePerson,
  createPerson,
  listPeopleByHall,
  getPerson,
  renamePerson,
  deletePerson,
  findPhotoByPath,
  findMissingPhotoByHash,
  getPhoto,
  getPhotos,
  listPhotos,
  markAllMissing,
  upsertScannedPhoto,
  updatePhoto,
  createBatchId,
  logOperation,
  latestUndoBatch,
  markBatchUndone,
  invalidateUndo,
  invalidateAllUndo,
  touchSession,
  listActiveSessions,
  photosForPerson,
  resetProjectData,
};
