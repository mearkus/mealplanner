// Sign in with Google + signed session cookies, using only Web Crypto (cheap enough for the free plan's CPU limit).

const enc = new TextEncoder();
const COOKIE = 'mp_session';
const MAX_AGE_DAYS = 180;
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
export function bytesToB64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- Google ID tokens ----------
let jwksCache = { keys: null, until: 0 };

async function defaultFetchJwks() {
  if (jwksCache.keys && Date.now() < jwksCache.until) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('Could not reach Google to check the sign-in');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  const { keys } = await res.json();
  jwksCache = { keys, until: Date.now() + maxAge * 1000 };
  return keys;
}

/**
 * Verifies a Google "Sign in with Google" ID token and returns its claims.
 * Checks signature (RS256, Google's published keys), issuer, audience (our client id), expiry and verified email.
 */
export async function verifyGoogleIdToken(token, clientId, { fetchJwks = defaultFetchJwks, now = Date.now() } = {}) {
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured on the server');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed sign-in token');
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');
  const jwk = (await fetchJwks()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('Invalid sign-in signature');
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new Error('Token not issued by Google');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new Error('Token is for a different app');
  const nowSec = Math.floor(now / 1000);
  if (!(claims.exp > nowSec - 60)) throw new Error('Sign-in expired, please try again');
  if (claims.iat && claims.iat > nowSec + 300) throw new Error('Token issued in the future');
  if (!claims.email || claims.email_verified === false || claims.email_verified === 'false') throw new Error('Google account email is not verified');
  return claims;
}

// ---------- sessions ----------
async function hmacKey(secret) {
  if (!secret || secret.length < 16) throw new Error('SESSION_SECRET is missing or too short (set it with: npx wrangler secret put SESSION_SECRET)');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function makeSessionToken(user, secret, now = Date.now()) {
  const payload = `v3.${user.id}.${user.tokenVersion ?? 0}.${now + MAX_AGE_DAYS * 86400000}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(payload));
  return `${payload}.${bytesToB64url(sig)}`;
}

/** Returns { userId, tokenVersion } if the token is genuine and unexpired, else null. Caller checks tokenVersion against the DB. */
export async function readSessionToken(token, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 5 || parts[0] !== 'v3') return null;
  let sig;
  try { sig = b64urlToBytes(parts[4]); } catch { return null; }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig, enc.encode(parts.slice(0, 4).join('.')));
  if (!ok || Number(parts[3]) < now) return null;
  return { userId: Number(parts[1]), tokenVersion: Number(parts[2]) };
}

export function readCookie(request) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

const isLocal = (url) => ['localhost', '127.0.0.1'].includes(new URL(url).hostname);

export function sessionCookie(request, token) {
  const secure = isLocal(request.url) ? '' : '; Secure';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_DAYS * 86400}${secure}`;
}
export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Local testing only: never allowed unless DEV_LOGIN=true AND the request is to localhost. */
export function devLoginAllowed(env, request) {
  return env.DEV_LOGIN === 'true' && isLocal(request.url);
}

export function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const s = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
