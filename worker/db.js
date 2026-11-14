// D1 data access. Every function that touches family data takes the family id (hid) and filters by it,
// so one family can never read or change another's rows.
import { parseIngredientLine, categorize, isStaple, normalizeName } from '../public/lib/ingredients.js';
import { scoreHealth } from '../public/lib/health.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

const all = async (stmt) => (await stmt.all()).results;

// ---------- settings ----------
export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
export async function setSetting(db, key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value)).run();
}
export async function getFamilySetting(db, hid, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM household_settings WHERE household_id = ? AND key = ?').bind(hid, key).first();
  return row && row.value != null ? JSON.parse(row.value) : fallback;
}
export async function getFamilySettings(db, hid, keys) {
  const rows = await all(db.prepare(`SELECT key, value FROM household_settings WHERE household_id = ? AND key IN (${keys.map(() => '?').join(',')})`).bind(hid, ...keys));
  return Object.fromEntries(rows.map((r) => [r.key, r.value == null ? null : JSON.parse(r.value)]));
}
const setFamilySettingStmt = (db, hid, key, value) => db.prepare(`INSERT INTO household_settings (household_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(household_id, key) DO UPDATE SET value = excluded.value`).bind(hid, key, JSON.stringify(value));
export async function setFamilySetting(db, hid, key, value) {
  await setFamilySettingStmt(db, hid, key, value).run();
}
const bumpRecipesVersionStmt = (db, hid) => setFamilySettingStmt(db, hid, 'recipes_version', Date.now());

// ---------- users & families ----------
const toUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, householdId: u.household_id, role: u.role, tokenVersion: u.token_version });

export async function getUser(db, id) {
  return toUser(await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first());
}
export async function getUserBySub(db, sub) {
  return toUser(await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first());
}
export async function getUserByEmail(db, email) {
  return toUser(await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first());
}
export async function countUsers(db) {
  return (await db.prepare('SELECT count(*) AS n FROM users').first()).n;
}
export async function createUser(db, { sub, email, name }) {
  const row = await db.prepare('INSERT INTO users (google_sub, email, name) VALUES (?, ?, ?) RETURNING id').bind(sub, email, name).first();
  return row.id;
}
export async function updateUserName(db, id, name) {
  await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, id).run();
}
export async function bumpTokenVersion(db, id) {
  await db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').bind(id).run();
}

export async function createHousehold(db, name, ownerId) {
  const row = await db.prepare('INSERT INTO households (name) VALUES (?) RETURNING id').bind(name || 'Our family').first();
  await db.prepare("UPDATE users SET household_id = ?, role = 'owner' WHERE id = ?").bind(row.id, ownerId).run();
  return row.id;
}
export async function getHousehold(db, hid) {
  const h = await db.prepare('SELECT * FROM households WHERE id = ?').bind(hid).first();
  if (!h) return null;
  const members = await all(db.prepare('SELECT id, name, email, role, created_at FROM users WHERE household_id = ? ORDER BY created_at, id').bind(hid));
  return { id: h.id, name: h.name, members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joinedAt: m.created_at })) };
}
export async function renameHousehold(db, hid, name) {
  await db.prepare('UPDATE households SET name = ? WHERE id = ?').bind(name, hid).run();
}
export async function joinHousehold(db, userId, hid) {
  await db.prepare("UPDATE users SET household_id = ?, role = 'member' WHERE id = ?").bind(hid, userId).run();
}
/** Remove someone from their family (and log them out). If they owned it, the longest-standing member takes over. */
export async function leaveHousehold(db, userId) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  if (!u?.household_id) return;
  await db.prepare("UPDATE users SET household_id = NULL, role = 'member', token_version = token_version + 1 WHERE id = ?").bind(userId).run();
  if (u.role === 'owner') {
    await db.prepare(`UPDATE users SET role = 'owner' WHERE id = (SELECT id FROM users WHERE household_id = ? ORDER BY created_at, id LIMIT 1)`)
      .bind(u.household_id).run();
  }
}

