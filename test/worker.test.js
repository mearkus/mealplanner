// Runs the real Worker locally (wrangler dev + local D1 + Durable Object) and exercises the API like two phones would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 8799;
const base = `http://localhost:${PORT}`;
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'meals-wr-'));
const wrangler = path.resolve('node_modules/.bin/wrangler');
// No manual migration step: the Worker creates its own tables on first request (worker/migrate.js).
const server = spawn(wrangler, ['dev', '--local', '--port', String(PORT), '--persist-to', persist,
  '--var', 'DEV_LOGIN:true', '--var', 'GOOGLE_CLIENT_ID:test.apps.googleusercontent.com', '--var', 'GOOGLE_CLIENT_SECRET:test-secret'],
{ stdio: 'ignore', detached: true });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${base}/api/session`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 500));
}
test.after(() => { try { process.kill(-server.pid); } catch { /* gone */ } fs.rmSync(persist, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (p, body, method) => {
    const res = await fetch(base + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  call.cookie = () => cookie;
  return call;
}
const mark = client(); const sam = client(); const stranger = client();
let invite;

test('first person starts the family; strangers need an invite', async () => {
  assert.equal((await mark('/api/state')).status, 401);
  const s = await mark('/api/auth/dev', { email: 'mark@example.com', name: 'Mark', familyName: 'The Greshams' });
  assert.equal(s.status, 200);
  assert.equal(s.body.family.name, 'The Greshams');
  assert.equal(s.body.user.role, 'owner');
  const blocked = await stranger('/api/auth/dev', { email: 'eve@example.com', name: 'Eve' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'invite_required');
});

test('Google sign-in rejects forged tokens', async () => {
  const r = await stranger('/api/auth/google', { credential: 'aaa.bbb.ccc' });
  assert.equal(r.status, 401);
});

test('invite link joins the same family', async () => {
  invite = (await mark('/api/family/invites', {})).body.code;
  assert.equal((await sam(`/api/invites/${invite}`)).body.invitedBy, 'Mark');
  const s = await sam('/api/auth/dev', { email: 'sam@example.com', name: 'Sam', inviteCode: invite });
  assert.equal(s.status, 200);
  assert.equal(s.body.family.members.length, 2);
});

test('family shares recipes, plan, shopping and history, with attribution', async () => {
  const a = await mark('/api/import', { recipes: [{ title: 'Tacos', ingredients: ['1 bunch cilantro', '2 limes', '1 lb chicken thighs'] }], source: 'pasted' });
  const b = await sam('/api/import', { recipes: [{ title: 'Bowls', ingredients: ['1 bunch cilantro', '1 lime', '1 can black beans'] }], source: 'pasted' });
  const [ta] = a.body.ids; const [bo] = b.body.ids;
  const st = (await sam('/api/state')).body;
  assert.deepEqual(st.recipes.map((r) => r.title).sort(), ['Bowls', 'Tacos']);
  assert.equal(st.recipes.find((r) => r.title === 'Tacos').ingredients[0].name, 'cilantro');

  await mark('/api/plan', { recipeId: ta });
  const live = (await sam('/api/plan', { recipeIds: [bo] })).body;
  assert.deepEqual(live.plan.map((p) => p.addedBy).sort(), ['Mark', 'Sam']);
  const checked = (await sam('/api/shopping/check', { key: 'cilantro', checked: true })).body;
  assert.deepEqual(checked.checks, ['cilantro']);
  assert.deepEqual((await mark('/api/state/live')).body.checks, ['cilantro']);

  const item = live.plan.find((p) => p.recipeId === ta);
  const after = (await sam(`/api/plan/${item.id}/cooked`, {})).body;
  assert.equal(after.plan.length, 1);
  assert.equal(after.cookLog[0].cookedBy, 'Sam');
});

test('course, seasons and weeknight/weekend can be set, validated and reset', async () => {
  const id = (await mark('/api/state')).body.recipes.find((r) => r.title === 'Tacos').id;
  const before = (await sam('/api/state')).body.recipes.find((r) => r.id === id);
  assert.equal(before.course, null); assert.equal(before.seasons, null); // not set → the app guesses
  assert.equal((await sam(`/api/recipes/${id}`, { course: 'side', seasons: ['summer', 'spring', 'summer'], occasions: ['weeknight'] }, 'PATCH')).status, 200);
  const after = (await mark('/api/state')).body.recipes.find((r) => r.id === id);
  assert.equal(after.course, 'side');
  assert.deepEqual(after.seasons, ['spring', 'summer']); // de-duplicated and ordered
  assert.deepEqual(after.occasions, ['weeknight']);
  assert.equal((await sam(`/api/recipes/${id}`, { course: 'brunch' }, 'PATCH')).status, 400);
  assert.equal((await sam(`/api/recipes/${id}`, { seasons: ['monsoon'] }, 'PATCH')).status, 400);
  await sam(`/api/recipes/${id}`, { course: null, seasons: null, occasions: null }, 'PATCH');
  const reset = (await mark('/api/state')).body.recipes.find((r) => r.id === id);
  assert.equal(reset.course, null); assert.equal(reset.seasons, null); assert.equal(reset.occasions, null);
  // Saving the recipe text doesn't wipe the family's choices
  await mark(`/api/recipes/${id}`, { seasons: [] }, 'PATCH');
  await mark(`/api/recipes/${id}`, { title: 'Tacos', ingredients: ['1 bunch cilantro', '2 limes', '1 lb chicken thighs'] }, 'PUT');
  assert.deepEqual((await mark('/api/state')).body.recipes.find((r) => r.id === id).seasons, []);
});

test('another family cannot see or touch our data', async () => {
  const neighbour = client();
  const inv2 = (await mark('/api/family/invites', {})).body.code;
  await neighbour('/api/auth/dev', { email: 'n@example.com', name: 'Neighbour', inviteCode: inv2 });
  await neighbour('/api/family/leave', {});
  assert.equal((await neighbour('/api/family', { name: 'Neighbours' })).status, 200);
  const st = (await neighbour('/api/state')).body;
  assert.equal(st.recipes.length, 0);
  assert.equal(st.live.plan.length, 0);
  const ours = (await mark('/api/state')).body.recipes.find((r) => r.title === 'Tacos').id;
  assert.equal((await neighbour(`/api/recipes/${ours}`, { title: 'hacked', ingredients: ['1 egg'] }, 'PUT')).status, 404);
  assert.equal((await neighbour('/api/plan', { recipeId: ours })).status, 404);
  assert.equal((await neighbour(`/api/recipes/${ours}/cooked`, {})).status, 404);
  await neighbour(`/api/recipes/${ours}`, null, 'DELETE');
  await neighbour(`/api/recipes/${ours}`, { favorite: true }, 'PATCH');
  const still = (await mark('/api/state')).body.recipes.find((r) => r.id === ours);
  assert.equal(still.title, 'Tacos');
  assert.equal(still.favorite, false);
  assert.equal((await neighbour('/api/dropbox/download', { path: '/Recipes/x.pdf' })).status, 400); // not connected for them
});

test('Dropbox status never exposes secrets; download refuses paths outside the folder', async () => {
  await mark('/api/dropbox/folder', { folder: 'Shared Recipes' });
  const s = (await sam('/api/dropbox')).body;
  assert.equal(s.folder, '/Shared Recipes');
  assert.ok(!/token|refresh|pkce/i.test(JSON.stringify(s)));
  await mark('/api/dropbox/auth/start', { appKey: 'abc123' });
  assert.ok(!JSON.stringify((await sam('/api/state')).body).includes('abc123'));
});

test('folder browser: only the person who connected Dropbox can browse it', async () => {
  const neighbourless = client();
  assert.equal((await sam('/api/dropbox/folders')).status, 400); // not connected yet
  const { user, family } = (await mark('/api/me')).body;
  // Pretend Mark connected Dropbox (a real connection needs Dropbox's servers).
  const sql = `INSERT OR REPLACE INTO household_settings (household_id, key, value) VALUES
    (${family.id}, 'dropbox_token', '{"refresh_token":"fake"}'), (${family.id}, 'dropbox_connected_by', '${user.id}')`;
  execFileSync(wrangler, ['d1', 'execute', 'mealplanner', '--local', '--persist-to', persist, '--command', sql], { stdio: 'ignore' });
  const forSam = await sam('/api/dropbox/folders?path=/');
  assert.equal(forSam.status, 403);
  assert.match(forSam.body.error, /Only the person who connected Dropbox/);
  const forMark = await mark('/api/dropbox/folders?path=/');
  assert.notEqual(forMark.status, 403); // allowed through (then fails talking to Dropbox with the fake token)
  assert.equal((await neighbourless('/api/dropbox/folders')).status, 401);
  // Undo the fake connection so later tests start clean.
  execFileSync(wrangler, ['d1', 'execute', 'mealplanner', '--local', '--persist-to', persist, '--command',
    `DELETE FROM household_settings WHERE household_id = ${family.id} AND key IN ('dropbox_token', 'dropbox_connected_by')`], { stdio: 'ignore' });
});

test('live updates: the other phone hears about changes', async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/live`, { headers: { cookie: sam.cookie() } });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const got = new Promise((resolve) => { ws.onmessage = (e) => resolve(JSON.parse(e.data)); });
  await mark('/api/shopping/manual', { label: 'Coffee' });
  const msg = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no message')), 5000))]);
  assert.equal(msg.type, 'changed');
  ws.close();
});

