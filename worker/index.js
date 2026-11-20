// Our Meals API on Cloudflare Workers. The server is a thin, family-scoped data layer: heavy work
// (shopping list maths, suggestions, PDF/Word reading) runs on the phone, keeping each request well
// inside the free plan's CPU limit.
import { Hono } from 'hono';
import * as db from './db.js';
import * as auth from './auth.js';
import * as dropbox from './dropbox.js';
import { HttpError } from './db.js';
import { ensureMigrated } from './migrate.js';
import { isSupported } from '../public/lib/filetypes.js';

export { FamilyRoom } from './room.js';

const app = new Hono();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const num = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Bad id'); return n; };
const body = async (c) => { try { return await c.req.json(); } catch { return {}; } };

app.onError((err, c) => {
  if (!(err instanceof HttpError)) console.error(err);
  return c.json({ error: err.message || 'Something went wrong', ...(err.code ? { code: err.code } : {}) }, err.status || 500);
});

// The Android and iOS apps load the app from these origins and call this API cross-origin, authenticating
// with a bearer token (no cookies), so allowing them can't be used for cross-site request forgery.
export const APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);
const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});
app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin');
  const allowed = origin && APP_ORIGINS.has(origin);
  if (allowed && c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  await next();
  if (allowed && c.res.status !== 101) for (const [k, v] of Object.entries(corsHeaders(origin))) c.res.headers.set(k, v);
});

// Make sure the database tables exist / are up to date before anything touches them.
app.use('/api/*', async (c, next) => { await ensureMigrated(c.env.DB); await next(); });

// ---------- session helpers ----------
// The cookie-signing secret: SESSION_SECRET if set, otherwise generated once and kept in the database.
let cachedSecret = null;
async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  let s = await db.getSetting(env.DB, 'session_secret');
  if (!s) {
    s = auth.bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').bind('session_secret', JSON.stringify(s)).run();
    s = await db.getSetting(env.DB, 'session_secret'); // another request may have won the race
  }
  cachedSecret = s;
  return s;
}

/** Session token: the website's cookie, or the apps' "Authorization: Bearer" header (or ?access_token= for the WebSocket). */
function sessionToken(c) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('Authorization') || '')?.[1];
  if (bearer) return bearer;
  if (c.req.path === '/api/live' && c.req.query('access_token')) return c.req.query('access_token');
  return auth.readCookie(c.req.raw);
}

async function loadUser(c) {
  const tok = sessionToken(c);
  if (!tok) return null;
  const s = await auth.readSessionToken(tok, await sessionSecret(c.env));
  if (!s) return null;
  const user = await db.getUser(c.env.DB, s.userId);
  return user && user.tokenVersion === s.tokenVersion ? user : null;
}
async function startSession(c, userId) {
  const user = await db.getUser(c.env.DB, userId);
  c.header('Set-Cookie', auth.sessionCookie(c.req.raw, await auth.makeSessionToken(user, await sessionSecret(c.env))));
  return user;
}
async function mePayload(env, user) {
  return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, family: user.householdId ? await db.getHousehold(env.DB, user.householdId) : null };
}

function notifyFamily(c, hid, byUserId) {
  if (!c.env.FAMILY_ROOM) return;
  const stub = c.env.FAMILY_ROOM.get(c.env.FAMILY_ROOM.idFromName(`family:${hid}`));
  c.executionCtx.waitUntil(stub.fetch(`https://room/broadcast?by=${byUserId}`, { method: 'POST' }).catch(() => {}));
}

// ---------- public ----------
app.get('/api/session', async (c) => {
  const user = await loadUser(c);
  return c.json({
    authed: !!user,
    hasFamily: !!user?.householdId,
    firstRun: (await db.countUsers(c.env.DB)) === 0,
    openSignup: c.env.ALLOW_NEW_FAMILIES === 'true',
    googleClientId: c.env.GOOGLE_CLIENT_ID || null,
    devLogin: auth.devLoginAllowed(c.env, c.req.raw),
  });
});

