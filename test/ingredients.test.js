import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredientLine, combineAmounts, formatAmount, normalizeName } from '../public/lib/ingredients.js';

test('parses quantities, units and names', () => {
  const cases = [
    ['2 1/2 cups all-purpose flour, sifted', 2.5, 'cup', 'flour'],
    ['1 (14 oz) can diced tomatoes, drained', 1, 'can', 'diced tomatoes'],
    ['3 cloves garlic, minced', 3, 'clove', 'garlic'],
    ['1½ lb boneless skinless chicken thighs', 1.5, 'lb', 'chicken thigh'],
    ['2-3 limes', 3, null, 'limes'],
    ['4 scallions, thinly sliced', 4, null, 'green onion'],
    ['Juice of 1 lemon', 1, null, 'lemons'],
    ['1 cup fresh basil leaves', 1, 'cup', 'basil'],
  ];
  for (const [line, qty, unit, name] of cases) {
    const p = parseIngredientLine(line);
    assert.equal(p.qty, qty, line); assert.equal(p.unit, unit, line); assert.equal(p.name, name, line);
  }
});

test('staples and categories', () => {
  assert.equal(parseIngredientLine('Salt and pepper to taste').staple, true);
  assert.equal(parseIngredientLine('2 tbsp extra-virgin olive oil').staple, true);
  assert.equal(parseIngredientLine('1 bunch cilantro').category, 'Produce');
  assert.equal(parseIngredientLine('1 lb ground beef').category, 'Meat & Seafood');
  assert.equal(parseIngredientLine('1/2 cup sour cream').category, 'Dairy & Eggs');
});

test('synonyms collapse to one shopping name', () => {
  assert.equal(normalizeName('scallions'), normalizeName('green onions'));
  assert.equal(normalizeName('fresh cilantro leaves'), 'cilantro');
  assert.equal(normalizeName('Parmigiano-Reggiano, grated'), 'parmesan cheese');
});

test('combines compatible units', () => {
  const { parts } = combineAmounts([{ qty: 2, unit: 'tbsp' }, { qty: 1, unit: 'cup' }]);
  assert.equal(parts.length, 1);
  assert.equal(formatAmount(parts[0]), '1⅛ cups');
  const mixed = combineAmounts([{ qty: 1, unit: 'can' }, { qty: 8, unit: 'oz' }, { qty: 2, unit: null }]);
  assert.equal(mixed.parts.map(formatAmount).join(' + '), '2 + 1 can + 8 oz');
  const lb = combineAmounts([{ qty: 12, unit: 'oz' }, { qty: 1, unit: 'lb' }]);
  assert.equal(formatAmount(lb.parts[0]), '1¾ lb');
});
