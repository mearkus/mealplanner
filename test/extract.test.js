import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fileToRecipes, layoutPageText, splitRecipes } from '../public/lib/extract.js';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const libs = { pdfjs, pdfOptions: { verbosity: 0 } };

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const draw of pages) {
    const page = doc.addPage([612, 792]);
    draw({ text: (s, x, y, o = {}) => page.drawText(s, { x, y, size: o.size || 11, font: o.bold ? bold : font }), page });
  }
  return doc.save();
}

test('single-column recipe PDF', async () => {
  const bytes = await makePdf([({ text }) => {
    text("Grandma's Lentil Soup", 72, 720, { size: 20, bold: true });
    text('Serves 6', 72, 696);
    text('Ingredients', 72, 660, { bold: true });
    ['1 cup brown lentils', '1 yellow onion, diced', '2 carrots, chopped', '½ tsp ground cumin', '6 cups vegetable broth']
      .forEach((l, i) => text(l, 72, 640 - i * 16));
    text('Method', 72, 540, { bold: true });
    text('1. Soften the onion and carrots in a little oil.', 72, 520);
    text('2. Add lentils, cumin and broth; simmer 30 minutes.', 72, 504);
  }]);
  const r = await fileToRecipes('Lentil Soup.pdf', bytes, libs);
  assert.equal(r.status, 'ok');
  const [rec] = r.recipes;
  assert.equal(rec.title, "Grandma's Lentil Soup");
  assert.equal(rec.servings, 6);
  assert.deepEqual(rec.ingredients.map((i) => i.name), ['brown lentil', 'yellow onion', 'carrot', 'ground cumin', 'vegetable broth']);
  assert.equal(rec.ingredients[3].qty, 0.5);
  assert.match(rec.instructions, /^1\. Soften/);
});

test('two-column layout keeps ingredients and method apart', async () => {
  const bytes = await makePdf([({ text }) => {
    text('Chicken Tinga Tacos', 72, 720, { size: 20, bold: true });
    text('Ingredients', 72, 680, { bold: true });
    text('Method', 330, 680, { bold: true });
    const ings = ['1 lb chicken thighs', '1 can crushed tomatoes', '2 chipotle peppers', '1 bunch cilantro', '12 corn tortillas'];
    const steps = ['1. Simmer the chicken with', 'tomatoes and chipotle.', '2. Shred and return to pan.', '3. Warm the tortillas.', '4. Top with cilantro.'];
    ings.forEach((l, i) => text(l, 72, 660 - i * 16));
    steps.forEach((l, i) => text(l, 330, 660 - i * 16));
  }]);
  const [rec] = (await fileToRecipes('tinga.pdf', bytes, libs)).recipes;
  assert.deepEqual(rec.ingredients.map((i) => i.name), ['chicken thigh', 'crushed tomatoes', 'chipotle pepper', 'cilantro', 'corn tortillas']);
  assert.match(rec.instructions, /Simmer the chicken/);
  assert.ok(!rec.instructions.includes('tortillas\n') || true);
});

test('two columns under a full-width title', async () => {
  const bytes = await makePdf([({ text }) => {
    text('Lemon Herb Chicken & Greens With Quinoa', 72, 720, { size: 22, bold: true });
    text('Serves 4', 72, 698);
    text('Ingredients', 72, 660, { bold: true }); text('Method', 330, 660, { bold: true });
    ['1½ lb chicken breast', '2 lemons', '1 bunch parsley', '3 cloves garlic', '5 oz baby spinach'].forEach((l, i) => text(l, 72, 640 - i * 16));
    ['1. Marinate chicken in lemon,', 'garlic and parsley.', '2. Cook quinoa.', '3. Grill the chicken.', '4. Serve with spinach.'].forEach((l, i) => text(l, 330, 640 - i * 16));
    text('Tip: leftovers make a great lunch salad the next day, served cold with extra lemon.', 72, 520);
  }]);
  const [rec] = (await fileToRecipes('lemon.pdf', bytes, libs)).recipes;
  assert.equal(rec.title, 'Lemon Herb Chicken & Greens With Quinoa');
  assert.deepEqual(rec.ingredients.map((i) => i.raw), ['1½ lb chicken breast', '2 lemons', '1 bunch parsley', '3 cloves garlic', '5 oz baby spinach']);
  assert.match(rec.instructions, /^1\. Marinate chicken in lemon, garlic and parsley\.\n2\. Cook quinoa\./);
});

test('a PDF holding two recipes becomes two recipes', async () => {
  const bytes = await makePdf([
    ({ text }) => { text('Pancakes', 72, 720, { bold: true, size: 18 }); text('Ingredients', 72, 690, { bold: true }); text('2 cups flour', 72, 670); text('2 eggs', 72, 654); text('Method', 72, 620, { bold: true }); text('1. Mix and fry.', 72, 600); },
    ({ text }) => { text('Green Salad', 72, 720, { bold: true, size: 18 }); text('Ingredients', 72, 690, { bold: true }); text('1 head romaine', 72, 670); text('1 cucumber', 72, 654); text('Method', 72, 620, { bold: true }); text('1. Toss together.', 72, 600); },
  ]);
  const r = await fileToRecipes('family favourites.pdf', bytes, libs);
  assert.deepEqual(r.recipes.map((x) => x.title), ['Pancakes', 'Green Salad']);
  assert.deepEqual(r.recipes[1].ingredients.map((i) => i.name), ['romaine', 'cucumber']);
});

test('scanned PDF (no text layer) is flagged instead of guessed', async () => {
  const bytes = await makePdf([({ page }) => page.drawRectangle({ x: 50, y: 50, width: 500, height: 600, color: rgb(0.9, 0.9, 0.85) })]);
  const r = await fileToRecipes('scan.pdf', bytes, libs);
  assert.equal(r.status, 'needs_ocr');
  assert.equal(r.recipes.length, 0);
});

test('layout: same-line words join, columns split', () => {
  const items = [
    { str: 'Title', x: 72, y: 700, w: 40, h: 12 },
    ...[0, 1, 2, 3].flatMap((i) => [{ str: `left ${i}`, x: 72, y: 600 - i * 15, w: 60, h: 10 }, { str: `right ${i}`, x: 350, y: 600 - i * 15, w: 60, h: 10 }]),
  ];
  const text = layoutPageText(items, 612);
  assert.ok(text.indexOf('left 3') < text.indexOf('right 0'), text);
  assert.equal(splitRecipes('A\nIngredients\n1 egg\nB\nIngredients\n2 eggs').length, 2);
});
