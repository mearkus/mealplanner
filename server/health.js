// Rough, explainable "healthiness" score (1-5) from ingredients and title.
// It is a starting point: you can override it per recipe in the app.

export const HEALTH_LEVELS = {
  1: 'Indulgent',
  2: 'Comfort',
  3: 'Balanced',
  4: 'Healthy',
  5: 'Very healthy',
};

const GOOD = [
  [/spinach|kale|arugula|chard|lettuce|romaine|greens|cabbage|bok choy/, 0.6],
  [/broccoli|cauliflower|brussels|asparagus|green bean|zucchini|squash|eggplant|bell pepper|carrot|celery|cucumber|mushroom|tomato|pea\b|peas|beet|fennel|leek|radish/, 0.35],
  [/lentil|chickpea|black beans|kidney beans|pinto beans|cannellini|beans|edamame|tofu|tempeh/, 0.6],
  [/quinoa|brown rice|farro|barley|bulgur|oat|whole wheat|wild rice/, 0.5],
  [/salmon|cod|tuna|tilapia|halibut|shrimp|prawn|fish|mussel|scallop|sardine/, 0.6],
  [/chicken breast|turkey|lean/, 0.35],
  [/avocado|olive oil|nuts?\b|almond|walnut|seed/, 0.15],
  [/sweet potato/, 0.3],
  [/greek yogurt/, 0.2],
  [/lemon|lime|herb|cilantro|parsley|basil|dill|mint|ginger|garlic/, 0.05],
];

const BAD = [
  [/heavy cream|whipping cream|double cream|half and half/, 0.8],
  [/butter\b/, 0.4],
  [/cheese|parmesan|mozzarella|cheddar|ricotta|feta/, 0.3],
  [/bacon|sausage|chorizo|pancetta|salami|pepperoni|hot dog/, 0.7],
  [/ground beef|steak|ribeye|brisket|pork belly|short rib/, 0.35],
  [/sugar|syrup|honey|chocolate|caramel|candy/, 0.3],
  [/white rice|pasta|spaghetti|penne|noodle|macaroni|lasagna|white bread|baguette|bun|roll|tortilla|pizza dough|puff pastry|pie crust/, 0.3],
  [/mayo|mayonnaise|sour cream|cream cheese/, 0.35],
  [/vegetable oil for frying|oil for frying|deep fry|lard|shortening/, 0.9],
];

const TITLE_BAD = [/fried|deep[- ]fried|carbonara|alfredo|mac (and|&) cheese|lasagn|pizza|burger|cake|brownie|cookie|pie\b|cheesy|loaded|casserole|nachos|queso|gravy/];
const TITLE_GOOD = [/salad|grilled|steamed|roasted veg|bowl|soup|stir[- ]fry|poached|baked salmon|lentil|veggie|vegetable/];

/** Returns { score: 1..5, reasons: string[] } */
export function scoreHealth(title, ingredients) {
  let score = 3;
  const reasons = [];
  const names = ingredients.map((i) => (typeof i === 'string' ? i : i.name || '')).map((n) => n.toLowerCase());
  const t = (title || '').toLowerCase();
  let goodTotal = 0; let badTotal = 0;
  // Each kind of good/bad thing counts once, except vegetables (up to 3 different ones).
  for (const [idx, [re, w]] of GOOD.entries()) {
    const hits = names.filter((n) => re.test(n)).length;
    goodTotal += w * Math.min(hits, idx <= 1 ? 3 : 1);
  }
  for (const [re, w] of BAD) if (names.some((n) => re.test(n))) badTotal += w;
  const veg = names.filter((n) => GOOD[0][0].test(n) || GOOD[1][0].test(n)).length;
  if (veg >= 3) reasons.push(`${veg} vegetables`);
  if (names.some((n) => GOOD[2][0].test(n))) reasons.push('legumes / plant protein');
  if (names.some((n) => GOOD[4][0].test(n))) reasons.push('fish / seafood');
  if (names.some((n) => GOOD[3][0].test(n))) reasons.push('whole grains');
  if (names.some((n) => BAD[0][0].test(n))) reasons.push('cream');
  if (names.some((n) => BAD[3][0].test(n))) reasons.push('processed meat');
  if (names.some((n) => BAD[2][0].test(n))) reasons.push('cheese');
  if (TITLE_BAD.some((re) => re.test(t))) { badTotal += 0.8; reasons.push('rich dish'); }
  if (TITLE_GOOD.some((re) => re.test(t))) { goodTotal += 0.4; }
  score += Math.min(goodTotal, 2.2) - Math.min(badTotal, 2.4);
  return { score: Math.max(1, Math.min(5, Math.round(score))), reasons };
}

const SWAPS = [
  [/heavy cream|whipping cream|double cream/, 'Swap heavy cream for half milk / half Greek yogurt, or evaporated milk'],
  [/sour cream/, 'Use plain Greek yogurt instead of sour cream'],
  [/mayo|mayonnaise/, 'Cut mayo 50/50 with Greek yogurt'],
  [/white rice/, 'Try brown rice, quinoa, or half cauliflower rice'],
  [/pasta|spaghetti|penne|macaroni|noodle/, 'Use whole-wheat or lentil pasta, or swap half for zucchini noodles'],
  [/ground beef/, 'Use lean ground turkey or half beef / half lentils or mushrooms'],
  [/bacon|pancetta/, 'Halve the bacon and add smoked paprika for the smoky flavour'],
  [/sausage|chorizo/, 'Use chicken sausage, or halve it and add beans'],
  [/butter\b/, 'Use olive oil for sautéing and cut butter by half'],
  [/cheese|parmesan|cheddar|mozzarella/, 'Use a smaller amount of a sharper cheese — same flavour, less of it'],
  [/sugar|syrup|honey/, 'Reduce sugar by about a third — most recipes won\'t notice'],
  [/tortilla|bun|roll|bread/, 'Use whole-grain versions, or serve in lettuce cups'],
  [/oil for frying|deep fry/, 'Oven- or air-fry instead of deep frying'],
];

export function lighterTips(ingredients) {
  const names = ingredients.map((i) => (typeof i === 'string' ? i : i.name || '').toLowerCase());
  const tips = [];
  for (const [re, tip] of SWAPS) if (names.some((n) => re.test(n))) tips.push(tip);
  const veg = names.filter((n) => GOOD[0][0].test(n) || GOOD[1][0].test(n)).length;
  if (veg < 2) tips.push('Add a side salad or a couple of handfuls of spinach / frozen veg');
  return tips;
}
