// Thin wrapper over Capacitor's native plugins for the Android and iOS apps.
// Everything here is a no-op in a normal browser, so the website behaves exactly as before.
import { APP_SERVER } from './config.js';

const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
export const platform = Cap?.getPlatform?.() || 'web';
const plugin = (name) => (isNative ? Cap.Plugins?.[name] : null);
const quiet = (p) => { if (p?.catch) p.catch(() => {}); };

/** Base URL for API calls: same origin on the website, the Worker in the apps. */
export const SERVER = isNative ? APP_SERVER : '';
export const wsBase = () => (SERVER ? SERVER.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
/** Address to put in links people share (invite links open the website). */
export const shareBase = () => (isNative ? APP_SERVER : location.origin);

// ---------- session token (apps only; the website uses an HttpOnly cookie) ----------
// Kept in native Preferences, because iOS may clear web view storage when the phone is low on space.
const TOKEN_KEY = 'ourmeals.token';
let token = null;
export async function loadToken() {
  if (!isNative) return null;
  try { token = (await plugin('Preferences')?.get({ key: TOKEN_KEY }))?.value || null; } catch { token = null; }
  if (!token) token = localStorage.getItem(TOKEN_KEY);
  return token;
}
export const getToken = () => token;
export async function setToken(value) {
  token = value || null;
  if (!isNative) return;
  if (token) { localStorage.setItem(TOKEN_KEY, token); quiet(plugin('Preferences')?.set({ key: TOKEN_KEY, value: token })); }
  else { localStorage.removeItem(TOKEN_KEY); quiet(plugin('Preferences')?.remove({ key: TOKEN_KEY })); }
}

// ---------- opening things outside the app ----------
export async function openExternal(url) {
  const Browser = plugin('Browser');
  if (Browser) await Browser.open({ url });
  else window.open(url, '_blank', 'noopener');
}
export const closeBrowser = () => quiet(plugin('Browser')?.close());

// ---------- Google sign-in in the phone's browser ----------
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  if (crypto?.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return sha256Fallback(data);
}
const PKCE_KEY = 'ourmeals.pkce';
let pendingSignIn = null;

/**
 * Opens Google sign-in in the browser; the server sends the phone back to ourmeals://auth?code=...
 * Resolves with { code, verifier } (the caller exchanges them for a token) or rejects with the reason.
 */
export async function browserSignIn({ inviteCode, familyName } = {}) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await sha256(verifier));
  localStorage.setItem(PKCE_KEY, verifier); // survives the app being closed while the browser is open
  const params = new URLSearchParams({ challenge });
  if (inviteCode) params.set('invite', inviteCode);
  if (familyName) params.set('family', familyName);
  const result = new Promise((resolve, reject) => { pendingSignIn = { resolve, reject }; });
  await openExternal(`${APP_SERVER}/api/auth/google/start?${params}`);
  return result;
}

/** Turns an ourmeals://auth?... link into a sign-in result; returns null for other links. */
export function parseAuthLink(url) {
  if (!url || !url.startsWith('ourmeals://auth')) return null;
  const q = new URL(url.replace('ourmeals://auth', 'https://x/auth')).searchParams;
  const verifier = localStorage.getItem(PKCE_KEY);
  localStorage.removeItem(PKCE_KEY);
  if (q.get('error')) return { error: q.get('error'), message: q.get('message') || 'Sign-in was cancelled' };
  return { code: q.get('code'), verifier };
}

/**
 * Listens for the browser handing control back. `onColdStart` handles a link that launched the app
 * after it had been closed (no promise waiting for it).
 */
export function listenForAuthLinks(onColdStart) {
  const App = plugin('App');
  if (!App) return;
  const handle = (url) => {
    const r = parseAuthLink(url);
    if (!r) return;
    closeBrowser();
    if (pendingSignIn) {
      const p = pendingSignIn; pendingSignIn = null;
      if (r.error) p.reject(Object.assign(new Error(r.message), { code: r.error })); else p.resolve(r);
    } else onColdStart?.(r);
  };
  quiet(App.addListener('appUrlOpen', (e) => handle(e.url)));
  quiet(App.getLaunchUrl?.().then((r) => r?.url && handle(r.url)));
}

// ---------- app chrome ----------
export function setupChrome() {
  if (!isNative) return;
  document.documentElement.classList.add('native', `platform-${platform}`);
  quiet(plugin('StatusBar')?.setStyle({ style: 'LIGHT' }));
  if (platform === 'android') quiet(plugin('StatusBar')?.setBackgroundColor({ color: '#f6f4ef' }));
  quiet(plugin('SplashScreen')?.hide());
}
export function onBackButton(fn) { quiet(plugin('App')?.addListener('backButton', fn)); }
export function onResume(fn) { quiet(plugin('App')?.addListener('resume', fn)); }
export const exitApp = () => quiet(plugin('App')?.exitApp());

// Minimal SHA-256 for web views without crypto.subtle (only used for the sign-in challenge).
function sha256Fallback(bytes) {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = bytes.length; const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const view = new DataView(padded.buffer); view.setUint32(padded.length - 4, len * 8);
  const W = new Uint32Array(64); const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rot(W[i - 15], 7) ^ rot(W[i - 15], 18) ^ (W[i - 15] >>> 3); const s1 = rot(W[i - 2], 17) ^ rot(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out = new Uint8Array(32); const ov = new DataView(out.buffer);
  H.forEach((v, i) => ov.setUint32(i * 4, v));
  return out;
}
export { sha256Fallback as _sha256Fallback };
