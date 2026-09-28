const crypto = require('crypto');
const { ADMIN_USER, ADMIN_PASSWORD, SESSION_SECRET, SESSION_HOURS, COOKIE_SECURE } = require('./config');

const COOKIE = 'osdm_session';

const sign = (data) => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_HOURS * 3600e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieHeader(value, maxAgeSec) {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    COOKIE_SECURE ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

const isAdmin = (req) => !!readToken(getCookie(req, COOKIE));

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Not logged in' });
}

// Simple in-memory brute-force brake: 10 failed attempts per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(ip); return false; }
  return f.count >= 10;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

function login(req, res) {
  const ip = req.ip;
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD is not set on the server.' });

  const { username, password } = req.body || {};
  const ok = safeEqual(username || '', ADMIN_USER) & safeEqual(password || '', ADMIN_PASSWORD);
  if (!ok) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', cookieHeader(makeToken(ADMIN_USER), Math.round(SESSION_HOURS * 3600)));
  res.json({ ok: true });
}

function logout(req, res) {
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true });
}

module.exports = { requireAdmin, isAdmin, login, logout };