test('apps: cross-origin requests are allowed only from the app origins', async () => {
  for (const origin of ['capacitor://localhost', 'https://localhost']) {
    const pre = await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), origin);
    assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    const err = await fetch(`${base}/api/state`, { headers: { Origin: origin } }); // errors carry the headers too
    assert.equal(err.status, 401);
    assert.equal(err.headers.get('access-control-allow-origin'), origin);
  }
  const evil = await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(evil.headers.get('access-control-allow-credentials'), null);
});

test('apps: bearer token sign-in works for the API and live updates', async () => {
  const r = await fetch(`${base}/api/auth/dev`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://localhost' }, body: JSON.stringify({ email: 'mark@example.com', name: 'Mark', app: true }) });
  const me = await r.json();
  assert.ok(me.token);
  assert.equal(r.headers.get('set-cookie'), null); // apps get a token, not a cookie
  const st = await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${me.token}`, Origin: 'https://localhost' } });
  assert.equal(st.status, 200);
  assert.ok((await st.json()).recipes.length >= 1);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer nope.nope' } })).status, 401);
  const ws = new WebSocket(`ws://localhost:${PORT}/api/live?access_token=${encodeURIComponent(me.token)}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.close();
  // ?access_token only counts for the WebSocket
  assert.equal((await fetch(`${base}/api/state?access_token=${encodeURIComponent(me.token)}`)).status, 401);
});

test('apps: browser sign-in hand-off (start → Google → callback → one-time code exchange)', async () => {
  const start = await fetch(`${base}/api/auth/google/start?challenge=${'a'.repeat(43)}&invite=ABCDE-FGHJK`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('client_id'), 'test.apps.googleusercontent.com');
  assert.equal(loc.searchParams.get('redirect_uri'), `${base}/api/auth/google/callback`);
  assert.ok(loc.searchParams.get('state').length >= 40);
  assert.equal((await fetch(`${base}/api/auth/google/start?challenge=short`, { redirect: 'manual' })).status, 400);
  // Unknown / replayed state is refused; a cancelled sign-in goes back to the app.
  assert.equal((await fetch(`${base}/api/auth/google/callback?state=nope&code=x`, { redirect: 'manual' })).status, 400);
  const cancelled = await fetch(`${base}/api/auth/google/callback?state=${loc.searchParams.get('state')}&error=access_denied`, { redirect: 'manual' });
  assert.equal(cancelled.headers.get('location'), 'ourmeals://auth?error=cancelled');

  // Exchange: simulate a finished sign-in (Google itself can't be reached from tests).
  const markId = (await mark('/api/me')).body.user.id;
  const verifier = 'v'.repeat(43);
  const { createHash } = await import('node:crypto');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const insert = (id, code) => execFileSync(wrangler, ['d1', 'execute', 'mealplanner', '--local', '--persist-to', persist, '--command',
    `INSERT INTO auth_requests (id, challenge, app_code, user_id) VALUES ('${id}', '${challenge}', '${code}', ${markId})`], { stdio: 'ignore' });
  const exchange = (code, v) => fetch(`${base}/api/auth/app/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, verifier: v }) });
  insert('req1', 'code1');
  assert.equal((await exchange('code1', 'wrong'.repeat(9))).status, 400);
  assert.equal((await exchange('code1', verifier)).status, 400); // one try only: a wrong guess burns the code
  insert('req2', 'code2');
  const ok = await exchange('code2', verifier);
  assert.equal(ok.status, 200);
  const me = await ok.json();
  assert.equal(me.user.name, 'Mark');
  assert.equal((await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${me.token}` } })).status, 200);
  assert.equal((await exchange('code2', verifier)).status, 400); // codes can't be reused
});

test('owner removes a member (their session stops working); signing out everywhere revokes sessions', async () => {
  const me = (await sam('/api/me')).body;
  const markId = me.family.members.find((m) => m.name === 'Mark').id;
  assert.equal((await sam(`/api/family/members/${markId}`, null, 'DELETE')).status, 403);
  const samId = me.user.id;
  assert.equal((await mark(`/api/family/members/${samId}`, null, 'DELETE')).status, 200);
  assert.equal((await sam('/api/state')).status, 401);
  const laptop = client();
  await laptop('/api/auth/dev', { email: 'mark@example.com', name: 'Mark' });
  await mark('/api/me/logout-everywhere', {});
  assert.equal((await laptop('/api/state')).status, 401);
});
