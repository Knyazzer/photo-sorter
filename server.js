const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const store = require('./lib/photo-store');
const state = require('./lib/state-store');
const service = require('./lib/photo-service');
const { ensureThumbnail } = require('./lib/thumbnail-cache');
const {
  safeExistingPath,
  listHalls,
  networkAddresses,
  validateHallName,
} = require('./lib/files');
const { isImageFile, isThumbnail } = require('./lib/photo-name');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
let ACCESS_TOKEN = null;

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': buf.length, 'X-Content-Type-Options':'nosniff' });
  res.end(buf);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) throw new Error('Слишком большой запрос');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new Error('Некорректный JSON'); }
}

function tokenFrom(req, url, body) {
  return req.headers['x-access-token'] || url.searchParams.get('token') || body?.token || '';
}

function sessionIdFrom(req) {
  const value = String(req.headers['x-session-id'] || '').trim();
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(value) ? value : 'local';
}

function touchClientSession(req) {
  const sessionId = sessionIdFrom(req);
  if (req.headers['x-session-id']) {
    const mode = String(req.headers['x-client-mode'] || '').slice(0, 32) || null;
    const hall = String(req.headers['x-client-hall'] || '').slice(0, 128) || null;
    store.touchSession(sessionId, { mode, hall });
  }
  return sessionId;
}

async function requireRoot() {
  const root = store.getSelectedRoot();
  if (!root) throw new Error('Корень проекта ещё не настроен');
  try {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) throw new Error();
  } catch (_) {
    throw new Error(`Корень проекта недоступен: ${root}`);
  }
  return root;
}

function mimeType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.heic': return 'image/heic';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

