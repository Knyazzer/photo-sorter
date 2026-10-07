const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const store = require('./photo-store');
const {
  RAW_DIR,
  PEOPLE_DIR,
  EQUIPMENT_DIR,
  listHalls,
  ensureHallStructure,
  enumerateHallImages,
  listProjectDirectory,
  safeExistingPath,
  toRelative,
  fromRelative,
  moveFileStrict,
  fileExists,
  validateHallName,
  validatePersonName,
} = require('./files');
const {
  parseOriginalPhotoName,
  parsePersonPhotoName,
  parseEquipmentPhotoName,
  buildPersonFilename,
  buildEquipmentFilename,
} = require('./photo-name');
const { extractMetadata } = require('./photo-metadata');

let operationTail = Promise.resolve();
function withOperationLock(fn) {
  const run = operationTail.then(fn, fn);
  operationTail = run.catch(() => {});
  return run;
}

function photoNumberFromName(name) {
  return parseOriginalPhotoName(name)?.photoNumber
    || parsePersonPhotoName(name)?.photoNumber
    || parseEquipmentPhotoName(name)?.photoNumber
    || null;
}

function dayFromName(name) {
  return parseOriginalPhotoName(name)?.day
    || parsePersonPhotoName(name)?.day
    || parseEquipmentPhotoName(name)?.day
    || null;
}

function parsedShotAt(name) {
  return parseOriginalPhotoName(name)?.shotAt || null;
}

