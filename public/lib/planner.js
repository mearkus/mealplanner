// Pure planning logic: shopping list aggregation, ingredient overlap, batching, suggestions.
import { combineAmounts, formatAmount, CATEGORY_ORDER } from './ingredients.js';
import { HEALTH_LEVELS } from './health.js';
import { effectiveMeta, fitsSeason, fitsOccasion, SEASON_LABELS, OCCASION_LABELS } from './classify.js';

// Sharing perishables matters most: half a bunch of cilantro shouldn't go to waste.
const CATEGORY_WEIGHT = { Produce: 1.5, 'Meat & Seafood': 1.2, 'Dairy & Eggs': 1.1, Bakery: 1.2, Pantry: 0.6, Frozen: 0.5, 'Spices & Seasonings': 0.2, Other: 0.6 };
const PERISHABLE = new Set(['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery']);
// In nearly every recipe and keeps for weeks, so sharing them says little about batching.
const LOW_SIGNAL = new Set(['garlic', 'yellow onion', 'eggs', 'butter']);
const ingWeight = (name, cat) => (LOW_SIGNAL.has(name) ? 0.3 : CATEGORY_WEIGHT[cat] ?? 0.6);

export function daysSince(dateStr, today = new Date()) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((t - d.getTime()) / 86400000);
}

/** Non-staple ingredient names -> category for a recipe. */
export function shoppable(recipe) {
  const m = new Map();
  for (const i of recipe.ingredients || []) if (!i.staple && i.name) m.set(i.name, i.category);
  return m;
}

export function sharedIngredients(a, b) {
  const A = shoppable(a); const B = shoppable(b);
  const shared = [];
  for (const [name, cat] of A) if (B.has(name)) shared.push({ name, category: cat });
  const weight = shared.reduce((s, x) => s + ingWeight(x.name, x.category), 0);
  return { shared, weight };
}

// ---------- shopping list ----------
export function buildShoppingList(planItems, recipesById, checks = new Set(), manual = []) {
  const byName = new Map();
  for (const item of planItems) {
    const r = recipesById.get(item.recipeId);
    if (!r) continue;
    const factor = item.servings && r.servings ? item.servings / r.servings : 1;
    for (const ing of r.ingredients || []) {
      if (!ing.name) continue;
      if (!byName.has(ing.name)) {
        byName.set(ing.name, { key: ing.name, name: ing.name, category: ing.category || 'Other', staple: ing.staple, amounts: [], meals: [] });
      }
      const e = byName.get(ing.name);
      e.amounts.push({ qty: ing.qty == null ? null : ing.qty * factor, unit: ing.unit });
      if (!e.meals.includes(r.title)) e.meals.push(r.title);
      e.staple = e.staple && ing.staple;
    }
  }
  const items = [...byName.values()].map((e) => {
    const { parts, unspecified } = combineAmounts(e.amounts);
    const amount = parts.map(formatAmount).filter(Boolean).join(' + ');
    return {
      key: e.key, name: e.name, category: e.category, staple: e.staple,
      amount: amount + (unspecified && amount ? ' + some' : ''),
      meals: e.meals, shared: e.meals.length > 1, checked: checks.has(e.key),
    };
  });
  const groups = [];
  for (const cat of CATEGORY_ORDER) {
    const list = items.filter((i) => !i.staple && i.category === cat).sort((a, b) => a.name.localeCompare(b.name));
    const extra = manual.filter((m) => (m.category || 'Other') === cat);
    if (list.length || extra.length) groups.push({ category: cat, items: list, manual: extra });
  }
  const unknownCats = manual.filter((m) => !CATEGORY_ORDER.includes(m.category || 'Other'));
  if (unknownCats.length) groups.push({ category: 'Other', items: [], manual: unknownCats });
  const pantry = items.filter((i) => i.staple).sort((a, b) => a.name.localeCompare(b.name));
  const total = items.filter((i) => !i.staple).length + manual.length;
  const done = items.filter((i) => !i.staple && i.checked).length + manual.filter((m) => m.checked).length;
  return { groups, pantry, total, done };
}