app.get('/api/invites/:code', async (c) => {
  const inv = await db.getInvite(c.env.DB, c.req.param('code'));
  if (!inv) throw new HttpError(404, 'This invite has expired or does not exist');
  return c.json({ familyName: inv.familyName, invitedBy: inv.invitedBy, expiresAt: inv.expiresAt });
});

/** Log in, or create the account (joining by invite / starting a family). Returns the user. */
async function resolveUser(c, { sub, email, name }, { inviteCode, familyName }) {
  const DB = c.env.DB;
  let user = await db.getUserBySub(DB, sub);
  const invite = inviteCode ? await db.getInvite(DB, inviteCode) : null;
  if (inviteCode && !invite) throw new HttpError(400, 'That invite has expired or does not exist');
  if (!user) {
    if (await db.getUserByEmail(DB, email)) throw new HttpError(409, 'That email is already linked to a different account');
    const firstRun = (await db.countUsers(DB)) === 0;
    if (!invite && !firstRun && c.env.ALLOW_NEW_FAMILIES !== 'true') {
      throw new HttpError(403, 'You need an invite link from someone in your family to join', { code: 'invite_required' });
    }
    const uid = await db.createUser(DB, { sub, email, name: String(name || email.split('@')[0]).slice(0, 60) });
    if (invite) await db.joinHousehold(DB, uid, invite.householdId);
    else await db.createHousehold(DB, String(familyName || `${name || 'Our'}'s family`).slice(0, 80), uid);
    user = await db.getUser(DB, uid);
  } else if (invite && !user.householdId) {
    await db.joinHousehold(DB, user.id, invite.householdId);
  }
  return user;
}

/** Website sign-in: sets the session cookie. */
async function signIn(c, profile, opts) {
  const user = await resolveUser(c, profile, opts);
  return mePayload(c.env, await startSession(c, user.id));
}

/** App sign-in: returns a bearer token instead of a cookie. */
async function appSession(c, userId) {
  const user = await db.getUser(c.env.DB, userId);
  return { token: await auth.makeSessionToken(user, await sessionSecret(c.env)), ...(await mePayload(c.env, user)) };
}

app.post('/api/auth/google', async (c) => {
  const b = await body(c);
  const claims = await auth.verifyGoogleIdToken(b.credential, c.env.GOOGLE_CLIENT_ID).catch((e) => { throw new HttpError(401, e.message); });
  return c.json(await signIn(c, { sub: `google:${claims.sub}`, email: claims.email, name: claims.given_name || claims.name }, b));
});

app.post('/api/auth/dev', async (c) => {
  if (!auth.devLoginAllowed(c.env, c.req.raw)) throw new HttpError(404, 'Not found');
  const b = await body(c);
  if (!EMAIL_RE.test(b.email || '')) throw new HttpError(400, 'Enter an email');
  const profile = { sub: `dev:${b.email.toLowerCase()}`, email: b.email, name: b.name };
  if (b.app) return c.json(await appSession(c, (await resolveUser(c, profile, b)).id));
  return c.json(await signIn(c, profile, b));
});

