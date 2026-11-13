// Adds a few sample recipes so you can try the app before importing your own.
import { openDb, saveRecipe, listRecipes, logCooked, createUser, createHousehold } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { resolveFamily } from './family.js';

const SAMPLES = [
  { title: 'Chicken Tinga Tacos', servings: 4, prepMinutes: 35, tags: ['mexican'], favorite: true, cooked: 40,
    ingredients: ['1.5 lb boneless skinless chicken thighs', '1 yellow onion, sliced', '3 cloves garlic, minced', '1 (14 oz) can crushed tomatoes', '2 chipotle peppers in adobo', '12 corn tortillas', '1 bunch cilantro', '2 limes', '1 avocado', 'Salt and pepper to taste'],
    instructions: '1. Simmer chicken with tomatoes, chipotle, onion and garlic for 25 minutes.\n2. Shred and serve in warm tortillas with cilantro, avocado and lime.' },
  { title: 'Black Bean & Sweet Potato Bowls', servings: 4, prepMinutes: 40, tags: ['vegetarian'], favorite: true, cooked: 25,
    ingredients: ['2 sweet potatoes, cubed', '1 (15 oz) can black beans, rinsed', '1 cup brown rice', '1 red bell pepper, diced', '1 bunch cilantro', '2 limes', '1 avocado', '2 tbsp olive oil', '1 tsp ground cumin'],
    instructions: '1. Roast sweet potato and pepper at 425°F for 25 minutes.\n2. Cook rice. 3. Assemble bowls with beans, cilantro, avocado and lime.' },
  { title: 'Creamy Tuscan Chicken Pasta', servings: 4, prepMinutes: 30, tags: ['italian'], cooked: 9,
    ingredients: ['1 lb penne pasta', '1 lb chicken breast', '1 cup heavy cream', '1/2 cup parmesan cheese, grated', '3 cloves garlic', '2 cups spinach', '1/2 cup sun-dried tomatoes', '2 tbsp butter'],
    instructions: '1. Cook pasta. 2. Sear chicken, then make the sauce with garlic, cream and parmesan.\n3. Wilt in spinach and sun-dried tomatoes; toss with pasta.' },
  { title: 'Sheet-Pan Salmon with Broccoli', servings: 4, prepMinutes: 25, tags: ['quick'], favorite: true,
    ingredients: ['4 salmon fillets', '1 head broccoli, cut into florets', '1 lemon', '3 cloves garlic', '2 tbsp olive oil', '1 cup quinoa', 'Salt and pepper'],
    instructions: '1. Toss broccoli with oil and garlic; roast 10 minutes at 425°F.\n2. Add salmon and lemon slices; roast 12 more minutes. Serve with quinoa.' },
  { title: 'Beef Chili', servings: 6, prepMinutes: 60, tags: ['comfort'], cooked: 70, favorite: true,
    ingredients: ['1 lb ground beef', '1 yellow onion, diced', '1 red bell pepper, diced', '3 cloves garlic', '1 (15 oz) can kidney beans', '1 (15 oz) can black beans', '1 (28 oz) can crushed tomatoes', '2 tbsp chili powder', '1 cup cheddar cheese, shredded', '1/2 cup sour cream'],
    instructions: '1. Brown beef with onion, pepper and garlic.\n2. Add beans, tomatoes and spices; simmer 40 minutes. Top with cheese and sour cream.' },
  { title: 'Thai Green Curry with Vegetables', servings: 4, prepMinutes: 30, tags: ['thai', 'vegetarian'],
    ingredients: ['1 can coconut milk', '3 tbsp green curry paste', '1 red bell pepper, sliced', '1 head broccoli', '1 block firm tofu', '1 cup jasmine rice', '1 bunch cilantro', '1 lime', '1 tbsp fish sauce'],
    instructions: '1. Fry curry paste, add coconut milk.\n2. Simmer vegetables and tofu 10 minutes. Finish with lime and cilantro; serve with rice.' },
  { title: 'Spinach & Feta Omelette', servings: 2, prepMinutes: 15, tags: ['quick', 'vegetarian'],
    ingredients: ['6 eggs', '2 cups spinach', '1/2 cup feta cheese', '1 cup cherry tomatoes', '1 tbsp butter'],
    instructions: '1. Wilt spinach in butter. 2. Add beaten eggs, cook gently, top with feta and tomatoes.' },
];

openDb();
let hid = resolveFamily(process.argv);
if (!hid) {
  // Fresh server: create a demo login so you can look around.
  const uid = createUser({ email: 'demo@example.com', name: 'Demo', passwordHash: await hashPassword('demo-password') });
  hid = createHousehold('Demo family', uid);
  console.log('Created demo login: demo@example.com / demo-password');
}
if (listRecipes(hid, { withIngredients: false }).length && !process.argv.includes('--force')) {
  console.log('Recipes already exist; not seeding (use --force to add samples anyway).');
  process.exit(0);
}
for (const s of SAMPLES) {
  const { cooked, ...recipe } = s;
  const id = saveRecipe(hid, { ...recipe, source: 'sample' });
  if (cooked) logCooked(hid, id, { date: new Date(Date.now() - cooked * 86400000).toISOString().slice(0, 10) });
}
console.log(`Added ${SAMPLES.length} sample recipes.`);
