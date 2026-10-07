const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const store = require('./lib/photo-store');
const state = require('./lib/state-store');
const service = require('./lib/photo-service');
const auth = require('./lib/auth');
const upload = require('./lib/upload-service');
const { ensureThumbnail, warmThumbnails } = require('./lib/thumbnail-cache');
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
const JSON_LIMIT = 2 * 1024 * 1024;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();
const sessionStreams = new Map();
const sessionDisconnectTimers = new Map();
let lastSessionBroadcast = '';

function securityHeaders(extra = {}) {
  return {
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'same-origin',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, securityHeaders({
    'Content-Type':'application/json; charset=utf-8',
    'Content-Length':body.length,
    'Cache-Control':'no-store',
    ...headers,
  }));
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  const buf = Buffer.from(body);
  res.writeHead(status, securityHeaders({ 'Content-Type':contentType, 'Content-Length':buf.length, ...headers }));
  res.end(buf);
}

function httpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

async function readBody(req, maxBytes = JSON_LIMIT) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw httpError('Слишком большой запрос', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buffer = await readBody(req, JSON_LIMIT);
  if (!buffer.length) return {};
  try { return JSON.parse(buffer.toString('utf8')); }
  catch (_) { throw httpError('Некорректный JSON'); }
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function loginAllowed(req) {
  const key = clientIp(req);
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { startedAt:now, count:0 });
    return true;
  }
  return current.count < LOGIN_MAX_ATTEMPTS;
}

function noteLoginFailure(req) {
  const key = clientIp(req);
  const current = loginAttempts.get(key) || { startedAt:Date.now(), count:0 };
  current.count += 1;
  loginAttempts.set(key, current);
}

function clearLoginFailures(req) {
  loginAttempts.delete(clientIp(req));
}

function decodeHeaderValue(value) {
  const raw = String(value || '');
  try { return decodeURIComponent(raw); } catch (_) { return raw; }
}

function normalizeSessionId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(id) ? id : 'local';
}

function sessionIdFrom(req) {
  return normalizeSessionId(req.headers['x-session-id']);
}

function sessionPayload() {
  return store.listActiveSessions(90).map(item => ({ id:item.id, display_name:item.display_name, mode:item.mode, hall:item.hall }));
}

function broadcastSessions(force = false) {
  const sessions = sessionPayload();
  const serialized = JSON.stringify(sessions);
  if (!force && serialized === lastSessionBroadcast) return;
  lastSessionBroadcast = serialized;
  const frame = `event: sessions\ndata: ${serialized}\n\n`;
  for (const [id, res] of sessionStreams) {
    try { res.write(frame); } catch (_) { sessionStreams.delete(id); }
  }
}

function cancelSessionRemoval(id) {
  const timer = sessionDisconnectTimers.get(id);
  if (timer) clearTimeout(timer);
  sessionDisconnectTimers.delete(id);
}

function scheduleSessionRemoval(id) {
  cancelSessionRemoval(id);
  const timer = setTimeout(() => {
    sessionDisconnectTimers.delete(id);
    if (sessionStreams.has(id)) return;
    store.removeSession(id);
    broadcastSessions(true);
  }, 2500);
  timer.unref?.();
  sessionDisconnectTimers.set(id, timer);
}

function touchClientSession(req, displayName) {
  const sessionId = sessionIdFrom(req);
  if (req.headers['x-session-id']) {
    const mode = decodeHeaderValue(req.headers['x-client-mode']).slice(0, 32) || null;
    const hall = decodeHeaderValue(req.headers['x-client-hall']).slice(0, 128) || null;
    store.touchSession(sessionId, { displayName, mode, hall });
    broadcastSessions();
  }
  return sessionId;
}

function requireAuth(req) {
  const session = auth.sessionFromRequest(req);
  if (!session) throw httpError('Требуется вход', 401);
  return session;
}

function uploadPasswordFrom(req, body = null) {
  if (req.headers['x-upload-password']) return decodeHeaderValue(req.headers['x-upload-password']);
  return String(body?.uploadPassword || '');
}