// ---------- sign-in from the Android / iOS apps ----------
// Google doesn't allow its sign-in inside an app's web view, so the app opens this in the phone's browser.
// PKCE-style: the app sends SHA-256(verifier) now and proves it knows the verifier when collecting the token,
// so another app that intercepts the ourmeals:// link can't use the code.
const APP_RETURN = 'ourmeals://auth';
const callbackUrl = (c) => `${new URL(c.req.url).origin}/api/auth/google/callback`;
const htmlPage = (title, msg) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <body style="font:16px system-ui;margin:3rem 1.5rem;color:#1f2a24"><h2>${title}</h2><p>${msg}</p></body>`, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const randomId = () => auth.bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));

app.get('/api/auth/google/start', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return htmlPage('Sign-in not set up', 'The server needs GOOGLE_CLIENT_ID and the GOOGLE_CLIENT_SECRET secret for app sign-in.');
  }
  const challenge = c.req.query('challenge') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return htmlPage('Something went wrong', 'Please go back to the app and try again.');
  const id = randomId();
  await c.env.DB.prepare("DELETE FROM auth_requests WHERE created_at < datetime('now', '-1 hour')").run();
  await c.env.DB.prepare('INSERT INTO auth_requests (id, challenge, invite_code, family_name) VALUES (?, ?, ?, ?)')
    .bind(id, challenge, (c.req.query('invite') || '').slice(0, 20) || null, (c.req.query('family') || '').slice(0, 80) || null).run();
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: callbackUrl(c), response_type: 'code',
    scope: 'openid email profile', state: id, prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
});

app.get('/api/auth/google/callback', async (c) => {
  const back = (q) => c.redirect(`${APP_RETURN}?${new URLSearchParams(q)}`, 302);
  const reqRow = await c.env.DB.prepare("SELECT * FROM auth_requests WHERE id = ? AND app_code IS NULL AND created_at > datetime('now', '-15 minutes')")
    .bind(c.req.query('state') || '').first();
  if (!reqRow) return htmlPage('Sign-in expired', 'Please go back to the app and tap "Continue with Google" again.');
  if (c.req.query('error') || !c.req.query('code')) return back({ error: 'cancelled' });
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: c.req.query('code'), client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl(c), grant_type: 'authorization_code',
      }),
    });
    const tok = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tok.id_token) throw new HttpError(502, 'Google sign-in failed');
    const claims = await auth.verifyGoogleIdToken(tok.id_token, c.env.GOOGLE_CLIENT_ID);
    const user = await resolveUser(c, { sub: `google:${claims.sub}`, email: claims.email, name: claims.given_name || claims.name },
      { inviteCode: reqRow.invite_code, familyName: reqRow.family_name });
    const appCode = randomId();
    await c.env.DB.prepare('UPDATE auth_requests SET app_code = ?, user_id = ? WHERE id = ?').bind(appCode, user.id, reqRow.id).run();
    return back({ code: appCode });
  } catch (err) {
    await c.env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(reqRow.id).run();
    return back({ error: err.code || 'failed', message: err.message || 'Sign-in failed' });
  }
});

/** The app trades the one-time code (plus the secret behind its challenge) for a session token. One try only. */
app.post('/api/auth/app/exchange', async (c) => {
  const b = await body(c);
  const row = await c.env.DB.prepare("SELECT * FROM auth_requests WHERE app_code = ? AND created_at > datetime('now', '-15 minutes')")
    .bind(String(b.code || '')).first();
  if (!row) throw new HttpError(400, 'Sign-in expired, please try again');
  await c.env.DB.prepare('DELETE FROM auth_requests WHERE id = ?').bind(row.id).run();
  const digest = auth.bytesToB64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(b.verifier || ''))));
  if (digest !== row.challenge) throw new HttpError(400, 'Sign-in could not be verified, please try again');
  return c.json(await appSession(c, row.user_id));
});

app.post('/api/auth/logout', (c) => { c.header('Set-Cookie', auth.clearCookie()); return c.json({ ok: true }); });

// ---------- logged in ----------
app.use('/api/*', async (c, next) => {
  const user = await loadUser(c);
  if (!user) throw new HttpError(401, 'Not logged in');
  c.set('user', user);
  await next();
});

app.get('/api/me', async (c) => c.json(await mePayload(c.env, c.get('user'))));
app.patch('/api/me', async (c) => {
  const name = String((await body(c)).name || '').trim().slice(0, 60);
  if (name) await db.updateUserName(c.env.DB, c.get('user').id, name);
  return c.json(await mePayload(c.env, await db.getUser(c.env.DB, c.get('user').id)));
});
app.post('/api/me/logout-everywhere', async (c) => {
  await db.bumpTokenVersion(c.env.DB, c.get('user').id);
  c.header('Set-Cookie', auth.clearCookie());
  return c.json({ ok: true });
});

app.post('/api/family', async (c) => {
  const user = c.get('user');
  if (user.householdId) throw new HttpError(400, 'You are already in a family');
  await db.createHousehold(c.env.DB, String((await body(c)).name || `${user.name}'s family`).slice(0, 80), user.id);
  return c.json(await mePayload(c.env, await startSession(c, user.id)));
});
app.post('/api/family/join', async (c) => {
  const user = c.get('user');
  const inv = await db.getInvite(c.env.DB, (await body(c)).code || '');
  if (!inv) throw new HttpError(400, 'That invite has expired or does not exist');
  if (user.householdId !== inv.householdId) {
    if (user.householdId) await db.leaveHousehold(c.env.DB, user.id);
    await db.joinHousehold(c.env.DB, user.id, inv.householdId);
  }
  return c.json(await mePayload(c.env, await startSession(c, user.id)));
});

