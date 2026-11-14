import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleIdToken, makeSessionToken, readSessionToken, bytesToB64url } from '../worker/auth.js';

const enc = new TextEncoder();
const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const fetchJwks = async () => [jwk];
const CLIENT = '123.apps.googleusercontent.com';

async function token(claims, { kid = 'k1', key = privateKey } = {}) {
  const h = bytesToB64url(enc.encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const p = bytesToB64url(enc.encode(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: '42', email: 'a@example.com', email_verified: true, iat: now, exp: now + 3600, ...claims })));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${bytesToB64url(sig)}`;
}

test('accepts a genuine Google ID token', async () => {
  const c = await verifyGoogleIdToken(await token({}), CLIENT, { fetchJwks });
  assert.equal(c.sub, '42');
});

test('rejects tampered, wrong-audience, expired, wrong-issuer and unverified tokens', async () => {
  const good = await token({});
  const [h, , s] = good.split('.');
  const forged = `${h}.${bytesToB64url(enc.encode(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'evil', email: 'x@y.z', exp: 9e9 })))}.${s}`;
  await assert.rejects(verifyGoogleIdToken(forged, CLIENT, { fetchJwks }), /signature/);
  await assert.rejects(verifyGoogleIdToken(await token({ aud: 'other' }), CLIENT, { fetchJwks }), /different app/);
  await assert.rejects(verifyGoogleIdToken(await token({ exp: 1000 }), CLIENT, { fetchJwks }), /expired/);
  await assert.rejects(verifyGoogleIdToken(await token({ iss: 'https://evil.example' }), CLIENT, { fetchJwks }), /Google/);
  await assert.rejects(verifyGoogleIdToken(await token({ email_verified: false }), CLIENT, { fetchJwks }), /verified/);
  await assert.rejects(verifyGoogleIdToken(await token({}, { kid: 'nope' }), CLIENT, { fetchJwks }), /Unknown signing key/);
});

test('session tokens: valid, tampered, expired', async () => {
  const secret = 'x'.repeat(32);
  const t = await makeSessionToken({ id: 7, tokenVersion: 2 }, secret);
  assert.deepEqual(await readSessionToken(t, secret), { userId: 7, tokenVersion: 2 });
  assert.equal(await readSessionToken(t.replace('v3.7.', 'v3.8.'), secret), null);
  assert.equal(await readSessionToken(t, 'y'.repeat(32)), null);
  assert.equal(await readSessionToken(t, secret, Date.now() + 200 * 86400000), null);
});

test('Dropbox paths are limited to the family folder', async () => {
  const { insideFolder } = await import('../worker/dropbox.js').catch(() => ({}));
  if (!insideFolder) return; // dropbox.js imports cloudflare-only modules in some setups
  assert.equal(insideFolder('/Recipes', '/recipes/soup.pdf'), true);
  assert.equal(insideFolder('/Recipes', '/recipes-private/x.pdf'), false);
  assert.equal(insideFolder('/Recipes', '/Taxes/2025.pdf'), false);
  assert.equal(insideFolder('/Recipes', '/recipes/../taxes/x.pdf'), false);
  assert.equal(insideFolder('', '/anything.pdf'), true);
});
