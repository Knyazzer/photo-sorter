const crypto = require('crypto');

const COOKIE_NAME = 'photo_sorter_auth';
const SESSION_HOURS = Math.max(1, Number(process.env.PHOTO_SORTER_SESSION_HOURS || 168));
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const USERNAME = String(process.env.PHOTO_SORTER_USERNAME || (IS_PRODUCTION ? '' : 'photo')).trim();
const PASSWORD = String(process.env.PHOTO_SORTER_PASSWORD || (IS_PRODUCTION ? '' : 'photo-sorter')).trim();
const UPLOAD_PASSWORD = String(process.env.PHOTO_SORTER_UPLOAD_PASSWORD || (IS_PRODUCTION ? '' : 'upload-photo-sorter')).trim();
const configuredSecret = String(process.env.PHOTO_SORTER_SESSION_SECRET || '');
const SESSION_SECRET = configuredSecret || crypto.randomBytes(32).toString('hex');
const SECURE_COOKIE = process.env.PHOTO_SORTER_COOKIE_SECURE !== '0';

function assertConfigured() {
  if (IS_PRODUCTION) {
    const missing = [];
    if (!USERNAME) missing.push('PHOTO_SORTER_USERNAME');
    if (!PASSWORD) missing.push('PHOTO_SORTER_PASSWORD');
    if (!UPLOAD_PASSWORD) missing.push('PHOTO_SORTER_UPLOAD_PASSWORD');
    if (!configuredSecret || configuredSecret.length < 32) missing.push('PHOTO_SORTER_SESSION_SECRET (минимум 32 символа)');
    if (missing.length) throw new Error(`Не заданы обязательные переменные окружения: ${missing.join(', ')}`);
  }
}

function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function credentialsValid(username, password) {
  return Boolean(USERNAME && PASSWORD && safeEqual(username, USERNAME) && safeEqual(password, PASSWORD));
}

function uploadPasswordValid(password) {
  return Boolean(UPLOAD_PASSWORD && safeEqual(password, UPLOAD_PASSWORD));
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function issueSessionCookie(username = USERNAME) {
  const now = Date.now();
  const payload = b64url(JSON.stringify({ u: username, iat: now, exp: now + SESSION_HOURS * 3600 * 1000 }));
  const token = `${payload}.${sign(payload)}`;
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_HOURS * 3600)}`,
  ];
  if (SECURE_COOKIE) attrs.push('Secure');
  return attrs.join('; ');
}

function clearSessionCookie() {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (SECURE_COOKIE) attrs.push('Secure');
  return attrs.join('; ');
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function sessionFromRequest(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  if (!safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.u || !data?.exp || Date.now() > Number(data.exp)) return null;
    if (USERNAME && !safeEqual(data.u, USERNAME)) return null;
    return { username:data.u, expiresAt:new Date(Number(data.exp)).toISOString() };
  } catch (_) {
    return null;
  }
}

module.exports = {
  COOKIE_NAME,
  USERNAME,
  assertConfigured,
  credentialsValid,
  uploadPasswordValid,
  issueSessionCookie,
  clearSessionCookie,
  sessionFromRequest,
};