// ---------- batching ----------
/** Groups planned recipes that share ingredients, with prep-together tips. */
export function batchGroups(planRecipes, { maxSize = 3 } = {}) {
  const unique = [...new Map(planRecipes.map((r) => [r.id, r])).values()];
  const linked = (a, b) => { const s = sharedIngredients(a, b); return s.weight >= 1.5 || (s.shared.length >= 2 && s.weight >= 1) ? s.weight : 0; };
  // Strongest pairs first; a recipe joins a group only if it shares enough with every member,
  // so groups stay small and genuinely overlapping instead of chaining the whole week together.
  const pairs = [];
  for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
    const w = linked(unique[i], unique[j]);
    if (w) pairs.push([w, unique[i], unique[j]]);
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const groupOf = new Map(); const clusters = [];
  for (const [, a, b] of pairs) {
    const ga = groupOf.get(a.id); const gb = groupOf.get(b.id);
    if (!ga && !gb) { const g = [a, b]; clusters.push(g); groupOf.set(a.id, g); groupOf.set(b.id, g); }
    else if (ga && !gb && ga.length < maxSize && ga.every((m) => linked(m, b))) { ga.push(b); groupOf.set(b.id, ga); }
    else if (gb && !ga && gb.length < maxSize && gb.every((m) => linked(m, a))) { gb.push(a); groupOf.set(a.id, gb); }
  }
  const groups = [];
  for (const members of clusters) {
    const counts = new Map();
    for (const r of members) for (const [name, cat] of shoppable(r)) {
      if (!counts.has(name)) counts.set(name, { name, category: cat, recipes: [] });
      counts.get(name).recipes.push(r.title);
    }
    const shared = [...counts.values()].filter((c) => c.recipes.length > 1)
      .sort((a, b) => b.recipes.length - a.recipes.length || (CATEGORY_WEIGHT[b.category] ?? 0) - (CATEGORY_WEIGHT[a.category] ?? 0));
    groups.push({
      recipes: members.map((r) => ({ id: r.id, title: r.title })),
      shared,
      tips: prepTips(members, shared),
    });
  }
  return groups.sort((a, b) => b.shared.length - a.shared.length);
}


function prepTips(members, shared) {
  const tips = [];
  const chop = shared.filter((s) => s.category === 'Produce').slice(0, 4).map((s) => s.name);
  if (chop.length) tips.push(`Prep once: wash & chop ${listJoin(chop)} for all ${members.length} meals in one go.`);
  const protein = shared.find((s) => s.category === 'Meat & Seafood');
  if (protein) tips.push(`Buy ${protein.name} in one larger pack and cook it together, or split it on day one.`);
  const grains = shared.filter((s) => /rice|quinoa|pasta|noodle|couscous|farro/.test(s.name)).map((s) => s.name);
  if (grains.length) tips.push(`Cook a double batch of ${listJoin(grains)} and reuse it.`);
  return tips;
}

function listJoin(arr) {
  if (arr.length <= 1) return arr.join('');
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}