export async function createInvite(db, hid, userId, code, days = 7) {
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  await db.prepare('INSERT INTO invites (code, household_id, created_by, expires_at) VALUES (?, ?, ?, ?)').bind(code, hid, userId, expiresAt).run();
  return { code, expiresAt };
}
export async function getInvite(db, code) {
  const r = await db.prepare(`SELECT i.*, h.name AS family_name, u.name AS invited_by FROM invites i
    JOIN households h ON h.id = i.household_id LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ?`).bind(String(code).trim().toUpperCase()).first();
  if (!r || r.expires_at < new Date().toISOString()) return null;
  return { code: r.code, householdId: r.household_id, familyName: r.family_name, invitedBy: r.invited_by, expiresAt: r.expires_at };
}
export async function listInvites(db, hid) {
  const rows = await all(db.prepare(`SELECT i.code, i.expires_at, u.name AS created_by FROM invites i LEFT JOIN users u ON u.id = i.created_by
    WHERE i.household_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC`).bind(hid, new Date().toISOString()));
  return rows.map((r) => ({ code: r.code, expiresAt: r.expires_at, createdBy: r.created_by }));
}
export async function deleteInvite(db, hid, code) {
  await db.prepare('DELETE FROM invites WHERE household_id = ? AND code = ?').bind(hid, code).run();
}

// ---------- recipes ----------
function toRecipe(r, ingredients = []) {
  return {
    id: r.id, title: r.title, servings: r.servings, prepMinutes: r.prep_minutes, instructions: r.instructions, notes: r.notes,
    tags: JSON.parse(r.tags || '[]'), health: r.health, healthSource: r.health_source, favorite: !!r.favorite,
    source: r.source, sourcePath: r.source_path, updatedAt: r.updated_at,
    ingredients: ingredients.map((i) => ({ raw: i.raw, qty: i.qty, unit: i.unit, name: i.name, note: i.note, category: i.category, staple: !!i.staple })),
  };
}

export async function listRecipes(db, hid) {
  const [rows, ings] = await Promise.all([
    all(db.prepare('SELECT * FROM recipes WHERE household_id = ? ORDER BY title COLLATE NOCASE').bind(hid)),
    all(db.prepare('SELECT * FROM ingredients WHERE household_id = ? ORDER BY recipe_id, position').bind(hid)),
  ]);
  const by = new Map();
  for (const i of ings) { if (!by.has(i.recipe_id)) by.set(i.recipe_id, []); by.get(i.recipe_id).push(i); }
  return rows.map((r) => toRecipe(r, by.get(r.id)));
}

export async function getRecipe(db, hid, id) {
  const r = await db.prepare('SELECT * FROM recipes WHERE id = ? AND household_id = ?').bind(id, hid).first();
  if (!r) return null;
  const ings = await all(db.prepare('SELECT * FROM ingredients WHERE recipe_id = ? AND household_id = ? ORDER BY position').bind(id, hid));
  return toRecipe(r, ings);
}

/** Accepts ingredients as raw strings or partially structured objects. */
export function normalizeIngredients(list = []) {
  return list.slice(0, 200).map((ing) => {
    if (typeof ing === 'string') return parseIngredientLine(ing.slice(0, 300));
    if (!ing) return null;
    const parsedFromRaw = ing.raw ? parseIngredientLine(String(ing.raw).slice(0, 300)) : null;
    const name = ing.name ? normalizeName(String(ing.name)) : parsedFromRaw?.name;
    if (!name) return null;
    const qty = ing.qty === '' || ing.qty == null ? (parsedFromRaw?.qty ?? null) : Number(ing.qty);
    return {
      raw: String(ing.raw || [ing.qty, ing.unit, ing.name].filter((x) => x != null && x !== '').join(' ')).slice(0, 300),
      qty: Number.isFinite(qty) ? qty : null,
      unit: ing.unit || parsedFromRaw?.unit || null,
      name,
      note: String(ing.note || parsedFromRaw?.note || '').slice(0, 300),
      category: ing.category || categorize(name),
      staple: ing.staple ?? isStaple(name),
    };
  }).filter(Boolean);
}