// ---------- family members only ----------
app.use('/api/*', async (c, next) => {
  const user = c.get('user');
  if (!user.householdId) throw new HttpError(409, 'Create or join a family first', { code: 'no_family' });
  c.set('hid', user.householdId);
  await next();
  if (c.req.method !== 'GET' && c.res.status < 400 && !c.get('quiet')) notifyFamily(c, user.householdId, user.id);
});

app.get('/api/state', async (c) => {
  const { DB } = c.env; const hid = c.get('hid');
  const [me, recipes, live, dbx] = await Promise.all([mePayload(c.env, c.get('user')), db.listRecipes(DB, hid), db.liveState(DB, hid), dropbox.status(c.env, hid)]);
  return c.json({ ...me, recipes, live, dropbox: dbx });
});
app.get('/api/state/live', async (c) => c.json(await db.liveState(c.env.DB, c.get('hid'))));

app.get('/api/live', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
  const stub = c.env.FAMILY_ROOM.get(c.env.FAMILY_ROOM.idFromName(`family:${c.get('hid')}`));
  return stub.fetch(c.req.raw);
});

// family management
app.patch('/api/family', async (c) => {
  const name = String((await body(c)).name || '').trim().slice(0, 80);
  if (name) await db.renameHousehold(c.env.DB, c.get('hid'), name);
  return c.json(await mePayload(c.env, c.get('user')));
});
app.get('/api/family/invites', async (c) => c.json(await db.listInvites(c.env.DB, c.get('hid'))));
app.post('/api/family/invites', async (c) => {
  c.set('quiet', true);
  return c.json(await db.createInvite(c.env.DB, c.get('hid'), c.get('user').id, auth.newInviteCode()));
});
app.delete('/api/family/invites/:code', async (c) => { await db.deleteInvite(c.env.DB, c.get('hid'), c.req.param('code')); return c.json({ ok: true }); });
app.delete('/api/family/members/:id', async (c) => {
  const user = c.get('user');
  if (user.role !== 'owner') throw new HttpError(403, 'Only the family owner can remove people');
  const member = await db.getUser(c.env.DB, num(c.req.param('id')));
  if (!member || member.householdId !== c.get('hid')) throw new HttpError(404, 'Not in your family');
  if (member.id === user.id) throw new HttpError(400, 'Use "Leave family" to remove yourself');
  await db.leaveHousehold(c.env.DB, member.id);
  return c.json(await mePayload(c.env, user));
});
app.post('/api/family/leave', async (c) => {
  const fam = await db.getHousehold(c.env.DB, c.get('hid'));
  if (fam.members.length === 1) throw new HttpError(400, "You're the only member — invite someone first, or keep the family");
  await db.leaveHousehold(c.env.DB, c.get('user').id);
  return c.json(await mePayload(c.env, await startSession(c, c.get('user').id)));
});

// recipes
app.post('/api/recipes', async (c) => c.json({ id: await db.saveRecipe(c.env.DB, c.get('hid'), await body(c)) }));
app.put('/api/recipes/:id', async (c) => c.json({ id: await db.saveRecipe(c.env.DB, c.get('hid'), await body(c), num(c.req.param('id'))) }));
app.patch('/api/recipes/:id', async (c) => { await db.patchRecipe(c.env.DB, c.get('hid'), num(c.req.param('id')), await body(c)); return c.json({ ok: true }); });
app.delete('/api/recipes/:id', async (c) => { await db.deleteRecipe(c.env.DB, c.get('hid'), num(c.req.param('id'))); return c.json({ ok: true }); });
app.post('/api/recipes/:id/cooked', async (c) => {
  await db.logCooked(c.env.DB, c.get('hid'), num(c.req.param('id')), { date: (await body(c)).date, userId: c.get('user').id });
  return c.json(await db.liveState(c.env.DB, c.get('hid')));
});