/** Recipes not in the plan that reuse what the plan already needs to buy. */
export function complementarySuggestions(planRecipes, allRecipes, limit = 6) {
  if (!planRecipes.length) return [];
  const inPlan = new Set(planRecipes.map((r) => r.id));
  const planIngs = new Map();
  for (const r of planRecipes) for (const [name, cat] of shoppable(r)) planIngs.set(name, cat);
  const out = [];
  for (const r of allRecipes) {
    if (inPlan.has(r.id)) continue;
    const mine = shoppable(r);
    const shared = [];
    let weight = 0; let newItems = 0;
    for (const [name, cat] of mine) {
      if (planIngs.has(name)) { shared.push(name); weight += ingWeight(name, cat); } else newItems++;
    }
    if (!shared.length) continue;
    // Prefer recipes that need little extra shopping.
    const score = weight - newItems * 0.15;
    out.push({ id: r.id, title: r.title, health: r.health, shared, newItems, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- memory: favourites you haven't had in a while ----------
export function forgottenFavorites(recipes, { minDays = 21, today = new Date(), limit = 8 } = {}) {
  return recipes
    .filter((r) => r.favorite)
    .map((r) => ({ ...r, days: daysSince(r.lastCooked, today) }))
    .filter((r) => r.days == null || r.days >= minDays)
    .sort((a, b) => (b.days ?? 10000) - (a.days ?? 10000))
    .slice(0, limit)
    .map((r) => ({ id: r.id, title: r.title, health: r.health, lastCooked: r.lastCooked, days: r.days, timesCooked: r.timesCooked }));
}

// ---------- suggestions ----------
export const HEALTH_GOALS = {
  light: { label: 'Light week', min: 4, ideal: 4.5 },
  balanced: { label: 'Balanced', min: 3, ideal: 3.5 },
  comfort: { label: 'Comfort food', min: 1, ideal: 2 },
  any: { label: 'Anything goes', min: 1, ideal: null },
};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Pick `count` recipes balancing: health goal, favourites you haven't had in a while,
 * shared ingredients with the rest of the week, and not repeating recent meals.
 */
export function suggestMeals(allRecipes, {
  count = 5, goal = 'balanced', seedRecipeIds = [], avoidRecentDays = 10, favoritesWeight = 1,
  today = new Date(), seed = Date.now(), excludeIds = [], course = 'main', season = null, occasion = null,
} = {}) {
  const g = HEALTH_GOALS[goal] || HEALTH_GOALS.balanced;
  const random = rng(seed);
  const byId = new Map(allRecipes.map((r) => [r.id, r]));
  const selected = seedRecipeIds.map((id) => byId.get(id)).filter(Boolean);
  const exclude = new Set([...seedRecipeIds, ...excludeIds]);
  const metaOf = new Map(allRecipes.map((r) => [r.id, effectiveMeta(r)]));
  let pool = allRecipes.filter((r) => !exclude.has(r.id) && (r.ingredients?.length || 0) > 0);
  // Course is a hard filter (don't suggest a dessert as dinner); season and night type are soft (relaxed if too few).
  if (course) pool = pool.filter((r) => metaOf.get(r.id).course === course);
  const inSeason = pool.filter((r) => fitsSeason(metaOf.get(r.id), season));
  if (season && inSeason.length >= count) pool = inSeason;
  const rightNight = pool.filter((r) => fitsOccasion(metaOf.get(r.id), occasion));
  if (occasion && rightNight.length >= count) pool = rightNight;
  const notRecent = pool.filter((r) => { const d = daysSince(r.lastCooked, today); return d == null || d >= avoidRecentDays; });
  if (notRecent.length >= count) pool = notRecent;
  const healthy = pool.filter((r) => r.health >= g.min && (goal !== 'comfort' || r.health <= 3));
  if (healthy.length >= count) pool = healthy;

  const picks = [];
  const why = new Map();
  while (picks.length < count && pool.length) {
    let best = null;
    for (const r of pool) {
      const reasons = [];
      let score = random() * 0.6;
      if (g.ideal != null) score += 1.5 - Math.abs(r.health - g.ideal) * 0.6;
      const d = daysSince(r.lastCooked, today);
      if (r.favorite) {
        const overdue = d == null ? 1.5 : Math.min(d / 30, 2);
        score += (0.8 + overdue) * favoritesWeight;
        reasons.push(d == null ? 'Favourite — not cooked yet' : d >= 21 ? `Favourite — last had ${d} days ago` : 'Favourite');
      } else if (d == null) {
        score += 0.3;
      } else {
        score += Math.min(d / 90, 0.5);
      }
      let overlapW = 0; const sharedNames = new Set();
      for (const s of [...selected, ...picks]) {
        const sh = sharedIngredients(r, s);
        overlapW += sh.weight;
        sh.shared.forEach((x) => { if (x.category !== 'Spices & Seasonings') sharedNames.add(x.name); });
      }
      score += Math.min(overlapW, 4) * 0.5;
      if (sharedNames.size) reasons.push(`Shares ${[...sharedNames].slice(0, 3).join(', ')}`);
      if (g.ideal != null && r.health >= 4 && goal === 'light') reasons.push(HEALTH_LEVELS[r.health]);
      const m = metaOf.get(r.id);
      if (season && m.seasons.includes(season)) { score += 0.6; reasons.push(`Great in ${SEASON_LABELS[season].split(' ')[1].toLowerCase()}`); }
      if (occasion && m.occasions.includes(occasion)) { score += 0.4; reasons.push(OCCASION_LABELS[occasion].split(' ')[1]); }
      if (!best || score > best.score) best = { recipe: r, score, reasons };
    }
    picks.push(best.recipe);
    why.set(best.recipe.id, best.reasons);
    pool = pool.filter((r) => r.id !== best.recipe.id);
  }
  return picks.map((r) => ({
    id: r.id, title: r.title, health: r.health, favorite: r.favorite, lastCooked: r.lastCooked, reasons: why.get(r.id),
  }));
}

/**
 * Sides that go with the planned mains: share ingredients you're already buying, balance healthiness
 * (lighter sides next to rich mains), suit the season, and favourites first.
 */
export function suggestSides(planRecipes, allRecipes, { season = null, limit = 5 } = {}) {
  const mains = planRecipes.filter((r) => effectiveMeta(r).course === 'main');
  if (!mains.length) return [];
  const inPlan = new Set(planRecipes.map((r) => r.id));
  const avgHealth = mains.reduce((s, r) => s + r.health, 0) / mains.length;
  const out = [];
  for (const r of allRecipes) {
    if (inPlan.has(r.id)) continue;
    const m = effectiveMeta(r);
    if (m.course !== 'side' || !(r.ingredients?.length)) continue;
    const reasons = []; let score = 0;
    let bestShare = { weight: 0, shared: [], with: null };
    for (const main of mains) {
      const s = sharedIngredients(r, main);
      if (s.weight > bestShare.weight) bestShare = { ...s, with: main.title };
    }
    if (bestShare.weight > 0) { score += Math.min(bestShare.weight, 3); reasons.push(`Uses ${bestShare.shared.slice(0, 2).map((x) => x.name).join(' & ')} (also in ${bestShare.with})`); }
    if (avgHealth <= 3 && r.health >= 4) { score += 1.2; reasons.push('Lightens up the week'); }
    else score += (r.health - 3) * 0.2;
    if (season && m.seasons.includes(season)) { score += 0.6; reasons.push('In season'); }
    if (season && !fitsSeason(m, season)) score -= 1;
    if (r.favorite) { score += 0.8; reasons.push('Favourite'); }
    out.push({ id: r.id, title: r.title, health: r.health, favorite: r.favorite, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export { PERISHABLE };
