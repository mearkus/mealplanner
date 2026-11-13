import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { parseIngredientLine, categorize, isStaple, normalizeName } from './ingredients.js';
import { scoreHealth } from './health.js';

let db;

export function openDb(file = process.env.DB_PATH || path.resolve('data/mealplanner.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      servings INTEGER DEFAULT 4,
      prep_minutes INTEGER,
      instructions TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      health INTEGER DEFAULT 3,
      health_source TEXT DEFAULT 'auto',
      favorite INTEGER DEFAULT 0,
      source TEXT DEFAULT 'manual',
      source_path TEXT,
      source_rev TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS recipes_source_path ON recipes(source_path) WHERE source_path IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ingredients (
      id INTEGER PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      position INTEGER,
      raw TEXT,
      qty REAL,
      unit TEXT,
      name TEXT,
      note TEXT,
      category TEXT,
      staple INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ingredients_recipe ON ingredients(recipe_id);
    CREATE TABLE IF NOT EXISTS plan_items (
      id INTEGER PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      planned_for TEXT,
      servings INTEGER,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cook_log (
      id INTEGER PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      cooked_on TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cook_log_recipe ON cook_log(recipe_id);
    CREATE TABLE IF NOT EXISTS shopping_checks (
      key TEXT PRIMARY KEY,
      checked_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS shopping_manual (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT DEFAULT 'Other',
      checked INTEGER DEFAULT 0,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

export function getDb() {
  if (!db) openDb();
  return db;
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try { const r = fn(d); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

// ---------- settings ----------
export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  getDb().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- recipes ----------
function rowToRecipe(r, ingredients) {
  return {
    id: r.id,
    title: r.title,
    servings: r.servings,
    prepMinutes: r.prep_minutes,
    instructions: r.instructions,
    notes: r.notes,
    tags: JSON.parse(r.tags || '[]'),
    health: r.health,
    healthSource: r.health_source,
    favorite: !!r.favorite,
    source: r.source,
    sourcePath: r.source_path,
    lastCooked: r.last_cooked ?? null,
    timesCooked: r.times_cooked ?? 0,
    ingredients: ingredients?.map((i) => ({
      id: i.id, raw: i.raw, qty: i.qty, unit: i.unit, name: i.name, note: i.note,
      category: i.category, staple: !!i.staple,
    })),
  };
}

const RECIPE_SELECT = `
  SELECT r.*, (SELECT max(cooked_on) FROM cook_log c WHERE c.recipe_id = r.id) AS last_cooked,
         (SELECT count(*) FROM cook_log c WHERE c.recipe_id = r.id) AS times_cooked
  FROM recipes r`;

export function listRecipes({ withIngredients = true } = {}) {
  const d = getDb();
  const rows = d.prepare(`${RECIPE_SELECT} ORDER BY r.title COLLATE NOCASE`).all();
  if (!withIngredients) return rows.map((r) => rowToRecipe(r));
  const ings = d.prepare('SELECT * FROM ingredients ORDER BY recipe_id, position').all();
  const byRecipe = new Map();
  for (const i of ings) {
    if (!byRecipe.has(i.recipe_id)) byRecipe.set(i.recipe_id, []);
    byRecipe.get(i.recipe_id).push(i);
  }
  return rows.map((r) => rowToRecipe(r, byRecipe.get(r.id) || []));
}

export function getRecipe(id) {
  const d = getDb();
  const r = d.prepare(`${RECIPE_SELECT} WHERE r.id = ?`).get(id);
  if (!r) return null;
  const ings = d.prepare('SELECT * FROM ingredients WHERE recipe_id = ? ORDER BY position').all(id);
  return rowToRecipe(r, ings);
}

/** Accepts ingredients as raw strings or partially structured objects. */
export function normalizeIngredients(list = []) {
  return list.map((ing) => {
    if (typeof ing === 'string') return parseIngredientLine(ing);
    if (!ing) return null;
    const parsedFromRaw = ing.raw ? parseIngredientLine(ing.raw) : null;
    const name = ing.name ? normalizeName(ing.name) : parsedFromRaw?.name;
    if (!name) return null;
    return {
      raw: ing.raw || [ing.qty, ing.unit, ing.name].filter((x) => x != null && x !== '').join(' '),
      qty: ing.qty === '' || ing.qty == null ? (parsedFromRaw?.qty ?? null) : Number(ing.qty),
      unit: ing.unit || parsedFromRaw?.unit || null,
      name,
      note: ing.note || parsedFromRaw?.note || '',
      category: ing.category || categorize(name),
      staple: ing.staple ?? isStaple(name),
    };
  }).filter(Boolean);
}

function writeIngredients(d, recipeId, ingredients) {
  d.prepare('DELETE FROM ingredients WHERE recipe_id = ?').run(recipeId);
  const ins = d.prepare(`INSERT INTO ingredients (recipe_id, position, raw, qty, unit, name, note, category, staple)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ingredients.forEach((i, idx) => ins.run(recipeId, idx, i.raw, Number.isFinite(i.qty) ? i.qty : null,
    i.unit, i.name, i.note || '', i.category, i.staple ? 1 : 0));
}

export function saveRecipe(input, id = null) {
  return tx((d) => {
    const ingredients = normalizeIngredients(input.ingredients);
    const existing = id ? d.prepare('SELECT * FROM recipes WHERE id = ?').get(id) : null;
    let health = input.health != null ? Number(input.health) : null;
    let healthSource = input.healthSource || (health != null ? 'manual' : 'auto');
    if (health == null) {
      if (existing && existing.health_source !== 'auto') { health = existing.health; healthSource = existing.health_source; }
      else { health = scoreHealth(input.title, ingredients).score; healthSource = 'auto'; }
    }
    const fields = {
      title: input.title?.trim() || existing?.title || 'Untitled recipe',
      servings: Number(input.servings) || existing?.servings || 4,
      prep_minutes: input.prepMinutes != null && input.prepMinutes !== '' ? Number(input.prepMinutes) : (existing?.prep_minutes ?? null),
      instructions: input.instructions ?? existing?.instructions ?? '',
      notes: input.notes ?? existing?.notes ?? '',
      tags: JSON.stringify(input.tags ?? (existing ? JSON.parse(existing.tags) : [])),
      health,
      health_source: healthSource,
      favorite: input.favorite != null ? (input.favorite ? 1 : 0) : (existing?.favorite ?? 0),
      source: input.source || existing?.source || 'manual',
      source_path: input.sourcePath ?? existing?.source_path ?? null,
      source_rev: input.sourceRev ?? existing?.source_rev ?? null,
    };
    let recipeId = id;
    if (existing) {
      d.prepare(`UPDATE recipes SET title=?, servings=?, prep_minutes=?, instructions=?, notes=?, tags=?, health=?,
        health_source=?, favorite=?, source=?, source_path=?, source_rev=?, updated_at=datetime('now') WHERE id=?`)
        .run(...Object.values(fields), id);
    } else {
      const res = d.prepare(`INSERT INTO recipes (title, servings, prep_minutes, instructions, notes, tags, health,
        health_source, favorite, source, source_path, source_rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(fields));
      recipeId = Number(res.lastInsertRowid);
    }
    if (input.ingredients) writeIngredients(d, recipeId, ingredients);
    return recipeId;
  });
}

export function patchRecipe(id, patch) {
  const d = getDb();
  if (patch.favorite != null) d.prepare('UPDATE recipes SET favorite = ? WHERE id = ?').run(patch.favorite ? 1 : 0, id);
  if (patch.health != null) d.prepare("UPDATE recipes SET health = ?, health_source = 'manual' WHERE id = ?").run(Number(patch.health), id);
}

export function deleteRecipe(id) {
  getDb().prepare('DELETE FROM recipes WHERE id = ?').run(id);
}

export function findBySourcePath(p) {
  return getDb().prepare('SELECT id, source_rev FROM recipes WHERE source_path = ?').get(p);
}

// ---------- plan ----------
export function listPlan() {
  return getDb().prepare('SELECT * FROM plan_items ORDER BY planned_for IS NULL, planned_for, added_at').all()
    .map((p) => ({ id: p.id, recipeId: p.recipe_id, plannedFor: p.planned_for, servings: p.servings }));
}
export function addToPlan(recipeId, { plannedFor = null, servings = null } = {}) {
  const res = getDb().prepare('INSERT INTO plan_items (recipe_id, planned_for, servings) VALUES (?, ?, ?)')
    .run(recipeId, plannedFor || null, servings ? Number(servings) : null);
  return Number(res.lastInsertRowid);
}
export function updatePlanItem(id, { plannedFor, servings }) {
  const d = getDb();
  if (plannedFor !== undefined) d.prepare('UPDATE plan_items SET planned_for = ? WHERE id = ?').run(plannedFor || null, id);
  if (servings !== undefined) d.prepare('UPDATE plan_items SET servings = ? WHERE id = ?').run(servings ? Number(servings) : null, id);
}
export function removePlanItem(id) {
  getDb().prepare('DELETE FROM plan_items WHERE id = ?').run(id);
}
export function clearPlan() {
  tx((d) => { d.exec('DELETE FROM plan_items'); d.exec('DELETE FROM shopping_checks'); d.exec('DELETE FROM shopping_manual WHERE checked = 1'); });
}

// ---------- cooking history ----------
export function logCooked(recipeId, date = new Date().toISOString().slice(0, 10)) {
  getDb().prepare('INSERT INTO cook_log (recipe_id, cooked_on) VALUES (?, ?)').run(recipeId, date);
}
export function cookHistory(limit = 60) {
  return getDb().prepare(`SELECT c.id, c.recipe_id AS recipeId, c.cooked_on AS cookedOn, r.title
    FROM cook_log c JOIN recipes r ON r.id = c.recipe_id ORDER BY c.cooked_on DESC, c.id DESC LIMIT ?`).all(limit);
}
export function deleteCookEntry(id) {
  getDb().prepare('DELETE FROM cook_log WHERE id = ?').run(id);
}

// ---------- shopping state ----------
export function getChecks() {
  return new Set(getDb().prepare('SELECT key FROM shopping_checks').all().map((r) => r.key));
}
export function setCheck(key, checked) {
  const d = getDb();
  if (checked) d.prepare('INSERT OR IGNORE INTO shopping_checks (key) VALUES (?)').run(key);
  else d.prepare('DELETE FROM shopping_checks WHERE key = ?').run(key);
}
export function listManual() {
  return getDb().prepare('SELECT * FROM shopping_manual ORDER BY added_at').all()
    .map((m) => ({ id: m.id, label: m.label, category: m.category, checked: !!m.checked }));
}
export function addManual(label, category) {
  const res = getDb().prepare('INSERT INTO shopping_manual (label, category) VALUES (?, ?)').run(label, category);
  return Number(res.lastInsertRowid);
}
export function updateManual(id, { checked }) {
  getDb().prepare('UPDATE shopping_manual SET checked = ? WHERE id = ?').run(checked ? 1 : 0, id);
}
export function deleteManual(id) {
  getDb().prepare('DELETE FROM shopping_manual WHERE id = ?').run(id);
}
export function clearCheckedManual() {
  getDb().exec('DELETE FROM shopping_manual WHERE checked = 1');
}