// importing: the phone extracts text from files and sends structured recipes
app.post('/api/import', async (c) => {
  const b = await body(c); const hid = c.get('hid');
  const recipes = (Array.isArray(b.recipes) ? b.recipes : []).filter((r) => r?.title && r.ingredients?.length).slice(0, 25);
  if (!recipes.length) throw new HttpError(422, 'No recipe with ingredients found');
  const ids = [];
  for (const [i, r] of recipes.entries()) {
    const sp = b.sourcePath ? (recipes.length > 1 ? `${b.sourcePath}#${i + 1}` : b.sourcePath) : null;
    const existing = sp ? await db.findBySourcePath(c.env.DB, hid, sp) : null;
    ids.push(await db.saveRecipe(c.env.DB, hid, { ...r, source: b.source || 'upload', sourcePath: sp, sourceRev: b.sourceRev }, existing?.id ?? null));
  }
  return c.json({ ids });
});
app.post('/api/import/failed', async (c) => {
  const b = await body(c);
  if (!b.sourcePath) throw new HttpError(400, 'sourcePath required');
  c.set('quiet', true);
  await db.logImport(c.env.DB, c.get('hid'), b.sourcePath, ['empty', 'error', 'needs_ocr'].includes(b.status) ? b.status : 'error', b.detail);
  return c.json({ ok: true });
});
app.post('/api/fetch-page', async (c) => {
  c.set('quiet', true);
  const url = String((await body(c)).url || '');
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'Enter a full https:// link');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OurMeals/1.0)' }, signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, `Could not fetch that page${res ? ` (${res.status})` : ''}`);
  const html = (await res.text()).slice(0, 3_000_000);
  return c.json({ html, url: res.url });
});

