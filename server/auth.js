// Per-person accounts. Passwords are hashed with scrypt; sessions are signed cookies that are
// invalidated when the password changes or the person leaves / is removed from a family.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as db from './db.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'mp_session';
const MAX_AGE_DAYS = 180;
const attempts = new Map();

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = db.getSetting('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); db.setSetting('session_secret', s); }
  return s;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function makeToken(user) {
  const payload = `v2.${user.id}.${user.tokenVersion ?? user.token_version ?? 0}.${Date.now() + MAX_AGE_DAYS * 86400000}`;
  return `${payload}.${sign(payload)}`;
}

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Returns the logged-in user (with householdId/role) or null. */
export function currentUser(req) {
  const tok = readCookie(req);
  if (!tok) return null;
  const parts = tok.split('.');
  if (parts.length !== 5 || parts[0] !== 'v2') return null;
  const payload = parts.slice(0, 4).join('.');
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(parts[4]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (Number(parts[3]) < Date.now()) return null;
  const user = db.getUser(Number(parts[1]));
  if (!user || user.tokenVersion !== Number(parts[2])) return null;
  return user;
}

export function setSessionCookie(req, res, user) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${COOKIE}=${makeToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Attaches req.user; 401 if not logged in. */
export function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

/** Attaches req.hid; 409 if the user hasn't created or joined a family yet. */
export function requireFamily(req, res, next) {
  if (!req.user?.householdId) return res.status(409).json({ error: 'Create or join a family first', code: 'no_family' });
  req.hid = req.user.householdId;
  next();
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') return res.status(403).json({ error: 'Only the family owner can do that' });
  next();
}

/** Simple per-IP throttle for login/sign-up: 8 tries, then a 1-minute pause. */
export function throttle(req) {
  const ip = req.ip || 'unknown';
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return false;
  a.n += 1;
  if (a.n > 8) { a.until = Date.now() + 60000; a.n = 0; }
  attempts.set(ip, a);
  return true;
}
export function resetThrottle(req) { attempts.delete(req.ip || 'unknown'); }

/**
 * Who may create a brand-new family (rather than join one by invite)?
 * - Always the very first person on a fresh server.
 * - Anyone, if ALLOW_NEW_FAMILIES=true.
 * - Anyone who enters FAMILY_SIGNUP_CODE, if that is set.
 */
export function canCreateFamily(signupCode) {
  if (db.countUsers() === 0) return true;
  if (process.env.ALLOW_NEW_FAMILIES === 'true') return true;
  if (process.env.FAMILY_SIGNUP_CODE) return signupCode === process.env.FAMILY_SIGNUP_CODE;
  return false;
}

export function newInviteCode() {
  // Easy to read aloud / type: no 0/O/1/I.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{5})(.{5})/, '$1-$2');
}
