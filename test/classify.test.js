import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredientLine as p } from '../public/lib/ingredients.js';
import { guessCourse, guessSeasons, guessOccasions, effectiveMeta, fitsSeason, fitsOccasion, currentSeason } from '../public/lib/classify.js';

const R = (title, ings, extra = {}) => ({ title, ingredients: ings.map(p), ...extra });

test('guesses the course from title and ingredients', () => {
  const cases = [
    ['Chicken Tinga Tacos', ['1 lb chicken thighs', '12 corn tortillas'], 'main'],
    ['Black Bean & Sweet Potato Bowls', ['1 can black beans', '2 sweet potatoes', '1 cup brown rice'], 'main'],
    ['Cacio e Pepe', ['8 oz spaghetti', '1 cup pecorino', '2 tsp black pepper'], 'main'],
    ['Mushroom Risotto', ['1.5 cups arborio rice', '8 oz mushrooms'], 'main'],
    ['Sunday Pot Roast', ['3 lb chuck roast', '4 carrots'], 'main'],
    ['Chicken Pot Pie', ['2 chicken breasts', '1 pie crust'], 'main'],
    ["Shepherd's Pie", ['1 lb ground lamb', '2 lb potatoes'], 'main'],
    ['Chicken Caesar Salad', ['2 chicken breasts', '1 head romaine'], 'main'],
    ['Garlic Roasted Broccoli', ['1 head broccoli', '3 cloves garlic'], 'side'],
    ['Greek Salad', ['2 tomatoes', '1 cucumber', '4 oz feta cheese'], 'side'],
    ['Lemon Rice Pilaf', ['1 cup basmati rice', '1 lemon'], 'side'],
    ['Sweet Potato Fries', ['2 sweet potatoes', 'olive oil'], 'side'],
    ['Chocolate Chip Cookies', ['2 cups flour', '1 cup sugar'], 'dessert'],
    ['Apple Pie', ['6 apples', '1 pie crust'], 'dessert'],
    ['Buttermilk Pancakes', ['2 cups flour', '2 eggs'], 'breakfast'],
    ['Chimichurri Sauce', ['1 bunch parsley', 'olive oil'], 'other'],
  ];
  for (const [title, ings, want] of cases) assert.equal(guessCourse(R(title, ings)), want, title);
});

test('guesses seasons ([] = all year)', () => {
  assert.deepEqual(guessSeasons(R('Beef Chili', ['1 lb ground beef'])), ['fall', 'winter']);
  assert.deepEqual(guessSeasons(R('Butternut Squash Soup', ['1 butternut squash'])), ['fall', 'winter']);
  assert.deepEqual(guessSeasons(R('Grilled Corn with Lime Butter', ['4 ears corn'])), ['summer']);
  assert.deepEqual(guessSeasons(R('Asparagus & Pea Pasta', ['1 lb pasta', '1 bunch asparagus', '1 cup peas'])), ['spring']);
  assert.deepEqual(guessSeasons(R('Chicken Tinga Tacos', ['1 lb chicken thighs'])), []);
  assert.deepEqual(guessSeasons(R('Lemon Chicken', ['2 chicken breasts', '1 lemon'])), []);
});

test('guesses weeknight vs weekend from time and method', () => {
  assert.deepEqual(guessOccasions({ title: 'Stir-fry', prepMinutes: 25 }), ['weeknight']);
  assert.deepEqual(guessOccasions({ title: 'Pot Roast', prepMinutes: 240 }), ['weekend']);
  assert.deepEqual(guessOccasions({ title: 'Lasagna', prepMinutes: 60 }), []);
  assert.deepEqual(guessOccasions({ title: 'Braised Short Ribs', instructions: 'Braise for 3 hours.' }), ['weekend']);
  assert.deepEqual(guessOccasions({ title: 'Sheet-pan sausages and peppers' }), ['weeknight']);
});

test('family choices override guesses; [] means all year / any night', () => {
  const r = R('Beef Chili', ['1 lb ground beef'], { prepMinutes: 30 });
  const auto = effectiveMeta(r);
  assert.equal(auto.course, 'main'); assert.equal(auto.courseAuto, true);
  assert.deepEqual(auto.seasons, ['fall', 'winter']);
  const set = effectiveMeta({ ...r, course: 'side', seasons: [], occasions: ['weekend'] });
  assert.equal(set.course, 'side'); assert.equal(set.courseAuto, false);
  assert.deepEqual(set.seasons, []); assert.equal(set.seasonsAuto, false);
  assert.equal(fitsSeason(set, 'summer'), true); // all year
  assert.equal(fitsSeason(auto, 'summer'), false);
  assert.equal(fitsOccasion(set, 'weeknight'), false);
  assert.equal(currentSeason(new Date('2026-11-20T12:00:00')), 'fall');
  assert.equal(currentSeason(new Date('2026-01-10T12:00:00')), 'winter');
});
