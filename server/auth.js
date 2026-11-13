// Simple shared household password. Set APP_PASSWORD; both of you log in once per device.
import crypto from 'node:crypto';

const COOKIE = 'mp_session';
const MAX_AGE_DAYS = 365;
const attempts = new Map();

function secret() {
  return process.env.SESSION_SECRET || crypto.createHash('sha256').update(`mealplanner:${process.env.APP_PASSWORD || ''}`).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function authEnabled() {
  return !!process.env.APP_PASSWORD;
}

function makeToken() {
  const exp = Date.now() + MAX_AGE_DAYS * 86400000;
  const payload = `v1.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function validToken(tok) {
  if (!tok) return false;
  const parts = tok.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) && Number(parts[1]) > Date.now();
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function isAuthed(req) {
  return !authEnabled() || validToken(readCookie(req));
}

export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Not logged in' });
}

export function login(req, res) {
  const ip = req.ip || 'unknown';
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
  const given = Buffer.from(String(req.body?.password || ''));
  const expected = Buffer.from(process.env.APP_PASSWORD || '');
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) {
    a.n += 1;
    if (a.n >= 5) { a.until = Date.now() + 60000; a.n = 0; }
    attempts.set(ip, a);
    return res.status(401).json({ error: 'Wrong password' });
  }
  attempts.delete(ip);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}