// dropbox (shared by the family)
app.get('/api/dropbox', async (c) => c.json(await dropbox.status(c.env, c.get('hid'))));
app.post('/api/dropbox/auth/start', async (c) => {
  await dropbox.assertCanManage(c.env, c.get('hid'), c.get('user'));
  c.set('quiet', true);
  return c.json({ url: await dropbox.startAuth(c.env, c.get('hid'), (await body(c)).appKey) });
});
app.post('/api/dropbox/auth/finish', async (c) => {
  await dropbox.assertCanManage(c.env, c.get('hid'), c.get('user'));
  return c.json(await dropbox.finishAuth(c.env, c.get('hid'), c.get('user').id, (await body(c)).code || ''));
});
app.post('/api/dropbox/folder', async (c) => {
  await dropbox.setFolder(c.env, c.get('hid'), c.get('user'), (await body(c)).folder);
  return c.json(await dropbox.status(c.env, c.get('hid')));
});
/** Folder picker: only the person whose Dropbox is connected can browse it (it reveals their folder names). */
app.get('/api/dropbox/folders', async (c) => {
  const st = await dropbox.status(c.env, c.get('hid'));
  if (!st.connected) throw new HttpError(400, 'Dropbox is not connected for this family');
  if (st.connectedBy?.id !== c.get('user').id) throw new HttpError(403, 'Only the person who connected Dropbox can browse its folders');
  return c.json(await dropbox.browse(c.env, c.get('hid'), c.req.query('path') || '', isSupported));
});
app.post('/api/dropbox/disconnect', async (c) => {
  await dropbox.assertCanManage(c.env, c.get('hid'), c.get('user'));
  await dropbox.disconnect(c.env, c.get('hid'));
  return c.json(await dropbox.status(c.env, c.get('hid')));
});
/** Files in the recipe folder not yet imported (or failed before), for the phone to work through. */
app.get('/api/dropbox/pending', async (c) => {
  const hid = c.get('hid');
  const [{ files }, { done, log }] = await Promise.all([dropbox.listFolder(c.env, hid), db.importedPaths(c.env.DB, hid)]);
  const out = files.map((f) => ({ path: f.path_display, lower: f.path_lower, name: f.name, rev: f.rev, size: f.size }))
    .filter((f) => !done.has(`dropbox:${f.lower}`));
  return c.json({
    total: files.length,
    pending: out.filter((f) => !log.has(`dropbox:${f.lower}`)),
    failed: out.filter((f) => log.has(`dropbox:${f.lower}`)).map((f) => ({ ...f, status: log.get(`dropbox:${f.lower}`) })),
  });
});
app.post('/api/dropbox/download', async (c) => {
  c.set('quiet', true);
  const res = await dropbox.download(c.env, c.get('hid'), String((await body(c)).path || ''));
  return new Response(res.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
});
app.post('/api/dropbox/link', async (c) => {
  c.set('quiet', true);
  return c.json({ url: await dropbox.temporaryLink(c.env, c.get('hid'), String((await body(c)).path || '')) });
});
app.post('/api/dropbox/finished', async (c) => {
  const b = await body(c);
  await db.setFamilySetting(c.env.DB, c.get('hid'), 'dropbox_last_import', { at: new Date().toISOString(), by: c.get('user').name, imported: Number(b.imported) || 0, failed: Number(b.failed) || 0 });
  return c.json({ ok: true });
});
app.post('/api/dropbox/retry-failed', async (c) => { c.set('quiet', true); await db.clearImportLog(c.env.DB, c.get('hid')); return c.json({ ok: true }); });

// plan (live mutations answer with the new live state so the phone can update without another round trip)
const live = async (c) => c.json(await db.liveState(c.env.DB, c.get('hid')));
app.post('/api/plan', async (c) => {
  const b = await body(c);
  await db.addToPlan(c.env.DB, c.get('hid'), b.recipeIds || [b.recipeId], { ...b, userId: c.get('user').id });
  return live(c);
});
app.patch('/api/plan/:id', async (c) => { await db.updatePlanItem(c.env.DB, c.get('hid'), num(c.req.param('id')), await body(c)); return live(c); });
app.delete('/api/plan/:id', async (c) => { await db.removePlanItem(c.env.DB, c.get('hid'), num(c.req.param('id'))); return live(c); });
app.delete('/api/plan', async (c) => { await db.clearPlan(c.env.DB, c.get('hid')); return live(c); });
app.post('/api/plan/:id/cooked', async (c) => {
  await db.cookPlanItem(c.env.DB, c.get('hid'), num(c.req.param('id')), { date: (await body(c)).date, userId: c.get('user').id });
  return live(c);
});
app.delete('/api/history/:id', async (c) => { await db.deleteCookEntry(c.env.DB, c.get('hid'), num(c.req.param('id'))); return live(c); });

// shopping
app.post('/api/shopping/check', async (c) => { const b = await body(c); await db.setCheck(c.env.DB, c.get('hid'), String(b.key || ''), !!b.checked); return live(c); });
app.post('/api/shopping/manual', async (c) => {
  const label = String((await body(c)).label || '').trim();
  if (!label) throw new HttpError(400, 'Empty item');
  await db.addManual(c.env.DB, c.get('hid'), label, c.get('user').id);
  return live(c);
});
app.patch('/api/shopping/manual/:id', async (c) => { await db.updateManual(c.env.DB, c.get('hid'), num(c.req.param('id')), !!(await body(c)).checked); return live(c); });
app.delete('/api/shopping/manual/:id', async (c) => { await db.deleteManual(c.env.DB, c.get('hid'), num(c.req.param('id'))); return live(c); });
app.post('/api/shopping/clear-checked', async (c) => { await db.clearCheckedManual(c.env.DB, c.get('hid')); return live(c); });

// backup
app.get('/api/export', async (c) => {
  const hid = c.get('hid');
  const [recipes, liveState] = await Promise.all([db.listRecipes(c.env.DB, hid), db.liveState(c.env.DB, hid)]);
  c.header('Content-Disposition', `attachment; filename="recipes-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json({ exportedAt: new Date().toISOString(), recipes, history: liveState.cookLog });
});

app.all('/api/*', () => { throw new HttpError(404, 'Not found'); });

export default { fetch: app.fetch };