const clip = (s, n) => (s == null ? s : String(s).slice(0, n));

export async function saveRecipe(db, hid, input, id = null) {
  const existing = id ? await db.prepare('SELECT * FROM recipes WHERE id = ? AND household_id = ?').bind(id, hid).first() : null;
  if (id && !existing) throw new HttpError(404, 'Recipe not found');
  const ingredients = input.ingredients ? normalizeIngredients(input.ingredients) : null;
  let health = input.health != null ? Math.max(1, Math.min(5, Math.round(Number(input.health)))) : null;
  let healthSource = input.healthSource || (health != null ? 'manual' : 'auto');
  if (health == null) {
    if (existing && existing.health_source !== 'auto') { health = existing.health; healthSource = existing.health_source; }
    else { health = scoreHealth(input.title || existing?.title, ingredients || []).score; healthSource = 'auto'; }
  }
  const f = {
    title: clip(input.title?.trim(), 200) || existing?.title || 'Untitled recipe',
    servings: Math.min(Number(input.servings) || existing?.servings || 4, 100),
    prep_minutes: input.prepMinutes != null && input.prepMinutes !== '' ? Number(input.prepMinutes) || null : (existing?.prep_minutes ?? null),
    instructions: clip(input.instructions ?? existing?.instructions ?? '', 20000),
    notes: clip(input.notes ?? existing?.notes ?? '', 5000),
    tags: JSON.stringify((input.tags ?? (existing ? JSON.parse(existing.tags) : [])).slice(0, 12).map((t) => clip(t, 40))),
    health,
    health_source: healthSource,
    favorite: input.favorite != null ? (input.favorite ? 1 : 0) : (existing?.favorite ?? 0),
    source: clip(input.source, 20) || existing?.source || 'manual',
    source_path: clip(input.sourcePath ?? existing?.source_path ?? null, 1000),
    source_rev: clip(input.sourceRev ?? existing?.source_rev ?? null, 100),
  };
  let recipeId = id;
  if (existing) {
    await db.prepare(`UPDATE recipes SET title=?, servings=?, prep_minutes=?, instructions=?, notes=?, tags=?, health=?, health_source=?,
      favorite=?, source=?, source_path=?, source_rev=?, updated_at=datetime('now') WHERE id=? AND household_id=?`)
      .bind(...Object.values(f), id, hid).run();
  } else {
    recipeId = (await db.prepare(`INSERT INTO recipes (household_id, title, servings, prep_minutes, instructions, notes, tags, health,
      health_source, favorite, source, source_path, source_rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).bind(hid, ...Object.values(f)).first()).id;
  }
  const stmts = [bumpRecipesVersionStmt(db, hid)];
  if (ingredients) {
    stmts.push(db.prepare('DELETE FROM ingredients WHERE recipe_id = ? AND household_id = ?').bind(recipeId, hid));
    ingredients.forEach((i, idx) => stmts.push(db.prepare(`INSERT INTO ingredients (recipe_id, household_id, position, raw, qty, unit, name, note, category, staple)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(recipeId, hid, idx, i.raw, i.qty, i.unit, i.name, i.note || '', i.category, i.staple ? 1 : 0)));
  }
  await db.batch(stmts); // atomic
  return recipeId;
}

export async function patchRecipe(db, hid, id, patch) {
  const stmts = [];
  if (patch.favorite != null) stmts.push(db.prepare('UPDATE recipes SET favorite = ? WHERE id = ? AND household_id = ?').bind(patch.favorite ? 1 : 0, id, hid));
  if (patch.health != null) stmts.push(db.prepare("UPDATE recipes SET health = ?, health_source = 'manual' WHERE id = ? AND household_id = ?")
    .bind(Math.max(1, Math.min(5, Math.round(Number(patch.health)))), id, hid));
  if (stmts.length) await db.batch([...stmts, bumpRecipesVersionStmt(db, hid)]);
}

