import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredientLine } from '../server/ingredients.js';
import { buildShoppingList, batchGroups, complementarySuggestions, forgottenFavorites, suggestMeals } from '../server/planner.js';
import { scoreHealth } from '../server/health.js';

const mk = (id, title, lines, extra = {}) => ({ id, title, servings: 4, health: 3, favorite: false, lastCooked: null, ...extra, ingredients: lines.map(parseIngredientLine) });

const tacos = mk(1, 'Tacos', ['1 lb chicken thighs', '1 bunch cilantro', '2 limes', '1 avocado', '12 corn tortillas', 'salt'], { favorite: true, lastCooked: '2026-09-01' });
const bowls = mk(2, 'Bowls', ['1 can black beans', '1 bunch cilantro', '1 lime', '1 avocado', '1 cup brown rice'], { health: 5 });
const pasta = mk(3, 'Pasta', ['1 lb penne', '1 cup heavy cream', '2 tbsp butter'], { health: 1 });
const salad = mk(4, 'Salad', ['2 cups spinach', '1 avocado', '1 lime'], { health: 5, favorite: true });
const today = new Date('2026-11-13T12:00:00Z');

test('shopping list merges ingredients across meals and scales servings', () => {
  const byId = new Map([tacos, bowls].map((r) => [r.id, r]));
  const list = buildShoppingList([{ recipeId: 1, servings: 8 }, { recipeId: 2 }], byId, new Set(['avocado']));
  const produce = list.groups.find((g) => g.category === 'Produce').items;
  const cilantro = produce.find((i) => i.name === 'cilantro');
  assert.equal(cilantro.amount, '3 bunches'); // 2 (doubled tacos) + 1
  assert.equal(cilantro.shared, true);
  assert.equal(produce.find((i) => i.name === 'limes').amount, '5');
  assert.equal(produce.find((i) => i.name === 'avocado').checked, true);
  assert.ok(list.pantry.some((i) => i.name === 'salt'));
});

test('batch groups link recipes sharing perishables', () => {
  const groups = batchGroups([tacos, bowls, pasta]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].recipes.map((r) => r.id).sort(), [1, 2]);
  assert.ok(groups[0].shared.some((s) => s.name === 'cilantro'));
  assert.ok(groups[0].tips[0].includes('cilantro'));
});

test('complementary suggestions reuse planned ingredients', () => {
  const out = complementarySuggestions([tacos], [tacos, bowls, pasta, salad]);
  assert.deepEqual(out.map((o) => o.id), [2, 4]); // bowls share 3 perishables, salad 2
  assert.ok(!out.some((o) => o.id === 3));
});

test('forgotten favourites sorted by longest gap', () => {
  const out = forgottenFavorites([tacos, salad, bowls], { today });
  assert.deepEqual(out.map((r) => r.id), [4, 1]);
  assert.equal(out[1].days, 73);
});

test('suggestions respect the health goal', () => {
  const all = [tacos, bowls, pasta, salad];
  const light = suggestMeals(all, { count: 2, goal: 'light', today, seed: 1 });
  assert.ok(light.every((r) => r.health >= 4));
  const comfort = suggestMeals(all, { count: 1, goal: 'comfort', today, seed: 1 });
  assert.ok(comfort[0].health <= 3);
  const five = suggestMeals(all, { count: 10, goal: 'any', today, seed: 2 });
  assert.equal(new Set(five.map((r) => r.id)).size, 4);
});

test('health scoring separates salads from cream pasta', () => {
  const lean = scoreHealth('Kale & Lentil Salad', ['kale', 'lentils', 'cucumber', 'tomatoes', 'olive oil'].map((name) => ({ name })));
  const rich = scoreHealth('Fettuccine Alfredo', ['fettuccine pasta', 'heavy cream', 'butter', 'parmesan cheese'].map((name) => ({ name })));
  assert.ok(lean.score >= 4, `lean ${lean.score}`);
  assert.ok(rich.score <= 2, `rich ${rich.score}`);
});

test('batch groups stay tight instead of chaining the whole week', () => {
  const a = mk(11, 'A', ['1 bunch cilantro', '2 limes']);
  const b = mk(12, 'B', ['1 bunch cilantro', '2 limes', '1 bunch kale', '1 leek']);
  const c = mk(13, 'C', ['1 bunch kale', '1 leek', '2 carrots', '1 fennel']);
  const d = mk(14, 'D', ['2 carrots', '1 fennel']);
  const groups = batchGroups([a, b, c, d]);
  assert.ok(groups.every((g) => g.recipes.length <= 3));
  assert.ok(!groups.some((g) => g.recipes.length === 4));
  for (const g of groups) assert.ok(g.shared.length >= 2);
});
