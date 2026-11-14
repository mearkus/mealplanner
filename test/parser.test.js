import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipeText } from '../public/lib/parser.js';
import { recipesFromJsonLd } from '../public/lib/extract.js';

test('parses a typical plain-text recipe', () => {
  const r = parseRecipeText(`# Grandma's Chili
Serves 6
Total time: 1 hr 15 min

Ingredients
- 1 lb ground beef
- 1 onion, diced
- 2 cans kidney beans

Instructions
1. Brown the beef with the onion.
2. Add beans and simmer.

Notes
Better the next day.`);
  assert.equal(r.title, "Grandma's Chili");
  assert.equal(r.servings, 6);
  assert.equal(r.prepMinutes, 75);
  assert.deepEqual(r.ingredients.map((i) => i.name), ['ground beef', 'yellow onion', 'kidney beans']);
  assert.match(r.instructions, /^1\. Brown/);
  assert.equal(r.notes, 'Better the next day.');
});

test('works without section headers', () => {
  const r = parseRecipeText('Quick Eggs\n3 eggs\n1 tbsp butter\nsalt\n1. Whisk the eggs and cook them gently in butter until just set.');
  assert.equal(r.title, 'Quick Eggs');
  assert.equal(r.ingredients.length, 3);
  assert.match(r.instructions, /Whisk/);
});

test('reads schema.org Recipe JSON-LD', () => {
  const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"Recipe","name":"Lemon Pasta","recipeYield":"4 servings","totalTime":"PT25M","recipeIngredient":["8 oz spaghetti","1 lemon"],"recipeInstructions":[{"@type":"HowToStep","text":"Boil pasta."},{"@type":"HowToStep","text":"Add lemon."}]}]}</script></html>`;
  const [r] = recipesFromJsonLd(html);
  assert.equal(r.title, 'Lemon Pasta');
  assert.equal(r.servings, 4);
  assert.equal(r.prepMinutes, 25);
  assert.equal(r.ingredients.length, 2);
  assert.equal(r.instructions, '1. Boil pasta.\n2. Add lemon.');
});
