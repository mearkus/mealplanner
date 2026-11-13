import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.ANTHROPIC_API_KEY;
delete process.env.ALLOW_NEW_FAMILIES;
delete process.env.FAMILY_SIGNUP_CODE;
const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
openDb(':memory:');

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}/api`;
test.after(() => server.close());

/** A tiny client that keeps its own session cookie, like a separate phone. */
function client() {
  let cookie = '';
  return async (path, body, method) => {
    const res = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

const mark = client(); const wife = client(); const stranger = client(); const other = client();
let inviteCode;

test('first person creates the family; later sign-ups need an invite', async () => {
  assert.equal((await mark('/recipes')).status, 401);
  const s = await mark('/auth/signup', { name: 'Mark', email: 'mark@example.com', password: 'password123', familyName: 'The Gs' });
  assert.equal(s.status, 200);
  assert.equal(s.body.family.name, 'The Gs');
  assert.equal(s.body.user.role, 'owner');

  const blocked = await stranger('/auth/signup', { name: 'Eve', email: 'eve@example.com', password: 'password123' });
  assert.equal(blocked.status, 403);
  assert.equal((await stranger('/auth/signup', { name: 'Eve', email: 'mark@example.com', password: 'password123', inviteCode: 'x' })).status, 409);
});

test('invite link lets the second person join the same family', async () => {
  const inv = await mark('/family/invites', {});
  inviteCode = inv.body.code;
  assert.match(inviteCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const preview = await wife(`/invites/${inviteCode}`);
  assert.equal(preview.body.familyName, 'The Gs');
  assert.equal(preview.body.invitedBy, 'Mark');
  const s = await wife('/auth/signup', { name: 'Sam', email: 'sam@example.com', password: 'password456', inviteCode });
  assert.equal(s.status, 200);
  assert.equal(s.body.family.members.length, 2);
  assert.equal(s.body.user.role, 'member');
});

test('login, wrong password, and passwords are not stored in plain text', async () => {
  const phone2 = client();
  assert.equal((await phone2('/auth/login', { email: 'sam@example.com', password: 'nope-nope' })).status, 401);
  assert.equal((await phone2('/auth/login', { email: 'SAM@example.com', password: 'password456' })).status, 200);
  const { getUserAuthByEmail } = await import('../server/db.js');
  assert.match(getUserAuthByEmail('sam@example.com').password_hash, /^scrypt\$/);
});

test('family members share recipes, plan, shopping and history — with attribution', async () => {
  const a = await mark('/import/text', { text: 'Tacos\nIngredients\n1 bunch cilantro\n2 limes\n1 lb chicken thighs\nsalt\nMethod\n1. Cook.' });
  const b = await wife('/import/text', { text: 'Bowls\nIngredients\n1 bunch cilantro\n1 lime\n1 can black beans\nMethod\n1. Assemble.' });
  const [ta] = a.body.ids; const [bo] = b.body.ids;
  assert.equal((await wife('/recipes')).body.length, 2);
  await wife(`/recipes/${ta}`, { favorite: true }, 'PATCH');
  assert.equal((await mark(`/recipes/${ta}`)).body.favorite, true);

  await mark('/plan', { recipeId: ta });
  const plan = await wife('/plan', { recipeId: bo });
  assert.equal(plan.body.items.length, 2);
  assert.deepEqual(plan.body.items.map((i) => i.addedBy).sort(), ['Mark', 'Sam']);
  assert.equal(plan.body.batches.length, 1);

  await wife('/shopping/check', { key: 'cilantro', checked: true });
  const shop = (await mark('/shopping')).body;
  const cil = shop.groups.find((g) => g.category === 'Produce').items.find((i) => i.name === 'cilantro');
  assert.equal(cil.amount, '2 bunches');
  assert.equal(cil.checked, true);

  const item = plan.body.items.find((i) => i.recipeId === ta);
  await wife(`/plan/${item.id}/cooked`, {});
  const hist = (await mark('/history')).body;
  assert.equal(hist[0].cookedBy, 'Sam');
  assert.equal((await mark(`/recipes/${ta}`)).body.timesCooked, 1);
});

test('another family cannot see or touch our data', async () => {
  process.env.ALLOW_NEW_FAMILIES = 'true';
  const s = await other('/auth/signup', { name: 'Neighbour', email: 'n@example.com', password: 'password789' });
  delete process.env.ALLOW_NEW_FAMILIES;
  assert.equal(s.status, 200);
  assert.equal((await other('/recipes')).body.length, 0);
  assert.equal((await other('/plan')).body.items.length, 0);
  assert.equal((await other('/history')).body.length, 0);
  const ours = (await mark('/recipes')).body.find((r) => r.title === 'Tacos').id;
  assert.equal((await other(`/recipes/${ours}`)).status, 404);
  assert.equal((await other(`/recipes/${ours}`, { title: 'hacked', ingredients: ['1 egg'] }, 'PUT')).status, 404);
  assert.equal((await other('/plan', { recipeId: ours })).status, 404);
  await other(`/recipes/${ours}`, null, 'DELETE');
  await other(`/recipes/${ours}`, { favorite: false }, 'PATCH');
  const still = (await mark(`/recipes/${ours}`)).body;
  assert.equal(still.title, 'Tacos');
  assert.equal(still.favorite, true);
});

test('Dropbox settings are shared within a family only', async () => {
  await mark('/dropbox/folder', { folder: 'Family Recipes' });
  assert.equal((await wife('/dropbox')).body.folder, '/Family Recipes');
  assert.equal((await other('/dropbox')).body.folder, '/Recipes');
  const start = await wife('/dropbox/auth/start', { appKey: 'abc123' });
  assert.match(start.body.url, /client_id=abc123/);
  assert.equal((await mark('/dropbox')).body.appKeyConfigured, true);
  assert.equal((await other('/dropbox')).body.appKeyConfigured, false);
  const status = JSON.stringify((await mark('/dropbox')).body);
  assert.ok(!/token|abc123|pkce/.test(status), 'no secrets sent to the browser');
});

test('only the owner removes members; removed members are logged out of the family', async () => {
  const me = (await wife('/me')).body;
  const markId = me.family.members.find((m) => m.name === 'Mark').id;
  assert.equal((await wife(`/family/members/${markId}`, null, 'DELETE')).status, 403);
  const samId = me.family.members.find((m) => m.name === 'Sam').id;
  assert.equal((await mark(`/family/members/${samId}`, null, 'DELETE')).status, 200);
  assert.equal((await wife('/recipes')).status, 401); // old session revoked
  const back = client();
  await back('/auth/login', { email: 'sam@example.com', password: 'password456' });
  assert.equal((await back('/recipes')).body.code, 'no_family');
  assert.equal((await back('/family/join', { code: inviteCode })).status, 200);
  assert.equal((await back('/recipes')).body.length, 2);
});

test('changing password logs out other devices', async () => {
  const laptop = client();
  await laptop('/auth/login', { email: 'mark@example.com', password: 'password123' });
  assert.equal((await mark('/me/password', { current: 'wrong-one', password: 'newpassword1' })).status, 400);
  assert.equal((await mark('/me/password', { current: 'password123', password: 'newpassword1' })).status, 200);
  assert.equal((await mark('/recipes')).status, 200);
  assert.equal((await laptop('/recipes')).status, 401);
});
