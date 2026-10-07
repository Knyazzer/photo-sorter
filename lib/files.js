const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const os = require('os');
const {
  isImageFile,
  isThumbnail,
  comparePhotoNames,
} = require('./photo-name');

const RAW_DIR = 'raw';
const PEOPLE_DIR = 'Люди';
const EQUIPMENT_DIR = 'Оборудование';
const RESERVED_HALL_NAMES = new Set([RAW_DIR.toLowerCase(), PEOPLE_DIR.toLowerCase(), EQUIPMENT_DIR.toLowerCase()]);

function normalizeAbsolute(input) {
  return path.resolve(input);
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertInside(root, target) {
  if (!isInside(root, target)) throw new Error('Путь находится вне проекта');
}

function toRelative(root, absolute) {
  assertInside(root, absolute);
  return path.relative(path.resolve(root), path.resolve(absolute));
}

function fromRelative(root, relative = '') {
  const value = String(relative || '');
  if (path.isAbsolute(value)) throw new Error('Ожидается относительный путь внутри проекта');
  const absolute = path.resolve(root, value);
  assertInside(root, absolute);
  return absolute;
}

async function safeExistingPath(root, relative = '') {
  const lexical = fromRelative(root, relative);
  const [realRoot, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(lexical)]);
  assertInside(realRoot, realTarget);
  return realTarget;
}

async function listRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let code = 67; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try { await fs.access(drive); roots.push({ name: drive, path: drive }); } catch (_) {}
    }
    return roots;
  }
  return [{ name: '/', path: '/' }, { name: 'Домашняя папка', path: os.homedir() }];
}

async function listDirectories(targetPath) {
  const resolved = path.resolve(targetPath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .filter(entry => !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: path.join(resolved, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true, sensitivity: 'base' }));
}

async function listHalls(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .filter(entry => !entry.name.startsWith('.'))
    .filter(entry => !RESERVED_HALL_NAMES.has(entry.name.toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' }));
}

async function ensureHallStructure(root, hall) {
  validateHallName(hall);
  const hallDir = path.join(root, hall);
  assertInside(root, hallDir);
  await Promise.all([
    fs.mkdir(path.join(hallDir, RAW_DIR), { recursive: true }),
    fs.mkdir(path.join(hallDir, PEOPLE_DIR), { recursive: true }),
    fs.mkdir(path.join(hallDir, EQUIPMENT_DIR), { recursive: true }),
  ]);
  return hallDir;
}

async function directImages(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink())
    .map(entry => entry.name)
    .filter(isImageFile)
    .filter(name => !isThumbnail(name))
    .sort(comparePhotoNames);
}

async function listPersonDirectories(root, hall) {
  const peopleDir = path.join(root, hall, PEOPLE_DIR);
  try {
    const entries = await fs.readdir(peopleDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort((a,b)=>a.localeCompare(b,'ru',{numeric:true,sensitivity:'base'}));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function enumerateHallImages(root, hall) {
  validateHallName(hall);
  await ensureHallStructure(root, hall);
  const out = [];
  const locations = [
    { dir: path.join(root, hall, RAW_DIR), status: 'raw', category: null, personName: null },
    { dir: path.join(root, hall, PEOPLE_DIR), status: 'people', category: 'people', personName: null },
    { dir: path.join(root, hall, EQUIPMENT_DIR), status: 'equipment', category: 'equipment', personName: null },
  ];
  for (const loc of locations) {
    const images = await directImages(loc.dir);
    for (const name of images) out.push({ ...loc, name, absolutePath: path.join(loc.dir, name) });
  }
  const people = await listPersonDirectories(root, hall);
  for (const personName of people) {
    const dir = path.join(root, hall, PEOPLE_DIR, personName);
    const images = await directImages(dir);
    for (const name of images) {
      out.push({ dir, status: 'person', category: 'people', personName, name, absolutePath: path.join(dir, name) });
    }
  }
  return out;
}

async function listProjectDirectory(root, relativePath = '') {
  const dir = await safeExistingPath(root, relativePath || '');
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error('Путь не является папкой');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const directories = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .filter(entry => !entry.name.startsWith('.'))
    .map(entry => ({ type:'directory', name:entry.name, relativePath:toRelative(root,path.join(dir,entry.name)) }))
    .sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true,sensitivity:'base'}));
  const images = entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink())
    .map(entry => entry.name)
    .filter(isImageFile)
    .filter(name => !isThumbnail(name))
    .sort(comparePhotoNames)
    .map(name => ({ type:'image', name, relativePath:toRelative(root,path.join(dir,name)) }));
  const rel = toRelative(root, dir);
  return { path:rel, directories, images };
}

async function moveFileStrict(source, target) {
  source = path.resolve(source);
  target = path.resolve(target);
  if (source === target) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await fs.link(source, target);
    await fs.unlink(source);
    return;
  } catch (err) {
    if (!['EXDEV','EPERM','EACCES','ENOTSUP','EMLINK'].includes(err.code)) {
      if (err.code === 'EEXIST') throw new Error(`Файл уже существует: ${target}`);
      throw err;
    }
  }
  try {
    await fs.copyFile(source, target, fssync.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error(`Файл уже существует: ${target}`);
    throw err;
  }
  try {
    await fs.unlink(source);
  } catch (err) {
    try { await fs.unlink(target); } catch (_) {}
    throw err;
  }
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch (_) { return false; }
}

function validateHallName(hall) {
  const value = String(hall || '').trim();
  if (!value || value.includes('/') || value.includes('\\') || value === '.' || value === '..') throw new Error('Некорректное название зала');
  if (RESERVED_HALL_NAMES.has(value.toLowerCase())) throw new Error('Название зала конфликтует со служебной папкой');
  return value;
}

function validatePersonName(person) {
  const value = String(person || '').trim().replace(/\s+/g, ' ');
  if (!value) throw new Error('ФИО не заполнено');
  if (value === '.' || value === '..') throw new Error('Некорректное ФИО');
  if (/[<>:"/\\|?*]/.test(value)) throw new Error('ФИО содержит символы, запрещённые в имени папки Windows');
  if (/[. ]$/.test(value)) throw new Error('ФИО не может заканчиваться точкой или пробелом');
  return value;
}

function networkAddresses(port, token) {
  const nets = os.networkInterfaces();
  const result = [];
  for (const group of Object.values(nets)) {
    for (const net of group || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(`http://${net.address}:${port}/?token=${token}`);
    }
  }
  return result;
}

module.exports = {
  RAW_DIR,
  PEOPLE_DIR,
  EQUIPMENT_DIR,
  normalizeAbsolute,
  isInside,
  assertInside,
  toRelative,
  fromRelative,
  safeExistingPath,
  listRoots,
  listDirectories,
  listHalls,
  ensureHallStructure,
  directImages,
  listPersonDirectories,
  enumerateHallImages,
  listProjectDirectory,
  moveFileStrict,
  fileExists,
  validateHallName,
  validatePersonName,
  networkAddresses,
};
