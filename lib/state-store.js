const fs = require('fs/promises');
const path = require('path');
const DATA_DIR = path.resolve(process.env.PHOTO_SORTER_DATA || path.join(__dirname, '..', 'data'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

async function writeJsonAtomic(file, data) {
  await ensureDataDir();
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, file);
}

async function getConfiguredRoot() {
  if (process.env.PHOTO_SORTER_ROOT) return path.resolve(process.env.PHOTO_SORTER_ROOT);
  const config = await readJson(CONFIG_FILE, {});
  if (config.rootPath) return path.resolve(config.rootPath);
  const legacy = await readJson(LEGACY_STATE_FILE, {});
  return legacy.selectedRoot ? path.resolve(legacy.selectedRoot) : null;
}

async function setConfiguredRoot(rootPath) {
  const config = await readJson(CONFIG_FILE, {});
  config.rootPath = path.resolve(rootPath);
  await writeJsonAtomic(CONFIG_FILE, config);
  return config.rootPath;
}

module.exports = {
  CONFIG_FILE,
  LEGACY_STATE_FILE,
  getConfiguredRoot,
  setConfiguredRoot,
};