async function streamFile(res, filePath, cache = false) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('Файл не найден');
  res.writeHead(200, {
    'Content-Type': mimeType(filePath),
    'Content-Length': stat.size,
    'Cache-Control': cache ? 'private, max-age=300' : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', err => { if (!res.headersSent) sendJson(res, 500, { error:err.message }); else res.destroy(err); });
  stream.pipe(res);
}

async function serveStatic(url, res) {
  let relative;
  try { relative = decodeURIComponent(url.pathname); } catch (_) { return false; }
  if (relative === '/') relative = '/index.html';
  const target = path.resolve(PUBLIC_DIR, `.${relative}`);
  const rel = path.relative(PUBLIC_DIR, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try { await streamFile(res, target, true); return true; }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

function parseIds(body) {
  const raw = Array.isArray(body.photoIds) ? body.photoIds : (body.photoId ? [body.photoId] : []);
  return [...new Set(raw.map(String).filter(Boolean))];
}

async function apiRoute(req, res, url, body) {
  if (tokenFrom(req, url, body) !== ACCESS_TOKEN) return sendJson(res, 401, { error:'Неверный ключ доступа' });
  const method = req.method || 'GET';
  const route = url.pathname;
  const sessionId = touchClientSession(req);

  if (method === 'GET' && route === '/api/system') {
    return sendJson(res, 200, { hostname:os.hostname(), port:PORT, platform:process.platform, node:process.version, networkUrls:networkAddresses(PORT, ACCESS_TOKEN) });
  }

  if (method === 'POST' && route === '/api/session') {
    return sendJson(res, 200, { ok:true, sessionId });
  }

  if (method === 'GET' && route === '/api/sessions') {
    return sendJson(res, 200, { sessionId, sessions:store.listActiveSessions(90) });
  }

  if (method === 'GET' && route === '/api/project') {
    const root = store.getSelectedRoot();
    if (!root) return sendJson(res, 200, { root:null, exists:false, halls:[] });
    let exists = false;
    try { exists = (await fsp.stat(root)).isDirectory(); } catch (_) {}
    return sendJson(res, 200, { root, exists, halls:exists ? await listHalls(root) : [] });
  }

  if (method === 'POST' && route === '/api/setup/root') {
    const requested = path.resolve(String(body.path || '').trim());
    if (!body.path) throw new Error('Не указан путь к проекту');
    const stat = await fsp.stat(requested);
    if (!stat.isDirectory()) throw new Error('Корень проекта должен быть папкой');
    await state.setConfiguredRoot(requested);
    const sync = await service.initializeRoot(requested);
    return sendJson(res, 200, { root:requested, halls:await listHalls(requested), sync });
  }

  if (method === 'POST' && route === '/api/sync') {
    const root = await requireRoot();
    return sendJson(res, 200, { ok:true, ...(await service.syncFilesystem(root)) });
  }

  if (method === 'GET' && route === '/api/browser/list') {
    const root = await requireRoot();
    const relativePath = String(url.searchParams.get('path') || '');
    return sendJson(res, 200, await service.browserList(root, relativePath));
  }

  if (method === 'GET' && route === '/api/photo/metadata') {
    const root = await requireRoot();
    const photoId = String(url.searchParams.get('id') || '');
    if (photoId) return sendJson(res, 200, await service.photoMetadataById(root, photoId));
    const relativePath = String(url.searchParams.get('path') || '');
    return sendJson(res, 200, await service.photoMetadata(root, relativePath));
  }

  if (method === 'GET' && (route === '/api/preview' || route === '/api/image')) {
    const root = await requireRoot();
    const photoId = String(url.searchParams.get('id') || '');
    if (photoId) {
      const photo = service.getPhotoById(photoId);
      if (route === '/api/preview') {
        try {
          const thumb = await ensureThumbnail(root, photo);
          return streamFile(res, thumb, true);
        } catch (err) {
          console.warn(`Thumbnail fallback for ${photoId}:`, err.message);
        }
      }
      const absolute = await safeExistingPath(root, photo.current_relative_path);
      const filename = path.basename(absolute);
      if (!isImageFile(filename) || isThumbnail(filename)) throw new Error('Недопустимый файл изображения');
      return streamFile(res, absolute, route === '/api/preview');
    }
    const relativePath = String(url.searchParams.get('path') || '');
    const absolute = await safeExistingPath(root, relativePath);
    const filename = path.basename(absolute);
    if (!isImageFile(filename) || isThumbnail(filename)) throw new Error('Недопустимый файл изображения');
    return streamFile(res, absolute, route === '/api/preview');
  }

  if (method === 'GET' && route === '/api/mode1/photos') {
    await requireRoot();
    const photos = service.mode1Photos();
    return sendJson(res, 200, { photos, total:photos.length });
  }

  if (method === 'POST' && route === '/api/mode1/classify') {
    const root = await requireRoot();
    const target = String(body.target || '');
    if (!['raw','people','equipment'].includes(target)) throw new Error('Неизвестная категория');
    const photos = await service.movePhotos(root, parseIds(body), target, { userId:sessionId, expectedVersions:body.expectedVersions || null });
    return sendJson(res, 200, { ok:true, photos });
  }

  if (method === 'GET' && route === '/api/mode2/data') {
    await requireRoot();
    const hall = validateHallName(String(url.searchParams.get('hall') || ''));
    return sendJson(res, 200, service.mode2Data(hall));
  }

  if (method === 'POST' && route === '/api/people') {
    const root = await requireRoot();
    const person = await service.addPerson(root, body.hall, body.name);
    return sendJson(res, 201, { person });
  }

  const personMatch = route.match(/^\/api\/people\/(\d+)$/);
  if (personMatch && method === 'PATCH') {
    const root = await requireRoot();
    const person = await service.renamePerson(root, Number(personMatch[1]), body.name);
    return sendJson(res, 200, { person });
  }
  if (personMatch && method === 'DELETE') {
    const root = await requireRoot();
    const result = await service.deletePerson(root, Number(personMatch[1]), Boolean(body.confirm));
    return sendJson(res, 200, result);
  }

  if (method === 'POST' && route === '/api/mode2/assign') {
    const root = await requireRoot();
    const photos = await service.assignPhotos(root, parseIds(body), Number(body.personId), sessionId, body.expectedVersions || null);
    return sendJson(res, 200, { ok:true, photos });
  }

  if (method === 'POST' && route === '/api/photos/reset') {
    const root = await requireRoot();
    const photos = await service.movePhotos(root, parseIds(body), 'raw', { userId:sessionId, expectedVersions:body.expectedVersions || null });
    return sendJson(res, 200, { ok:true, photos });
  }

  if (method === 'POST' && route === '/api/undo') {
    const root = await requireRoot();
    return sendJson(res, 200, await service.undoLast(root, sessionId));
  }

  return sendJson(res, 404, { error:'API route not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const body = ['POST','PUT','PATCH','DELETE'].includes(req.method) ? await readJsonBody(req) : {};
      return await apiRoute(req, res, url, body);
    }
    if (await serveStatic(url, res)) return;
    sendText(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, Number(err.statusCode || 400), { error:err.message || 'Неизвестная ошибка' });
    else res.destroy();
  }
});

async function bootstrapRoot() {
  let root = store.getSelectedRoot();
  if (root) {
    try { if ((await fsp.stat(root)).isDirectory()) return await service.syncFilesystem(root); } catch (_) {}
  }
  root = await state.getConfiguredRoot();
  if (root) {
    try {
      if ((await fsp.stat(root)).isDirectory()) return await service.initializeRoot(root);
    } catch (err) {
      console.warn(`Настроенный корень недоступен: ${root}`);
    }
  }
  return null;
}

(async () => {
  ACCESS_TOKEN = await state.getAccessToken();
  const sync = await bootstrapRoot();
  server.listen(PORT, HOST, () => {
    const localUrl = `http://localhost:${PORT}/?token=${ACCESS_TOKEN}`;
    console.log('\n==============================================');
    console.log('  PHOTO SORTER запущен');
    console.log('==============================================');
    console.log(`На этом компьютере: ${localUrl}`);
    const root = store.getSelectedRoot();
    console.log(root ? `Проект: ${root}` : 'Проект не настроен — откройте приложение для первичной настройки.');
    if (sync) console.log(`Синхронизация: ${sync.photos} фото, ${sync.halls} залов, отсутствуют: ${sync.missing}`);
    const urls = networkAddresses(PORT, ACCESS_TOKEN);
    if (urls.length) { console.log('\nВ локальной сети:'); urls.forEach(item => console.log(`  ${item}`)); }
    console.log('==============================================\n');
  });
})().catch(err => { console.error(err); process.exit(1); });