export async function deleteRecipe(db, hid, id) {
  await db.batch([db.prepare('DELETE FROM recipes WHERE id = ? AND household_id = ?').bind(id, hid), bumpRecipesVersionStmt(db, hid)]);
}

export async function findBySourcePath(db, hid, p) {
  return db.prepare('SELECT id FROM recipes WHERE household_id = ? AND source_path = ?').bind(hid, p).first();
}

export async function importedPaths(db, hid) {
  const [recipes, log] = await Promise.all([
    all(db.prepare('SELECT source_path FROM recipes WHERE household_id = ? AND source_path IS NOT NULL').bind(hid)),
    all(db.prepare('SELECT source_path, status FROM import_log WHERE household_id = ?').bind(hid)),
  ]);
  const done = new Set(recipes.map((r) => r.source_path.replace(/#\d+$/, '')));
  return { done, log: new Map(log.map((l) => [l.source_path, l.status])) };
}

export async function logImport(db, hid, sourcePath, status, detail = '') {
  await db.prepare(`INSERT INTO import_log (household_id, source_path, status, detail) VALUES (?, ?, ?, ?)
    ON CONFLICT(household_id, source_path) DO UPDATE SET status = excluded.status, detail = excluded.detail, at = datetime('now')`)
    .bind(hid, clip(sourcePath, 1000), status, clip(detail, 500)).run();
}
export async function clearImportLog(db, hid) {
  await db.prepare('DELETE FROM import_log WHERE household_id = ?').bind(hid).run();
}

async function ownsRecipe(db, hid, recipeId) {
  return !!(await db.prepare('SELECT 1 AS x FROM recipes WHERE id = ? AND household_id = ?').bind(recipeId, hid).first());
}

// ---------- plan, history, shopping (the frequently-changing "live" state) ----------
export async function liveState(db, hid) {
  const [plan, cookLog, checks, manual, version] = await Promise.all([
    all(db.prepare(`SELECT p.id, p.recipe_id, p.planned_for, p.servings, u.name AS added_by FROM plan_items p
      LEFT JOIN users u ON u.id = p.added_by WHERE p.household_id = ? ORDER BY p.planned_for IS NULL, p.planned_for, p.added_at, p.id`).bind(hid)),
    all(db.prepare(`SELECT c.id, c.recipe_id, c.cooked_on, u.name AS cooked_by FROM cook_log c
      LEFT JOIN users u ON u.id = c.user_id WHERE c.household_id = ? ORDER BY c.cooked_on DESC, c.id DESC`).bind(hid)),
    all(db.prepare('SELECT key FROM shopping_checks WHERE household_id = ?').bind(hid)),
    all(db.prepare(`SELECT m.id, m.label, m.category, m.checked, u.name AS added_by FROM shopping_manual m
      LEFT JOIN users u ON u.id = m.added_by WHERE m.household_id = ? ORDER BY m.added_at, m.id`).bind(hid)),
    getFamilySetting(db, hid, 'recipes_version', 0),
  ]);
  return {
    recipesVersion: version,
    plan: plan.map((p) => ({ id: p.id, recipeId: p.recipe_id, plannedFor: p.planned_for, servings: p.servings, addedBy: p.added_by })),
    cookLog: cookLog.map((c) => ({ id: c.id, recipeId: c.recipe_id, cookedOn: c.cooked_on, cookedBy: c.cooked_by })),
    checks: checks.map((c) => c.key),
    manual: manual.map((m) => ({ id: m.id, label: m.label, category: m.category, checked: !!m.checked, addedBy: m.added_by })),
  };
}

export async function addToPlan(db, hid, recipeIds, { plannedFor = null, servings = null, userId = null } = {}) {
  const ids = [...new Set(recipeIds.map(Number))].slice(0, 30);
  for (const rid of ids) if (!(await ownsRecipe(db, hid, rid))) throw new HttpError(404, 'Recipe not found');
  await db.batch(ids.map((rid) => db.prepare('INSERT INTO plan_items (household_id, recipe_id, planned_for, servings, added_by) VALUES (?, ?, ?, ?, ?)')
    .bind(hid, rid, plannedFor || null, servings ? Number(servings) : null, userId)));
}
export async function updatePlanItem(db, hid, id, { plannedFor, servings }) {
  const stmts = [];
  if (plannedFor !== undefined) stmts.push(db.prepare('UPDATE plan_items SET planned_for = ? WHERE id = ? AND household_id = ?').bind(plannedFor || null, id, hid));
  if (servings !== undefined) stmts.push(db.prepare('UPDATE plan_items SET servings = ? WHERE id = ? AND household_id = ?').bind(servings ? Number(servings) : null, id, hid));
  if (stmts.length) await db.batch(stmts);
}
export async function removePlanItem(db, hid, id) {
  await db.prepare('DELETE FROM plan_items WHERE id = ? AND household_id = ?').bind(id, hid).run();
}
export async function clearPlan(db, hid) {
  await db.batch([
    db.prepare('DELETE FROM plan_items WHERE household_id = ?').bind(hid),
    db.prepare('DELETE FROM shopping_checks WHERE household_id = ?').bind(hid),
    db.prepare('DELETE FROM shopping_manual WHERE household_id = ? AND checked = 1').bind(hid),
  ]);
}
export async function cookPlanItem(db, hid, planId, { date, userId }) {
  const item = await db.prepare('SELECT recipe_id FROM plan_items WHERE id = ? AND household_id = ?').bind(planId, hid).first();
  if (!item) throw new HttpError(404, 'Not in plan');
  await db.batch([
    db.prepare('INSERT INTO cook_log (household_id, recipe_id, user_id, cooked_on) VALUES (?, ?, ?, ?)').bind(hid, item.recipe_id, userId, date || today()),
    db.prepare('DELETE FROM plan_items WHERE id = ? AND household_id = ?').bind(planId, hid),
  ]);
}
const today = () => new Date().toISOString().slice(0, 10);
export async function logCooked(db, hid, recipeId, { date, userId }) {
  if (!(await ownsRecipe(db, hid, recipeId))) throw new HttpError(404, 'Recipe not found');
  await db.prepare('INSERT INTO cook_log (household_id, recipe_id, user_id, cooked_on) VALUES (?, ?, ?, ?)')
    .bind(hid, recipeId, userId, /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today()).run();
}
export async function deleteCookEntry(db, hid, id) {
  await db.prepare('DELETE FROM cook_log WHERE id = ? AND household_id = ?').bind(id, hid).run();
}
export async function setCheck(db, hid, key, checked) {
  const k = clip(key, 200);
  if (checked) await db.prepare('INSERT OR IGNORE INTO shopping_checks (household_id, key) VALUES (?, ?)').bind(hid, k).run();
  else await db.prepare('DELETE FROM shopping_checks WHERE household_id = ? AND key = ?').bind(hid, k).run();
}
export async function addManual(db, hid, label, userId) {
  const l = clip(label, 200);
  await db.prepare('INSERT INTO shopping_manual (household_id, label, category, added_by) VALUES (?, ?, ?, ?)').bind(hid, l, categorize(normalizeName(l)), userId).run();
}
export async function updateManual(db, hid, id, checked) {
  await db.prepare('UPDATE shopping_manual SET checked = ? WHERE id = ? AND household_id = ?').bind(checked ? 1 : 0, id, hid).run();
}
export async function deleteManual(db, hid, id) {
  await db.prepare('DELETE FROM shopping_manual WHERE id = ? AND household_id = ?').bind(id, hid).run();
}
export async function clearCheckedManual(db, hid) {
  await db.prepare('DELETE FROM shopping_manual WHERE household_id = ? AND checked = 1').bind(hid).run();
}
