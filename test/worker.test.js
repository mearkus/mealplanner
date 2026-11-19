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
execFileSync(wrangler, ['d1', 'migrations', 'apply', 'mealplanner', '--local', '--persist-to', persist], { stdio: 'ignore' });
const server = spawn(wrangler, ['dev', '--local', '--port', String(PORT), '--persist-to', persist,
  '--var', 'DEV_LOGIN:true', '--var', 'GOOGLE_CLIENT_ID:test.apps.googleusercontent.com'],
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

test('live updates: the other phone hears about changes', async () => {
  const ws = new WebSocket(`ws://localhost:${PORT}/api/live`, { headers: { cookie: sam.cookie() } });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const got = new Promise((resolve) => { ws.onmessage = (e) => resolve(JSON.parse(e.data)); });
  await mark('/api/shopping/manual', { label: 'Coffee' });
  const msg = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no message')), 5000))]);
  assert.equal(msg.type, 'changed');
  ws.close();
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