function requireUploadPassword(req, body = null) {
  if (!auth.uploadPasswordValid(uploadPasswordFrom(req, body))) throw httpError('Неверный пароль загрузки', 403);
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
  let cacheControl = 'no-store';
  if (cache === 'immutable') cacheControl = 'private, max-age=31536000, immutable';
  else if (cache) cacheControl = 'private, max-age=3600';
  res.writeHead(200, securityHeaders({
    'Content-Type':mimeType(filePath),
    'Content-Length':stat.size,
    'Cache-Control':cacheControl,
    'Last-Modified':stat.mtime.toUTCString(),
  }));
  const stream = fs.createReadStream(filePath);
  stream.on('error', err => { if (!res.headersSent) sendJson(res, 500, { error:err.message }); else res.destroy(err); });
  stream.pipe(res);
}

async function serveStatic(url, res) {
  let relative;
  try { relative = decodeURIComponent(url.pathname); } catch (_) { return false; }
  if (relative === '/') relative = '/index.html';
  if (relative === '/upload' || relative === '/upload/') relative = '/upload.html';
  const target = path.resolve(PUBLIC_DIR, `.${relative}`);
  const rel = path.relative(PUBLIC_DIR, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  try {
    const cache = relative !== '/index.html';
    await streamFile(res, target, cache);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function parseIds(body) {
  const raw = Array.isArray(body.photoIds) ? body.photoIds : (body.photoId ? [body.photoId] : []);
  return [...new Set(raw.map(String).filter(Boolean))];
}

async function authRoute(req, res, route, body) {
  if (route === '/api/auth/status' && req.method === 'GET') {
    const session = auth.sessionFromRequest(req);
    return sendJson(res, 200, { authenticated:Boolean(session), name:session?.name || null, expiresAt:session?.expiresAt || null });
  }
  if (route === '/api/auth/login' && req.method === 'POST') {
    if (!loginAllowed(req)) return sendJson(res, 429, { error:'Слишком много попыток входа. Повторите через минуту.' });
    const name = auth.normalizeDisplayName(body.name);
    if (!name) return sendJson(res, 400, { error:'Введите имя' });
    if (!/^\d{5}$/.test(String(body.password || ''))) return sendJson(res, 400, { error:'PIN-код должен состоять из 5 цифр' });
    if (!auth.passwordValid(body.password)) {
      noteLoginFailure(req);
      return sendJson(res, 401, { error:'Неверный PIN-код' });
    }
    clearLoginFailures(req);
    return sendJson(res, 200, { ok:true, name }, { 'Set-Cookie':auth.issueSessionCookie(name) });
  }
  if (route === '/api/auth/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok:true }, { 'Set-Cookie':auth.clearSessionCookie() });
  }
  return false;
}

async function adminUploadRoute(req, res, url, body) {
  const method = req.method || 'GET';
  const route = url.pathname;
  if (!route.startsWith('/api/admin/upload/')) return false;

  if (method === 'POST' && route === '/api/admin/upload/verify') {
    requireUploadPassword(req, body);
    const root = await requireRoot();
    return sendJson(res, 200, { ok:true, root:path.basename(root), maxChunkBytes:upload.MAX_CHUNK_BYTES, maxFileBytes:upload.MAX_FILE_BYTES });
  }
  if (method === 'GET' && route === '/api/admin/upload/status') {
    requireUploadPassword(req);
    const root = await requireRoot();
    return sendJson(res, 200, await upload.uploadStatus(root, url.searchParams.get('path'), Number(url.searchParams.get('total'))));
  }
  if (method === 'PUT' && route === '/api/admin/upload/chunk') {
    requireUploadPassword(req);
    const root = await requireRoot();
    const chunk = await readBody(req, upload.MAX_CHUNK_BYTES);
    try {
      const result = await upload.appendChunk(root, url.searchParams.get('path'), Number(url.searchParams.get('total')), Number(url.searchParams.get('offset')), chunk);
      return sendJson(res, 200, result);
    } catch (err) {
      if (err.expectedOffset != null) return sendJson(res, err.statusCode || 409, { error:err.message, expectedOffset:err.expectedOffset });
      throw err;
    }
  }
  if (method === 'POST' && route === '/api/admin/upload/finish') {
    requireUploadPassword(req, body);
    const root = await requireRoot();
    const result = await service.syncFilesystem(root);
    scheduleThumbnailWarm(root, 'upload');
    return sendJson(res, 200, { ok:true, ...result });
  }
  return sendJson(res, 404, { error:'Upload API route not found' });
}

async function apiRoute(req, res, url, body) {
  const method = req.method || 'GET';
  const route = url.pathname;

  const authHandled = await authRoute(req, res, route, body || {});
  if (authHandled !== false) return authHandled;

  const uploadHandled = await adminUploadRoute(req, res, url, body || {});
  if (uploadHandled !== false) return uploadHandled;

  if (method === 'GET' && route === '/api/sessions/stream') {
    const authSession = requireAuth(req);
    const sessionId = normalizeSessionId(url.searchParams.get('sessionId'));
    const mode = String(url.searchParams.get('mode') || 'viewer').slice(0, 32) || 'viewer';
    const hall = String(url.searchParams.get('hall') || '').slice(0, 128) || null;
    cancelSessionRemoval(sessionId);
    const existingSession = store.getSession(sessionId);
    store.touchSession(sessionId, { displayName:authSession.name, mode:existingSession?.mode || mode, hall:existingSession?.hall ?? hall });
    res.writeHead(200, securityHeaders({ 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache, no-transform', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' }));
    res.write(': connected\n\n');
    sessionStreams.set(sessionId, res);
    broadcastSessions(true);
    req.on('close', () => {
      if (sessionStreams.get(sessionId) === res) sessionStreams.delete(sessionId);
      scheduleSessionRemoval(sessionId);
    });
    return;
  }

  const authSession = requireAuth(req);
  const sessionId = touchClientSession(req, authSession.name);

  if (method === 'GET' && route === '/api/system') {
    return sendJson(res, 200, { hostname:os.hostname(), port:PORT, platform:process.platform, node:process.version, networkUrls:networkAddresses(PORT) });
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
    requireUploadPassword(req, body);
    if (process.env.PHOTO_SORTER_ROOT) throw httpError('Корень задан сервером и не может быть изменён через интерфейс', 409);
    const requested = path.resolve(String(body.path || '').trim());
    if (!body.path) throw new Error('Не указан путь к проекту');
    const stat = await fsp.stat(requested);
    if (!stat.isDirectory()) throw new Error('Корень проекта должен быть папкой');
    await state.setConfiguredRoot(requested);
    const sync = await service.initializeRoot(requested);
    return sendJson(res, 200, { root:requested, halls:await listHalls(requested), sync });
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

  if (method === 'GET' && (route === '/api/thumb' || route === '/api/preview' || route === '/api/image')) {
    const root = await requireRoot();
    const photoId = String(url.searchParams.get('id') || '');
    if (photoId) {
      const photo = service.getPhotoById(photoId);
      if (route === '/api/thumb' || route === '/api/preview') {
        try {
          const variant = route === '/api/thumb' ? 'grid' : 'preview';
          const thumb = await ensureThumbnail(root, photo, variant);
          return streamFile(res, thumb, 'immutable');
        } catch (err) {
          if (!thumbnailFallbackWarned) {
            console.warn('Thumbnail cache недоступен, временно отдаю оригиналы:', err.message);
            thumbnailFallbackWarned = true;
          }
        }
      }
      const absolute = await safeExistingPath(root, photo.current_relative_path);
      const filename = path.basename(absolute);
      if (!isImageFile(filename) || isThumbnail(filename)) throw new Error('Недопустимый файл изображения');
      return streamFile(res, absolute, route === '/api/thumb' || route === '/api/preview' ? 'immutable' : false);
    }
    const relativePath = String(url.searchParams.get('path') || '');
    const absolute = await safeExistingPath(root, relativePath);
    const filename = path.basename(absolute);
    if (!isImageFile(filename) || isThumbnail(filename)) throw new Error('Недопустимый файл изображения');
    return streamFile(res, absolute, route === '/api/thumb' || route === '/api/preview');
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
    const result = await service.deletePerson(root, Number(personMatch[1]), Boolean(body.confirm), sessionId);
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

  if (method === 'POST' && route === '/api/admin/upload/verify') {
    requireUploadPassword(req, body);
    return sendJson(res, 200, { ok:true, maxChunkBytes:upload.MAX_CHUNK_BYTES, maxFileBytes:upload.MAX_FILE_BYTES });
  }

  if (method === 'GET' && route === '/api/admin/upload/status') {
    requireUploadPassword(req);
    const root = await requireRoot();
    return sendJson(res, 200, await upload.uploadStatus(root, url.searchParams.get('path'), Number(url.searchParams.get('total'))));
  }

  if (method === 'PUT' && route === '/api/admin/upload/chunk') {
    requireUploadPassword(req);
    const root = await requireRoot();
    const chunk = await readBody(req, upload.MAX_CHUNK_BYTES);
    try {
      const result = await upload.appendChunk(root, url.searchParams.get('path'), Number(url.searchParams.get('total')), Number(url.searchParams.get('offset')), chunk);
      return sendJson(res, 200, result);
    } catch (err) {
      if (err.expectedOffset != null) return sendJson(res, err.statusCode || 409, { error:err.message, expectedOffset:err.expectedOffset });
      throw err;
    }
  }

  if (method === 'POST' && route === '/api/admin/upload/finish') {
    requireUploadPassword(req, body);
    const root = await requireRoot();
    const result = await service.syncFilesystem(root);
    scheduleThumbnailWarm(root, 'upload');
    return sendJson(res, 200, { ok:true, ...result });
  }

  return sendJson(res, 404, { error:'API route not found' });
}

let thumbnailWarmJob = null;
function scheduleThumbnailWarm(root, reason = 'sync') {
  if (!root || thumbnailWarmJob) return;
  const photos = service.thumbnailCandidates();
  if (!photos.length) return;
  thumbnailWarmJob = (async () => {
    console.log(`Thumbnail warmup (${reason}): ${photos.length} фото`);
    let lastLog = 0;
    const result = await warmThumbnails(root, photos, {
      variant:'grid',
      concurrency:2,
      onProgress:({ done, total }) => {
        if (done === total || done - lastLog >= 250) {
          lastLog = done;
          console.log(`Thumbnail warmup: ${done}/${total}`);
        }
      },
    });
    if (result.skipped) console.warn('Thumbnail warmup пропущен: sharp недоступен');
    else console.log(`Thumbnail warmup готов: ${result.generated}/${result.total}, ошибок: ${result.failed}`);
  })().catch(err => console.warn('Thumbnail warmup error:', err.message)).finally(() => { thumbnailWarmJob = null; });
}

let thumbnailFallbackWarned = false;

const sessionHeartbeat = setInterval(() => {
  for (const res of sessionStreams.values()) { try { res.write(': ping\n\n'); } catch (_) {} }
  broadcastSessions();
}, 20000);
sessionHeartbeat.unref?.();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') return sendJson(res, 200, { ok:true });
    if (url.pathname.startsWith('/api/')) {
      const isRawUpload = req.method === 'PUT' && url.pathname === '/api/admin/upload/chunk';
      const body = !isRawUpload && ['POST','PUT','PATCH','DELETE'].includes(req.method) ? await readJsonBody(req) : {};
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
      if (process.env.PHOTO_SORTER_ROOT) await fsp.mkdir(root, { recursive:true });
      if ((await fsp.stat(root)).isDirectory()) return await service.initializeRoot(root);
    } catch (err) {
      console.warn(`Настроенный корень недоступен: ${root}: ${err.message}`);
    }
  }
  return null;
}

(async () => {
  auth.assertConfigured();
  const sync = await bootstrapRoot();
  server.listen(PORT, HOST, () => {
    console.log('\n==============================================');
    console.log('  PHOTO SORTER запущен');
    console.log('==============================================');
    console.log(`Локально: http://localhost:${PORT}/`);
    const root = store.getSelectedRoot();
    console.log(root ? `Проект: ${root}` : 'Проект не настроен.');
    if (sync) {
      console.log(`Синхронизация: ${sync.photos} фото, ${sync.halls} залов, отсутствуют: ${sync.missing}`);
      if (root) setTimeout(() => scheduleThumbnailWarm(root, 'startup'), 1500);
    }
    const urls = networkAddresses(PORT);
    if (urls.length && process.env.NODE_ENV !== 'production') { console.log('\nВ локальной сети:'); urls.forEach(item => console.log(`  ${item}`)); }
    console.log('==============================================\n');
  });
})().catch(err => { console.error(err); process.exit(1); });