async function contentFingerprint(filePath, stat = null) {
  stat = stat || await fs.stat(filePath);
  const chunkSize = Math.min(64 * 1024, stat.size);
  const handle = await fs.open(filePath, 'r');
  try {
    const first = Buffer.alloc(chunkSize);
    const last = Buffer.alloc(chunkSize);
    const firstRead = chunkSize ? (await handle.read(first, 0, chunkSize, 0)).bytesRead : 0;
    const lastPos = Math.max(0, stat.size - chunkSize);
    const lastRead = chunkSize ? (await handle.read(last, 0, chunkSize, lastPos)).bytesRead : 0;
    const hash = crypto.createHash('sha256');
    hash.update(String(stat.size));
    hash.update(first.subarray(0, firstRead));
    if (lastPos > 0) hash.update(last.subarray(0, lastRead));
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function clientPhoto(photo) {
  if (!photo) return null;
  return {
    id: photo.id,
    hall: photo.hall_name,
    name: photo.current_filename,
    originalFilename: photo.original_filename,
    relativePath: photo.current_relative_path,
    status: photo.status,
    category: photo.category,
    personId: photo.person_id,
    personName: photo.person_name,
    shotAt: photo.shot_at,
    photoNumber: photo.photo_number,
    missing: Boolean(photo.missing),
    version: Number(photo.version || 1),
    contentRevision: photo.content_hash ? String(photo.content_hash).slice(0, 16) : null,
  };
}

async function syncFilesystem(root) {
  root = path.resolve(root);
  const hallNames = await listHalls(root);
  const scanRows = [];
  let newMetadataReads = 0;

  for (const hallName of hallNames) {
    validateHallName(hallName);
    await ensureHallStructure(root, hallName);
    const hall = store.ensureHall(hallName);
    const items = await enumerateHallImages(root, hallName);
    for (const item of items) {
      const relativePath = toRelative(root, item.absolutePath);
      const existing = store.findPhotoByPath(relativePath);
      const person = item.personName ? store.ensurePerson(hall.id, validatePersonName(item.personName)) : null;
      const stat = await fs.stat(item.absolutePath);
      const contentChanged = !existing || Number(existing.size_bytes) !== Number(stat.size) || Number(existing.mtime_ms) !== Number(stat.mtimeMs);
      const contentHash = (!contentChanged && existing?.content_hash) || await contentFingerprint(item.absolutePath, stat);
      const parsed = parseOriginalPhotoName(item.name);
      let metadata = null;
      let shotAt = existing?.shot_at || parsed?.shotAt || null;
      if (!existing || !existing.metadata_json || !shotAt) {
        try {
          metadata = await extractMetadata(item.absolutePath);
          newMetadataReads += 1;
          shotAt = metadata.shotAt || shotAt;
        } catch (_) {
          metadata = null;
        }
      }
      const originalFilename = existing?.original_filename
        || (parsed ? item.name : item.name);
      scanRows.push({
        hallId: hall.id,
        currentRelativePath: relativePath,
        currentFilename: item.name,
        originalFilename,
        status: item.status,
        category: item.category,
        personId: person?.id ?? null,
        shotAt,
        photoNumber: existing?.photo_number || photoNumberFromName(item.name),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        metadata,
        contentHash,
      });
    }
  }

  store.transaction(() => {
    store.markAllMissing();
    for (const row of scanRows) store.upsertScannedPhoto(row);
  });

  const missing = store.listPhotos({ includeMissing: true }).filter(p => p.missing).length;
  return { halls: hallNames.length, photos: scanRows.length, missing, metadataReads: newMetadataReads };
}

async function initializeRoot(root) {
  const resolved = path.resolve(root);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Корень проекта должен быть папкой');
  store.setSelectedRoot(resolved);
  return syncFilesystem(resolved);
}

async function browserList(root, relativePath = '') {
  const data = await listProjectDirectory(root, relativePath);
  data.images = data.images.map(item => {
    const photo = store.findPhotoByPath(item.relativePath);
    return { ...item, photo: clientPhoto(photo) };
  });
  return data;
}

async function photoMetadata(root, relativePath) {
  const absolute = await safeExistingPath(root, relativePath);
  const metadata = await extractMetadata(absolute);
  const photo = store.findPhotoByPath(toRelative(root, absolute));
  return {
    filename: path.basename(absolute),
    relativePath: toRelative(root, absolute),
    sizeBytes: metadata.sizeBytes,
    format: metadata.format,
    width: metadata.width,
    height: metadata.height,
    shotAt: photo?.shot_at || metadata.shotAt || parsedShotAt(path.basename(absolute)),
    fileModifiedAt: metadata.fileModifiedAt,
    fileCreatedAt: metadata.fileCreatedAt,
    exif: metadata.exif,
    photo: clientPhoto(photo),
  };
}

function mode1Photos() {
  return store.listPhotos({ statuses: ['raw','people','person','equipment'] }).map(clientPhoto);
}
function thumbnailCandidates() {
  return store.listPhotos({ statuses: ['raw','people','person','equipment'] }).filter(photo => !photo.missing);
}

function mode2Data(hallName) {
  validateHallName(hallName);
  const hall = store.getHallByName(hallName);
  if (!hall) return { hall: hallName, people: [], photos: [] };
  return {
    hall: hallName,
    people: store.listPeopleByHall(hall.id).map(p => ({ id:Number(p.id), name:p.name, photoCount:Number(p.photo_count || 0) })),
    photos: store.listPhotos({ hallId: hall.id, statuses:['people','person'] }).map(clientPhoto),
  };
}

async function addPerson(root, hallName, name) {
  hallName = validateHallName(hallName);
  name = validatePersonName(name);
  const hall = store.getHallByName(hallName) || store.ensureHall(hallName);
  const existing = store.listPeopleByHall(hall.id).find(p => p.name.localeCompare(name, 'ru', { sensitivity:'base' }) === 0);
  if (existing) return { id:Number(existing.id), name:existing.name, photoCount:Number(existing.photo_count || 0) };
  await fs.mkdir(path.join(root, hallName, PEOPLE_DIR, name), { recursive:true });
  const person = store.createPerson(hall.id, name);
  return { id:Number(person.id), name:person.name, photoCount:0 };
}

function destinationFor(root, photo, target, person = null) {
  const hall = validateHallName(photo.hall_name);
  const original = path.basename(photo.original_filename || photo.current_filename);
  const extension = path.extname(original || photo.current_filename).toLowerCase() || path.extname(photo.current_filename).toLowerCase();
  if (target === 'raw') {
    return { absolute:path.join(root,hall,RAW_DIR,original), filename:original, status:'raw', category:null, personId:null };
  }
  if (target === 'people') {
    return { absolute:path.join(root,hall,PEOPLE_DIR,original), filename:original, status:'people', category:'people', personId:null };
  }
  if (target === 'equipment') {
    const filename = buildEquipmentFilename(photo, extension);
    return { absolute:path.join(root,hall,EQUIPMENT_DIR,filename), filename, status:'equipment', category:'equipment', personId:null };
  }
  if (target === 'person') {
    if (!person) throw new Error('Не указан человек');
    const filename = buildPersonFilename(person.name, { ...photo, day:dayFromName(photo.original_filename) || dayFromName(photo.current_filename) }, extension);
    return { absolute:path.join(root,hall,PEOPLE_DIR,person.name,filename), filename, status:'person', category:'people', personId:Number(person.id) };
  }
  throw new Error('Неизвестное целевое состояние');
}

async function movePhotos(root, photoIds, target, { person = null, userId = 'local', logHistory = true, expectedVersions = null } = {}) {
  const uniqueIds = [...new Set((photoIds || []).map(String).filter(Boolean))];
  if (!uniqueIds.length) throw new Error('Не выбраны фотографии');
  return withOperationLock(async () => {
    const photos = store.getPhotos(uniqueIds);
    if (photos.length !== uniqueIds.length) throw new Error('Одна или несколько фотографий не найдены в БД');
    if (expectedVersions && typeof expectedVersions === 'object') {
      for (const photo of photos) {
        const expected = expectedVersions[photo.id];
        if (expected != null && Number(expected) !== Number(photo.version || 1)) {
          const err = new Error(`Фотография «${photo.current_filename}» уже была изменена в другой сессии.`);
          err.statusCode = 409;
          throw err;
        }
      }
    }
    const plans = [];
    const targetPaths = new Set();
    for (const photo of photos) {
      if (photo.missing) throw new Error(`Файл отсутствует на диске: ${photo.current_filename}`);
      if (target === 'person' && !['people','person'].includes(photo.status)) {
        throw new Error('Назначать ФИО можно только фотографиям, уже находящимся в «Люди»');
      }
      if (person && Number(person.hall_id) !== Number(photo.hall_id)) throw new Error('Нельзя переносить фотографию между залами');
      const source = fromRelative(root, photo.current_relative_path);
      const dest = destinationFor(root, photo, target, person);
      const targetRelative = toRelative(root, dest.absolute);
      if (source !== dest.absolute) {
        if (targetPaths.has(targetRelative.toLocaleLowerCase('ru'))) throw new Error(`Конфликт целевых имён: ${dest.filename}`);
        targetPaths.add(targetRelative.toLocaleLowerCase('ru'));
        if (await fileExists(dest.absolute)) throw new Error(`Файл уже существует: ${targetRelative}`);
      }
      plans.push({ photo, source, dest, targetRelative });
    }

    const batchId = store.createBatchId();
    const moved = [];
    try {
      for (const plan of plans) {
        const samePath = path.resolve(plan.source) === path.resolve(plan.dest.absolute);
        const sameState = plan.photo.status === plan.dest.status && Number(plan.photo.person_id || 0) === Number(plan.dest.personId || 0);
        if (samePath && sameState) continue;
        if (!samePath) await moveFileStrict(plan.source, plan.dest.absolute);
        store.updatePhoto(plan.photo.id, {
          current_filename: plan.dest.filename,
          current_relative_path: plan.targetRelative,
          status: plan.dest.status,
          category: plan.dest.category,
          person_id: plan.dest.personId,
          missing: 0,
        }, expectedVersions?.[plan.photo.id] ?? plan.photo.version ?? null);
        moved.push(plan);
      }
      if (logHistory) {
        store.transaction(() => {
          for (const plan of moved) {
            store.logOperation({
              batchId, userId, photoId:plan.photo.id, action:`${plan.photo.status}->${plan.dest.status}`,
              fromPath:plan.photo.current_relative_path, toPath:plan.targetRelative,
              oldFilename:plan.photo.current_filename, newFilename:plan.dest.filename,
              oldStatus:plan.photo.status, newStatus:plan.dest.status,
              oldPersonId:plan.photo.person_id, newPersonId:plan.dest.personId,
            });
          }
        });
      }
      return moved.map(p => clientPhoto(store.getPhoto(p.photo.id)));
    } catch (err) {
      for (const plan of moved.reverse()) {
        try {
          if (path.resolve(plan.source) !== path.resolve(plan.dest.absolute) && await fileExists(plan.dest.absolute) && !(await fileExists(plan.source))) {
            await moveFileStrict(plan.dest.absolute, plan.source);
          }
          store.updatePhoto(plan.photo.id, {
            current_filename: plan.photo.current_filename,
            current_relative_path: plan.photo.current_relative_path,
            status: plan.photo.status,
            category: plan.photo.category,
            person_id: plan.photo.person_id,
            missing: plan.photo.missing,
          });
        } catch (rollbackErr) {
          console.error('Rollback failed:', rollbackErr);
        }
      }
      throw err;
    }
  });
}

async function assignPhotos(root, photoIds, personId, userId = 'local', expectedVersions = null) {
  const person = store.getPerson(Number(personId));
  if (!person) throw new Error('ФИО не найдено');
  return movePhotos(root, photoIds, 'person', { person, userId, expectedVersions });
}

async function renamePerson(root, personId, newName) {
  return withOperationLock(async () => {
    const person = store.getPerson(Number(personId));
    if (!person) throw new Error('ФИО не найдено');
    newName = validatePersonName(newName);
    if (person.name.localeCompare(newName, 'ru', { sensitivity:'base' }) === 0) return store.renamePerson(person.id, newName);
    const hall = store.db.prepare('SELECT * FROM halls WHERE id=?').get(person.hall_id);
    const collision = store.listPeopleByHall(person.hall_id).find(p => Number(p.id)!==Number(person.id) && p.name.localeCompare(newName,'ru',{sensitivity:'base'})===0);
    if (collision) throw new Error('Такое ФИО уже существует');
    const photos = store.photosForPerson(person.id);
    const targetDir = path.join(root, hall.name, PEOPLE_DIR, newName);
    if (await fileExists(targetDir)) throw new Error('Папка с новым ФИО уже существует');
    await fs.mkdir(targetDir, { recursive:true });
    const moved = [];
    try {
      for (const photo of photos) {
        const source = fromRelative(root, photo.current_relative_path);
        const filename = buildPersonFilename(newName, { ...photo, day:dayFromName(photo.original_filename)||dayFromName(photo.current_filename) }, path.extname(photo.current_filename));
        const target = path.join(targetDir, filename);
        if (await fileExists(target)) throw new Error(`Файл уже существует: ${filename}`);
        await moveFileStrict(source, target);
        const relative = toRelative(root, target);
        store.updatePhoto(photo.id, { current_filename:filename, current_relative_path:relative });
        moved.push({photo,source,target});
      }
      store.renamePerson(person.id, newName);
      store.invalidateAllUndo();
      const oldDir = path.join(root, hall.name, PEOPLE_DIR, person.name);
      try { await fs.rmdir(oldDir); } catch (_) {}
      return { id:Number(person.id), name:newName, photoCount:photos.length, photos:photos.map(photo => clientPhoto(store.getPhoto(photo.id))) };
    } catch (err) {
      for (const item of moved.reverse()) {
        try {
          if (await fileExists(item.target) && !(await fileExists(item.source))) await moveFileStrict(item.target,item.source);
          store.updatePhoto(item.photo.id,{current_filename:item.photo.current_filename,current_relative_path:item.photo.current_relative_path});
        } catch (_) {}
      }
      try { await fs.rmdir(targetDir); } catch (_) {}
      throw err;
    }
  });
}

async function deletePerson(root, personId, confirmed = false) {
  const person = store.getPerson(Number(personId));
  if (!person) throw new Error('ФИО не найдено');
  const hall = store.db.prepare('SELECT * FROM halls WHERE id=?').get(person.hall_id);
  const photos = store.photosForPerson(person.id);
  if (photos.length && !confirmed) return { requiresConfirmation:true, count:photos.length, personName:person.name };
  // Удаление ФИО не отменяет первичную классификацию «Люди».
  // Фото возвращаются в корень Зал/Люди, а не в RAW.
  const returned = photos.length ? await movePhotos(root, photos.map(p=>p.id), 'people', { logHistory:false }) : [];
  const dir = path.join(root, hall.name, PEOPLE_DIR, person.name);
  try { await fs.rmdir(dir); } catch (err) { if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err; }
  store.deletePerson(person.id);
  store.invalidateAllUndo();
  return { ok:true, returnedToPeople:returned.length, photos:returned };
}


function getPhotoById(photoId) {
  const photo = store.getPhoto(String(photoId || ''));
  if (!photo || photo.missing) throw new Error('Фотография не найдена');
  return photo;
}

async function photoMetadataById(root, photoId) {
  const photo = getPhotoById(photoId);
  return photoMetadata(root, photo.current_relative_path);
}

async function undoLast(root, userId = 'local') {
  return withOperationLock(async () => {
    const operations = store.latestUndoBatch(userId);
    if (!operations.length) return { ok:false, message:'Нет действий для отмены' };
    const reversed = [];
    try {
      for (const op of operations) {
        const current = fromRelative(root, op.to_path);
        const original = fromRelative(root, op.from_path);
        if (!(await fileExists(current))) throw new Error(`Невозможно отменить: файл не найден — ${op.to_path}`);
        if (path.resolve(current)!==path.resolve(original) && await fileExists(original)) throw new Error(`Невозможно отменить: исходный путь уже занят — ${op.from_path}`);
        if (path.resolve(current)!==path.resolve(original)) await moveFileStrict(current, original);
        store.updatePhoto(op.photo_id, {
          current_filename:op.old_filename,
          current_relative_path:op.from_path,
          status:op.old_status,
          category:op.old_status === 'equipment' ? 'equipment' : (['people','person'].includes(op.old_status) ? 'people' : null),
          person_id:op.old_person_id,
          missing:0,
        });
        reversed.push(op);
      }
      store.markBatchUndone(operations[0].batch_id);
      return { ok:true, count:operations.length };
    } catch (err) {
      for (const op of reversed.reverse()) {
        try {
          const original = fromRelative(root, op.from_path);
          const current = fromRelative(root, op.to_path);
          if (path.resolve(current)!==path.resolve(original) && await fileExists(original) && !(await fileExists(current))) await moveFileStrict(original,current);
          store.updatePhoto(op.photo_id, {
            current_filename:op.new_filename,
            current_relative_path:op.to_path,
            status:op.new_status,
            category:op.new_status === 'equipment' ? 'equipment' : (['people','person'].includes(op.new_status) ? 'people' : null),
            person_id:op.new_person_id,
            missing:0,
          });
        } catch (_) {}
      }
      throw err;
    }
  });
}

module.exports = {
  thumbnailCandidates,
  clientPhoto,
  contentFingerprint,
  syncFilesystem,
  initializeRoot,
  browserList,
  photoMetadata,
  photoMetadataById,
  getPhotoById,
  mode1Photos,
  mode2Data,
  addPerson,
  renamePerson,
  deletePerson,
  movePhotos,
  assignPhotos,
  undoLast,
};
