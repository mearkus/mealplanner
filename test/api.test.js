import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.APP_PASSWORD = 'secret-pw';
delete process.env.ANTHROPIC_API_KEY;
const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
openDb(':memory:');

const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}/api`;
let cookie = '';
const call = async (path, body, method) => {
  const res = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), res };
};

test.after(() => server.close());

test('requires the household password', async () => {
  assert.equal((await call('/recipes')).status, 401);
  assert.equal((await call('/login', { password: 'nope' })).status, 401);
  const ok = await call('/login', { password: 'secret-pw' });
  assert.equal(ok.status, 200);
  cookie = ok.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/recipes')).status, 200);
});

test('import → plan → shopping → cooked → memory', async () => {
  const a = await call('/import/text', { text: 'Tacos\nIngredients\n1 bunch cilantro\n2 limes\n1 lb chicken thighs\nsalt\nMethod\n1. Cook.' });
  const b = await call('/import/text', { text: 'Bowls\nIngredients\n1 bunch cilantro\n1 lime\n1 can black beans\nMethod\n1. Assemble.' });
  const [ta] = a.body.ids; const [bo] = b.body.ids;
  await call(`/recipes/${ta}`, { favorite: true }, 'PATCH');
  const plan = await call('/plan', { recipeIds: [ta, bo] });
  assert.equal(plan.body.items.length, 2);
  assert.equal(plan.body.batches.length, 1);

  let shop = (await call('/shopping')).body;
  const cil = shop.groups.find((g) => g.category === 'Produce').items.find((i) => i.name === 'cilantro');
  assert.equal(cil.amount, '2 bunches');
  shop = (await call('/shopping/check', { key: 'cilantro', checked: true })).body;
  assert.equal(shop.done, 1);
  shop = (await call('/shopping/manual', { label: 'Coffee beans' })).body;
  assert.ok(shop.groups.some((g) => g.manual.some((m) => m.label === 'Coffee beans')));

  const itemId = plan.body.items.find((i) => i.recipeId === ta).id;
  const after = await call(`/plan/${itemId}/cooked`, {});
  assert.equal(after.body.items.length, 1);
  const r = (await call(`/recipes/${ta}`)).body;
  assert.equal(r.timesCooked, 1);
  assert.ok(r.similar.some((s) => s.id === bo));

  const sugg = (await call('/suggestions?goal=any&count=2')).body;
  assert.ok(Array.isArray(sugg.suggested));
  assert.equal(sugg.forgotten.length, 0); // just cooked the favourite
});
