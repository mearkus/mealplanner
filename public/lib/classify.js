// Recipe metadata: course (main/side/...), seasons and weeknight/weekend.
// Each value is either set by the family (stored on the recipe) or, when not set (null), guessed here from the
// title, ingredients and time. `effectiveMeta` returns what to show/filter by, with flags saying what was guessed.

export const COURSES = ['main', 'side', 'dessert', 'breakfast', 'other'];
export const COURSE_LABELS = { main: 'Main', side: 'Side', dessert: 'Dessert', breakfast: 'Breakfast', other: 'Other' };
export const SEASONS = ['spring', 'summer', 'fall', 'winter'];
export const SEASON_LABELS = { spring: '🌸 Spring', summer: '☀️ Summer', fall: '🍂 Fall', winter: '❄️ Winter' };
export const OCCASIONS = ['weeknight', 'weekend'];
export const OCCASION_LABELS = { weeknight: '🌙 Weeknight', weekend: '🏖️ Weekend' };

const has = (text, re) => re.test(text);
const words = (r) => `${r.title || ''} ${(r.tags || []).join(' ')}`.toLowerCase();
const ingNames = (r) => (r.ingredients || []).map((i) => (typeof i === 'string' ? i : i.name || '')).map((n) => n.toLowerCase());

const DESSERT = /\b(?:cake|cupcake|cookie|brownie|blondie|(?<!(?:pot|shepherd'?s?|cottage|chicken|meat|pork|steak|fish) )pie|tart|crumble|crisp|cobbler|pudding|ice cream|gelato|sorbet|cheesecake|muffin|fudge|mousse|dessert|truffle|macaron|meringue|pavlova|tiramisu|custard|scone|banana bread|frosting|candy|candies|bar cookie)s?\b/;
const BREAKFAST = /\b(?:pancake|waffle|omelet|omelette|french toast|granola|oatmeal|overnight oat|porridge|frittata|breakfast|brunch|smoothie|scrambled egg|shakshuka|hash brown|eggs benedict|quiche|crepe)s?\b/;
const OTHER = /\b(dressing|vinaigrette|sauce|salsa|pesto|marinade|dip|gravy|aioli|chutney|jam|pickles?|seasoning|spice (mix|rub)|rub|stock|broth|cocktail|lemonade|drink|punch|syrup|snack|trail mix|hummus|guacamole)\b/;
const SIDE = /\b(salad|slaw|coleslaw|side|mashed|smashed|roasted (vegetables|veggies|potatoes|carrots|broccoli|cauliflower|brussels sprouts|asparagus|squash)|fries|wedges|potatoes|rice|pilaf|couscous|quinoa|polenta|grits|cornbread|bread|rolls|biscuits|focaccia|garlic bread|green beans|asparagus|broccoli|brussels sprouts|carrots|corn on the cob|beans|stuffing|gratin|greens|vegetables|veggies|slaw)\b/;
const MAIN_TITLE = /\b(pasta|spaghetti|penne|linguine|fettuccine|rigatoni|tagliatelle|lasagn\w*|mac(aroni)? (and|&|n) cheese|cacio e pepe|carbonara|bolognese|noodles?|ramen|pho|pad thai|pizza|curry|stew|chili|chilli|soup|chowder|burrito|tacos?|enchiladas?|risotto|fajitas?|casserole|pot pie|shepherd'?s pie|cottage pie|pot roast|roast chicken|roast beef|sandwich|burgers?|wraps?|bowls?|stir[- ]fry|paella|jambalaya|gumbo|dinner|supper|main)\b/;
const PROTEIN_NAME = /\b(chicken|beef|pork|lamb|turkey|sausage|bacon|ham|steak|chuck|brisket|ribs?|tenderloin|loin|pot roast|drumsticks?|thighs?|salmon|tuna|cod|shrimp|prawn|fish|tofu|tempeh|duck|veal|mince|meatball|chorizo|halibut|tilapia|scallop|crab|lobster|mussel|clam)\b/;

const VEG_PROTEIN = /\b(black beans|kidney beans|pinto beans|cannellini beans|white beans|chickpeas?|lentils?|tofu|tempeh|eggs|paneer|halloumi|edamame|seitan)\b/;

function hasProtein(r) {
  return (r.ingredients || []).some((i) => i.category === 'Meat & Seafood')
    || ingNames(r).some((n) => PROTEIN_NAME.test(n) || VEG_PROTEIN.test(n));
}

/** Best guess at the course. */
export function guessCourse(r) {
  const t = words(r);
  if (has(t, DESSERT)) return 'dessert';
  if (has(t, BREAKFAST)) return 'breakfast';
  if (has(t, OTHER) && !hasProtein(r)) return 'other';
  const titleProtein = PROTEIN_NAME.test(t);
  if (has(t, MAIN_TITLE) && !/\b(side|soup for one)\b/.test(t)) return 'main';
  if (has(t, SIDE) && !titleProtein && !hasProtein(r)) return 'side';
  if (has(t, SIDE) && !titleProtein && (r.ingredients || []).length <= 6) return 'side';
  // A short list of vegetables / grains with no protein is usually a side.
  if (!hasProtein(r) && !titleProtein && (r.ingredients || []).length > 0 && (r.ingredients || []).length <= 5) return 'side';
  return 'main';
}

const SEASON_HINTS = {
  winter: /\b(soup|stew|chili|chilli|braise|braised|pot roast|casserole|pot pie|chowder|ragu|bolognese|stroganoff|goulash|cassoulet|gratin|shepherd|cottage pie|mulled|hot chocolate|root vegetables?|parsnips?|turnips?|short ribs?)\b/,
  fall: /\b(pumpkin|butternut|squash|apple|pear|cranberr|pecan|sweet potato|maple|sage|mushroom|chili|stew|soup|cider|fig|brussels sprouts)\b/,
  summer: /\b(grill|grilled|bbq|barbecue|kebab|skewer|gazpacho|ceviche|salad|corn on the cob|sweet corn|zucchini|courgette|tomato(es)? (salad|bruschetta)|bruschetta|caprese|berr|peach|watermelon|mango|popsicle|ice cream|sorbet|cold|chilled|burgers?)\b/,
  spring: /\b(asparagus|peas?|snap peas|radish|rhubarb|strawberr|artichoke|leek|fava|spring|ramps?)\b/,
};

/** Seasons the recipe suits best; [] means good all year. */
export function guessSeasons(r) {
  const t = `${words(r)} ${ingNames(r).join(' ')}`;
  const titleT = words(r);
  const out = [];
  for (const s of SEASONS) {
    const re = SEASON_HINTS[s];
    // Title/tags count strongly; ingredients only for the more distinctive produce.
    if (re.test(titleT) || (s !== 'spring' && s !== 'summer' && re.test(t))) out.push(s);
  }
  // A light hint in ingredients for spring/summer produce only if two or more distinct matches.
  for (const s of ['spring', 'summer']) {
    if (out.includes(s)) continue;
    const hits = new Set(ingNames(r).map((n) => (SEASON_HINTS[s].exec(n) || [])[0]).filter(Boolean));
    if (hits.size >= 2) out.push(s);
  }
  return out.length === 4 ? [] : out;
}

/** Weeknight (quick) vs weekend (longer projects); [] means either. */
export function guessOccasions(r) {
  const t = `${words(r)} ${(r.instructions || '').toLowerCase()}`;
  const mins = Number(r.prepMinutes) || null;
  if (mins != null) {
    if (mins <= 45) return ['weeknight'];
    if (mins >= 75) return ['weekend'];
    return [];
  }
  if (/\b(overnight|braise|braised|slow[- ]roast|smoke|smoked|proof|knead|rise for|marinate for (\d+ )?hours|several hours|3 hours|4 hours)\b/.test(t)) return ['weekend'];
  if (/\b(quick|easy|15[- ]minute|20[- ]minute|30[- ]minute|one[- ]pan|sheet[- ]pan|weeknight|stir[- ]fry|instant pot|pressure cooker)\b/.test(t)) return ['weeknight'];
  return [];
}

/** What to show and filter by: stored values where set, otherwise guesses. */
export function effectiveMeta(r) {
  const course = COURSES.includes(r.course) ? r.course : null;
  const seasons = Array.isArray(r.seasons) ? r.seasons : null;
  const occasions = Array.isArray(r.occasions) ? r.occasions : null;
  return {
    course: course ?? guessCourse(r),
    courseAuto: course == null,
    seasons: seasons ?? guessSeasons(r),
    seasonsAuto: seasons == null,
    occasions: occasions ?? guessOccasions(r),
    occasionsAuto: occasions == null,
  };
}

/** Northern-hemisphere season for a date. */
export function currentSeason(date = new Date()) {
  const m = date.getMonth(); // 0 = Jan
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  if (m >= 8 && m <= 10) return 'fall';
  return 'winter';
}

/** Does a recipe suit this season? (No seasons = all year.) */
export const fitsSeason = (meta, season) => !season || meta.seasons.length === 0 || meta.seasons.includes(season);
/** Does a recipe suit this kind of night? (No occasion = either.) */
export const fitsOccasion = (meta, occasion) => !occasion || meta.occasions.length === 0 || meta.occasions.includes(occasion);
