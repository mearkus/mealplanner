// Ingredient parsing, normalisation, categorisation and quantity maths.
// Everything here is pure (no DB) so it is easy to test.

const UNICODE_FRACTIONS = {
  '¼': '1/4', '½': '1/2', '¾': '3/4', '⅓': '1/3', '⅔': '2/3', '⅕': '1/5',
  '⅖': '2/5', '⅗': '3/5', '⅘': '4/5', '⅙': '1/6', '⅚': '5/6', '⅛': '1/8',
  '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

// canonical unit -> { aliases, family, factor (to base unit of family) }
// volume base = ml, weight base = g
const UNITS = {
  tsp: { aliases: ['tsp', 'tsps', 'teaspoon', 'teaspoons', 't'], family: 'volume', factor: 4.92892 },
  tbsp: { aliases: ['tbsp', 'tbsps', 'tbs', 'tbl', 'tablespoon', 'tablespoons', 'T'], family: 'volume', factor: 14.7868 },
  'fl oz': { aliases: ['fl oz', 'fl. oz', 'fluid ounce', 'fluid ounces'], family: 'volume', factor: 29.5735 },
  cup: { aliases: ['cup', 'cups', 'c'], family: 'volume', factor: 236.588 },
  pint: { aliases: ['pint', 'pints', 'pt'], family: 'volume', factor: 473.176 },
  quart: { aliases: ['quart', 'quarts', 'qt'], family: 'volume', factor: 946.353 },
  ml: { aliases: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'], family: 'volume', factor: 1 },
  l: { aliases: ['l', 'liter', 'liters', 'litre', 'litres'], family: 'volume', factor: 1000 },
  g: { aliases: ['g', 'gram', 'grams', 'gr'], family: 'weight', factor: 1 },
  kg: { aliases: ['kg', 'kilogram', 'kilograms', 'kilo', 'kilos'], family: 'weight', factor: 1000 },
  oz: { aliases: ['oz', 'ounce', 'ounces'], family: 'weight', factor: 28.3495 },
  lb: { aliases: ['lb', 'lbs', 'pound', 'pounds'], family: 'weight', factor: 453.592 },
  clove: { aliases: ['clove', 'cloves'], family: 'count' },
  can: { aliases: ['can', 'cans', 'tin', 'tins'], family: 'count' },
  jar: { aliases: ['jar', 'jars'], family: 'count' },
  package: { aliases: ['package', 'packages', 'pkg', 'packet', 'packets', 'pack', 'packs', 'box', 'boxes', 'bag', 'bags'], family: 'count' },
  bunch: { aliases: ['bunch', 'bunches'], family: 'count' },
  head: { aliases: ['head', 'heads'], family: 'count' },
  slice: { aliases: ['slice', 'slices'], family: 'count' },
  stalk: { aliases: ['stalk', 'stalks', 'rib', 'ribs'], family: 'count' },
  sprig: { aliases: ['sprig', 'sprigs'], family: 'count' },
  pinch: { aliases: ['pinch', 'pinches'], family: 'count' },
  dash: { aliases: ['dash', 'dashes'], family: 'count' },
  handful: { aliases: ['handful', 'handfuls'], family: 'count' },
  stick: { aliases: ['stick', 'sticks'], family: 'count' },
  fillet: { aliases: ['fillet', 'fillets', 'filet', 'filets'], family: 'count' },
  piece: { aliases: ['piece', 'pieces', 'pc', 'pcs'], family: 'count' },
};

const UNIT_LOOKUP = new Map();
for (const [canon, def] of Object.entries(UNITS)) {
  for (const a of def.aliases) UNIT_LOOKUP.set(a === 'T' ? a : a.toLowerCase(), canon);
}

// Words that describe preparation/size rather than identity of the ingredient.
const DESCRIPTORS = new Set([
  'fresh', 'freshly', 'large', 'small', 'medium', 'big', 'chopped', 'finely', 'roughly', 'coarsely',
  'thinly', 'diced', 'minced', 'sliced', 'grated', 'shredded', 'crushed', 'peeled', 'seeded', 'cubed',
  'halved', 'quartered', 'trimmed', 'rinsed', 'drained', 'softened', 'melted', 'room', 'temperature',
  'boneless', 'skinless', 'ripe', 'packed', 'heaping', 'level', 'about', 'approximately', 'optional',
  'to', 'taste', 'plus', 'more', 'for', 'serving', 'garnish', 'divided', 'cold', 'warm', 'hot',
  'cooked', 'uncooked', 'raw', 'dried', 'whole', 'extra', 'good', 'quality', 'organic', 'lightly',
  'beaten', 'juiced', 'zested', 'and', 'or', 'of', 'a', 'an', 'the', 'into', 'pieces', 'inch',
  'cut', 'torn', 'firmly', 'loosely', 'very', 'thin', 'thick', 'heaped', 'scant', 'generous',
]);

// Keep these "descriptor" words when they change what you buy.
const KEEP_PHRASES = [
  'extra virgin olive oil', 'sour cream', 'cream cheese', 'heavy cream', 'whipping cream', 'ice cream',
  'brown sugar', 'powdered sugar', 'baking soda', 'baking powder', 'red pepper flakes', 'black pepper',
  'dried oregano', 'dried thyme', 'dried basil', 'whole wheat', 'whole milk', 'ground beef',
  'ground turkey', 'ground pork', 'ground chicken', 'ground cumin', 'ground cinnamon', 'green onion',
  'red onion', 'yellow onion', 'white onion', 'sweet potato', 'bell pepper', 'chicken breast',
  'chicken thigh', 'chicken stock', 'chicken broth', 'vegetable stock', 'vegetable broth', 'beef stock',
  'beef broth', 'soy sauce', 'fish sauce', 'hot sauce', 'tomato paste', 'tomato sauce', 'coconut milk',
  'greek yogurt', 'parmesan cheese', 'cheddar cheese', 'feta cheese', 'goat cheese', 'black beans',
  'kidney beans', 'pinto beans', 'cannellini beans', 'brown rice', 'white rice', 'jasmine rice',
  'basmati rice', 'cauliflower rice', 'olive oil', 'vegetable oil', 'canola oil', 'sesame oil',
  'coconut oil', 'maple syrup', 'lemon juice', 'lime juice', 'rice vinegar', 'red wine vinegar',
  'balsamic vinegar', 'apple cider vinegar', 'dijon mustard', 'pine nuts', 'cherry tomatoes',
  'crushed tomatoes', 'diced tomatoes', 'whole tomatoes', 'garlic powder', 'onion powder', 'chili powder',
  'smoked paprika', 'italian seasoning', 'bay leaf', 'bay leaves', 'corn tortillas', 'flour tortillas',
];

// Synonyms -> canonical name
const ALIASES = {
  scallion: 'green onion', 'spring onion': 'green onion', 'cilantro leaf': 'cilantro',
  coriander: 'cilantro', 'garlic clove': 'garlic', 'clove garlic': 'garlic', 'garlic cloves': 'garlic',
  'ground black pepper': 'black pepper', pepper: 'black pepper', 'kosher salt': 'salt',
  'sea salt': 'salt', 'table salt': 'salt', 'evoo': 'extra virgin olive oil',
  'chicken breasts': 'chicken breast', 'chicken thighs': 'chicken thigh', 'courgette': 'zucchini',
  'aubergine': 'eggplant', 'capsicum': 'bell pepper', 'egg': 'eggs', 'all purpose flour': 'flour',
  'all-purpose flour': 'flour', 'plain flour': 'flour', 'parmesan': 'parmesan cheese',
  'parmigiano reggiano': 'parmesan cheese', 'parmigiano-reggiano': 'parmesan cheese',
  'chicken stock': 'chicken broth', 'vegetable stock': 'vegetable broth', 'beef stock': 'beef broth',
  'bay leaves': 'bay leaf', 'lemon': 'lemons', 'lime': 'limes', 'tomato': 'tomatoes',
  'crushed tomato': 'crushed tomatoes', 'diced tomato': 'diced tomatoes', 'cherry tomato': 'cherry tomatoes',
  'potato': 'potatoes', 'onion': 'yellow onion', 'red pepper flake': 'red pepper flakes',
  'garbanzo bean': 'chickpeas', 'garbanzo beans': 'chickpeas', 'chickpea': 'chickpeas',
  'black bean': 'black beans', 'kidney bean': 'kidney beans', 'pinto bean': 'pinto beans',
  'cannellini bean': 'cannellini beans', 'corn tortilla': 'corn tortillas', 'flour tortilla': 'flour tortillas',
  'pine nut': 'pine nuts', 'unsalted butter': 'butter', 'salted butter': 'butter',
  'juice of lemon': 'lemons', 'juice of lime': 'limes',
};

// Things almost everyone keeps on hand; shown in a separate "check the pantry" list.
const STAPLES = new Set([
  'salt', 'black pepper', 'water', 'olive oil', 'extra virgin olive oil', 'vegetable oil', 'canola oil',
  'cooking spray', 'flour', 'sugar', 'brown sugar', 'baking soda', 'baking powder', 'garlic powder',
  'onion powder', 'red pepper flakes', 'ground cumin', 'cumin', 'paprika', 'smoked paprika',
  'chili powder', 'dried oregano', 'oregano', 'dried thyme', 'italian seasoning', 'ground cinnamon',
  'cinnamon', 'vanilla extract', 'soy sauce', 'bay leaf', 'ice', 'salt and pepper',
]);

const CATEGORY_KEYWORDS = [
  ['Produce', ['lettuce', 'spinach', 'kale', 'arugula', 'cabbage', 'broccoli', 'cauliflower', 'carrot',
    'celery', 'onion', 'shallot', 'garlic', 'ginger', 'potato', 'sweet potato', 'tomato', 'cucumber',
    'zucchini', 'squash', 'eggplant', 'pepper', 'jalapeno', 'jalapeño', 'chile', 'chili pepper',
    'mushroom', 'avocado', 'lemon', 'lime', 'orange', 'apple', 'banana', 'berries', 'strawberr',
    'blueberr', 'raspberr', 'grape', 'mango', 'pineapple', 'peach', 'pear', 'cilantro', 'parsley',
    'basil', 'mint', 'dill', 'chive', 'rosemary', 'thyme', 'sage', 'scallion', 'green onion', 'leek',
    'asparagus', 'green bean', 'pea', 'corn', 'radish', 'beet', 'fennel', 'bok choy', 'sprout',
    'romaine', 'herb', 'salad', 'greens', 'chard', 'brussels', 'tofu', 'tempeh']],
  ['Meat & Seafood', ['chicken', 'beef', 'pork', 'turkey', 'lamb', 'sausage', 'bacon', 'ham', 'steak',
    'salmon', 'shrimp', 'prawn', 'tuna', 'cod', 'tilapia', 'halibut', 'fish', 'scallop', 'crab',
    'lobster', 'mussel', 'clam', 'chorizo', 'prosciutto', 'pancetta', 'mince', 'meatball', 'brisket']],
  ['Dairy & Eggs', ['milk', 'cream', 'butter', 'cheese', 'yogurt', 'yoghurt', 'egg', 'parmesan',
    'mozzarella', 'cheddar', 'feta', 'ricotta', 'sour cream', 'creme fraiche', 'half and half', 'ghee']],
  ['Bakery', ['bread', 'bun', 'roll', 'tortilla', 'pita', 'naan', 'baguette', 'bagel', 'croissant', 'wrap']],
  ['Frozen', ['frozen', 'ice cream']],
  ['Spices & Seasonings', ['salt', 'pepper', 'cumin', 'paprika', 'oregano', 'cinnamon', 'nutmeg',
    'turmeric', 'curry powder', 'chili powder', 'garlic powder', 'onion powder', 'seasoning',
    'bay leaf', 'cayenne', 'coriander seed', 'clove', 'allspice', 'flakes', 'vanilla']],
  ['Pantry', ['flour', 'sugar', 'oil', 'vinegar', 'rice', 'pasta', 'spaghetti', 'penne', 'noodle',
    'quinoa', 'oat', 'bean', 'lentil', 'chickpea', 'broth', 'stock', 'sauce', 'paste', 'canned',
    'honey', 'maple', 'syrup', 'mustard', 'ketchup', 'mayo', 'mayonnaise', 'nut', 'almond', 'walnut',
    'pecan', 'cashew', 'peanut', 'seed', 'baking', 'yeast', 'cornstarch', 'cocoa', 'chocolate',
    'coconut milk', 'breadcrumb', 'panko', 'cracker', 'tahini', 'salsa', 'wine', 'raisin', 'olive',
    'caper', 'couscous', 'polenta', 'tomatoes']],
];

// Categories where a check against an earlier match matters (e.g. "black pepper" -> spices, not produce).
const CATEGORY_OVERRIDES = {
  'black pepper': 'Spices & Seasonings', 'red pepper flakes': 'Spices & Seasonings',
  'bell pepper': 'Produce', 'green onion': 'Produce', 'coconut milk': 'Pantry',
  'peanut butter': 'Pantry', 'butter': 'Dairy & Eggs', 'cream cheese': 'Dairy & Eggs',
  'crushed tomatoes': 'Pantry', 'diced tomatoes': 'Pantry', 'tomato paste': 'Pantry',
  'tomato sauce': 'Pantry', 'whole tomatoes': 'Pantry', 'eggs': 'Dairy & Eggs', 'water': 'Pantry',
  'garlic': 'Produce', 'ginger': 'Produce', 'chicken broth': 'Pantry', 'beef broth': 'Pantry',
  'vegetable broth': 'Pantry', 'corn tortillas': 'Bakery', 'flour tortillas': 'Bakery',
  'cherry tomatoes': 'Produce', 'tomatoes': 'Produce', 'thyme': 'Produce', 'dried thyme': 'Spices & Seasonings',
  'dried oregano': 'Spices & Seasonings', 'dried basil': 'Spices & Seasonings', 'cilantro': 'Produce',
  'frozen peas': 'Frozen', 'salt and pepper': 'Spices & Seasonings', 'salt': 'Spices & Seasonings', 'olive oil': 'Pantry', 'extra virgin olive oil': 'Pantry',
};

export const CATEGORY_ORDER = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Pantry',
  'Spices & Seasonings', 'Frozen', 'Other'];

/** Parse "1 1/2", "1½", "1.5", "1-2", "1 to 2" at the start of a string. */
export function parseQuantity(text) {
  let s = text;
  for (const [u, r] of Object.entries(UNICODE_FRACTIONS)) s = s.replaceAll(u, ` ${r}`);
  s = s.replace(/(\d)\s+(?=\d+\/\d+)/, '$1 ').trimStart();
  const num = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?|\.\d+)`;
  const re = new RegExp(String.raw`^(${num})(?:\s*(?:-|–|to)\s*(${num}))?\s*`);
  const m = s.match(re);
  if (!m) return { qty: null, rest: s.trim() };
  const toNum = (t) => t.trim().split(/\s+/).reduce((acc, part) => {
    if (part.includes('/')) { const [a, b] = part.split('/').map(Number); return acc + (b ? a / b : 0); }
    return acc + Number(part);
  }, 0);
  const lo = toNum(m[1]);
  const hi = m[2] ? toNum(m[2]) : null;
  // For ranges buy for the top of the range.
  return { qty: hi ?? lo, rest: s.slice(m[0].length).trim() };
}

function matchUnit(rest) {
  // Try two-word units first ("fl oz", "fluid ounces").
  const words = rest.split(/\s+/);
  for (const n of [2, 1]) {
    if (words.length < n) continue;
    const cand = words.slice(0, n).join(' ').replace(/[.,]$/, '');
    const key = cand === 'T' ? 'T' : cand.toLowerCase();
    if (UNIT_LOOKUP.has(key)) {
      // A bare "c"/"t" must be followed by something to be a unit
      if ((key === 'c' || key === 't') && words.length === 1) continue;
      return { unit: UNIT_LOOKUP.get(key), rest: words.slice(n).join(' ') };
    }
  }
  return { unit: null, rest };
}

function singularize(word) {
  if (word.length <= 3) return word;
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (/(ches|shes|xes|oes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('ves')) return word.slice(0, -3) + 'f';
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Turn a free-form ingredient description into a canonical shopping name. */
export function normalizeName(text) {
  let s = (text || '').toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ');          // parentheticals
  s = s.split(/[,;]| - | – /)[0];            // notes after comma
  s = s.replace(/\bfor (the )?\w+.*$/, ' '); // "for serving", "for the sauce"
  s = s.replace(/-/g, ' ').replace(/[^a-z\s']/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^salt (and |& )?(black )?pepper/.test(s)) return 'salt and pepper';
  if (ALIASES[s]) return ALIASES[s];

  const kept = KEEP_PHRASES.find((p) => s.includes(p));
  let core;
  if (kept) {
    core = kept;
  } else {
    const words = s.split(' ').filter((w) => w && !DESCRIPTORS.has(w));
    core = words.join(' ') || s;
  }
  if (ALIASES[core]) return ALIASES[core];
  const singular = core.split(' ').map((w, i, arr) => (i === arr.length - 1 ? singularize(w) : w)).join(' ');
  if (ALIASES[singular]) return ALIASES[singular];
  // "basil leaf", "mint leaf" -> herb name (but keep "bay leaf")
  if (/ leaf$/.test(singular) && singular !== 'bay leaf') return singular.replace(/ leaf$/, '');
  // Prefer the singular form only when it is a known alias target or the word is clearly plural.
  return singular;
}

// Checked before the keyword table: jarred/canned things whose names contain produce or meat words.
const PANTRY_FIRST = ['sauce', 'paste', 'adobo', 'canned', 'stock', 'broth', 'powder', 'extract', 'oil', 'vinegar', 'dried', 'sun dried'];

export function categorize(name) {
  if (CATEGORY_OVERRIDES[name]) return CATEGORY_OVERRIDES[name];
  if (/powder|flakes|seasoning/.test(name)) return 'Spices & Seasonings';
  if (PANTRY_FIRST.some((w) => name.includes(w))) return 'Pantry';
  for (const [cat, words] of CATEGORY_KEYWORDS) {
    if (words.some((w) => name.includes(w))) return cat;
  }
  return 'Other';
}

export function isStaple(name) {
  return STAPLES.has(name);
}

/** Parse a raw ingredient line like "2 (14 oz) cans diced tomatoes, drained". */
export function parseIngredientLine(raw) {
  const line = (raw || '').replace(/^[\s•*\-–·▢□☐]+/, '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  // "Juice of 1 lemon" / "zest of 2 limes" -> 1 lemon
  const juice = line.match(/^(?:the\s+)?(?:juice|zest|juice and zest|zest and juice)\s+(?:from|of)\s+(.*)$/i);
  let { qty, rest } = parseQuantity(juice ? juice[1] : line);
  // "1 (14 oz) can tomatoes" -> skip the size parenthetical before unit
  let sizeNote = '';
  const paren = rest.match(/^\(([^)]*)\)\s*/);
  if (paren) { sizeNote = paren[1]; rest = rest.slice(paren[0].length); }
  let unit = null;
  ({ unit, rest } = matchUnit(rest));
  rest = rest.replace(/^of\s+/i, '');
  // "garlic, 3 cloves" style is rare; ignore.
  const name = normalizeName(rest);
  if (!name) return null;
  // "3 cloves garlic" -> keep clove as unit; "2 large eggs" -> count
  return {
    raw: line,
    qty,
    unit,
    name,
    note: [sizeNote, (rest.split(',').slice(1).join(',') || '').trim()].filter(Boolean).join('; '),
    category: categorize(name),
    staple: isStaple(name),
  };
}

export function unitInfo(unit) {
  return unit ? UNITS[unit] : null;
}

/** Sum a list of {qty, unit} amounts into the fewest human-readable parts. */
export function combineAmounts(amounts) {
  const volume = []; const weight = []; const counts = new Map(); let unspecified = false;
  for (const a of amounts) {
    if (a.qty == null) { unspecified = true; continue; }
    const info = unitInfo(a.unit);
    if (!info) counts.set('', (counts.get('') || 0) + a.qty);
    else if (info.family === 'volume') volume.push(a.qty * info.factor);
    else if (info.family === 'weight') weight.push(a.qty * info.factor);
    else counts.set(a.unit, (counts.get(a.unit) || 0) + a.qty);
  }
  const parts = [];
  if (counts.has('')) parts.push({ qty: counts.get(''), unit: null });
  for (const [u, q] of counts) if (u) parts.push({ qty: q, unit: u });
  if (weight.length) parts.push(bestUnit(weight.reduce((a, b) => a + b, 0), 'weight', amounts));
  if (volume.length) parts.push(bestUnit(volume.reduce((a, b) => a + b, 0), 'volume', amounts));
  return { parts, unspecified };
}

function bestUnit(base, family, amounts) {
  const metric = amounts.some((a) => ['g', 'kg', 'ml', 'l'].includes(a.unit));
  if (family === 'weight') {
    if (metric) return base >= 1000 ? { qty: base / 1000, unit: 'kg' } : { qty: base, unit: 'g' };
    const lb = base / UNITS.lb.factor;
    return lb >= 1 ? { qty: lb, unit: 'lb' } : { qty: base / UNITS.oz.factor, unit: 'oz' };
  }
  if (metric) return base >= 1000 ? { qty: base / 1000, unit: 'l' } : { qty: base, unit: 'ml' };
  const cups = base / UNITS.cup.factor;
  if (cups >= 0.25) return { qty: cups, unit: 'cup' };
  const tbsp = base / UNITS.tbsp.factor;
  if (tbsp >= 1) return { qty: tbsp, unit: 'tbsp' };
  return { qty: base / UNITS.tsp.factor, unit: 'tsp' };
}

const NICE_FRACTIONS = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'], [1, '']];

export function formatQty(q) {
  if (q == null) return '';
  if (q >= 10) return String(Math.round(q));
  const whole = Math.floor(q);
  const frac = q - whole;
  let best = NICE_FRACTIONS[0]; let diff = Infinity;
  for (const f of NICE_FRACTIONS) { const d = Math.abs(frac - f[0]); if (d < diff) { diff = d; best = f; } }
  if (diff > 0.06) return String(Math.round(q * 10) / 10);
  const w = best[0] === 1 ? whole + 1 : whole;
  return `${w || ''}${best[1]}` || '0';
}

const PLURAL_UNITS = { cup: 'cups', clove: 'cloves', can: 'cans', jar: 'jars', package: 'packages',
  bunch: 'bunches', head: 'heads', slice: 'slices', stalk: 'stalks', sprig: 'sprigs', pinch: 'pinches',
  dash: 'dashes', handful: 'handfuls', stick: 'sticks', fillet: 'fillets', piece: 'pieces', pint: 'pints', quart: 'quarts' };

export function formatAmount({ qty, unit }) {
  const q = formatQty(qty);
  if (!unit) return q;
  const u = qty > 1 && PLURAL_UNITS[unit] ? PLURAL_UNITS[unit] : unit;
  return `${q} ${u}`.trim();
}

export function scaleIngredient(ing, factor) {
  return { ...ing, qty: ing.qty == null ? null : ing.qty * factor };
}
