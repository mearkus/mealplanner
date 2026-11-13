// SQLite storage. Everything a family shares is scoped by household_id ("hid").
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { parseIngredientLine, categorize, isStaple, normalizeName } from './ingredients.js';
import { scoreHealth } from './health.js';

let db;
const SCHEMA_VERSION = 2;
const SCOPED_TABLES = ['recipes', 'plan_items', 'cook_log', 'shopping_manual'];

function columns(d, table) {
  return d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

export function openDb(file = process.env.DB_PATH || path.resolve('data/mealplanner.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d) {
  const version = d.prepare('PRAGMA user_version').get().user_version;
  // Upgrade a single-family (v1) database in place: add household_id columns; data stays
  // unowned (NULL) until the first family is created, which then claims it.
  if (version < 2) {
    for (const t of SCOPED_TABLES) {
      const exists = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (exists && !columns(d, t).includes('household_id')) d.exec(`ALTER TABLE ${t} ADD COLUMN household_id INTEGER`);
    }
    const pi = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plan_items'").get();
    if (pi && !columns(d, 'plan_items').includes('added_by')) d.exec('ALTER TABLE plan_items ADD COLUMN added_by INTEGER');
    const cl = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cook_log'").get();
    if (cl && !columns(d, 'cook_log').includes('user_id')) d.exec('ALTER TABLE cook_log ADD COLUMN user_id INTEGER');
    const sm = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shopping_manual'").get();
    if (sm && !columns(d, 'shopping_manual').includes('added_by')) d.exec('ALTER TABLE shopping_manual ADD COLUMN added_by INTEGER');
    // v1 ticks were global; they are cheap to lose.
    const sc = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shopping_checks'").get();
    if (sc && !columns(d, 'shopping_checks').includes('household_id')) d.exec('DROP TABLE shopping_checks');
    d.exec('DROP INDEX IF EXISTS recipes_source_path');
  }

  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
      role TEXT DEFAULT 'member',
      token_version INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS household_settings (
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (household_id, key)
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id INTEGER PRIMARY KEY,
      household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
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
    CREATE INDEX IF NOT EXISTS recipes_household ON recipes(household_id);
    CREATE UNIQUE INDEX IF NOT EXISTS recipes_hh_source_path ON recipes(household_id, source_path) WHERE source_path IS NOT NULL;
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
      household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      planned_for TEXT,
      servings INTEGER,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cook_log (
      id INTEGER PRIMARY KEY,
      household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      cooked_on TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cook_log_recipe ON cook_log(recipe_id);
    CREATE TABLE IF NOT EXISTS shopping_checks (
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      checked_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (household_id, key)
    );
    CREATE TABLE IF NOT EXISTS shopping_manual (
      id INTEGER PRIMARY KEY,
      household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      category TEXT DEFAULT 'Other',
      checked INTEGER DEFAULT 0,
      added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      added_at TEXT DEFAULT (datetime('now'))
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
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

// ---------- server-wide settings ----------
export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(key, value) {
  getDb().prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------- per-family settings (Dropbox connection, folder, ...) ----------
export function getFamilySetting(hid, key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM household_settings WHERE household_id = ? AND key = ?').get(hid, key);
  return row && row.value != null ? JSON.parse(row.value) : fallback;
}
export function setFamilySetting(hid, key, value) {
  getDb().prepare(`INSERT INTO household_settings(household_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(household_id, key) DO UPDATE SET value = excluded.value`).run(hid, key, JSON.stringify(value));
}

// ---------- users & families ----------
const publicUser = (u) => u && ({ id: u.id, email: u.email, name: u.name, householdId: u.household_id, role: u.role, tokenVersion: u.token_version });

export function createUser({ email, name, passwordHash }) {
  const res = getDb().prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email.trim(), name.trim(), passwordHash);
  return Number(res.lastInsertRowid);
}
export function getUser(id) { return publicUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(id)); }
export function getUserAuthByEmail(email) { return getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim()); }
export function getUserAuth(id) { return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id); }
export function countUsers() { return getDb().prepare('SELECT count(*) AS n FROM users').get().n; }
export function updateUserName(id, name) { getDb().prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), id); }
export function setPassword(id, passwordHash) {
  getDb().prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(passwordHash, id);
}
export function bumpTokenVersion(id) { getDb().prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id); }

export function createHousehold(name, ownerId) {
  return tx((d) => {
    const isFirst = d.prepare('SELECT count(*) AS n FROM households').get().n === 0;
    const hid = Number(d.prepare('INSERT INTO households (name) VALUES (?)').run(name.trim() || 'Our family').lastInsertRowid);
    d.prepare("UPDATE users SET household_id = ?, role = 'owner' WHERE id = ?").run(hid, ownerId);
    if (isFirst) claimOrphans(d, hid);
    return hid;
  });
}

// Data from before families existed belongs to the first family created.
function claimOrphans(d, hid) {
  for (const t of SCOPED_TABLES) d.prepare(`UPDATE ${t} SET household_id = ? WHERE household_id IS NULL`).run(hid);
  const old = d.prepare("SELECT key, value FROM settings WHERE key LIKE 'dropbox_%'").all();
  for (const { key, value } of old) {
    d.prepare('INSERT OR REPLACE INTO household_settings (household_id, key, value) VALUES (?, ?, ?)').run(hid, key, value);
  }
  d.exec("DELETE FROM settings WHERE key LIKE 'dropbox_%'");
}

export function getHousehold(hid) {
  const h = getDb().prepare('SELECT * FROM households WHERE id = ?').get(hid);
  if (!h) return null;
  const members = getDb().prepare('SELECT id, name, email, role, created_at FROM users WHERE household_id = ? ORDER BY created_at').all(hid)
    .map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joinedAt: m.created_at }));
  return { id: h.id, name: h.name, members };
}
export function renameHousehold(hid, name) { getDb().prepare('UPDATE households SET name = ? WHERE id = ?').run(name.trim(), hid); }
export function listHouseholdIds() { return getDb().prepare('SELECT id FROM households').all().map((r) => r.id); }

export function joinHousehold(userId, hid) {
  getDb().prepare("UPDATE users SET household_id = ?, role = 'member' WHERE id = ?").run(hid, userId);
}

/** Remove a user from their family. If they were the owner, the longest-standing member takes over. */
export function leaveHousehold(userId) {
  return tx((d) => {
    const u = d.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u?.household_id) return;
    d.prepare("UPDATE users SET household_id = NULL, role = 'member', token_version = token_version + 1 WHERE id = ?").run(userId);
    if (u.role === 'owner') {
      const next = d.prepare('SELECT id FROM users WHERE household_id = ? ORDER BY created_at LIMIT 1').get(u.household_id);
      if (next) d.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(next.id);
    }
  });
}

export function createInvite(hid, userId, code, days = 7) {
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  getDb().prepare('INSERT INTO invites (code, household_id, created_by, expires_at) VALUES (?, ?, ?, ?)').run(code, hid, userId, expires);
  return { code, expiresAt: expires };
}
export function getInvite(code) {
  const row = getDb().prepare(`SELECT i.*, h.name AS family_name, u.name AS invited_by FROM invites i
    JOIN households h ON h.id = i.household_id LEFT JOIN users u ON u.id = i.created_by WHERE i.code = ?`).get(String(code).trim());
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return { code: row.code, householdId: row.household_id, familyName: row.family_name, invitedBy: row.invited_by, expiresAt: row.expires_at };
}
export function listInvites(hid) {
  return getDb().prepare(`SELECT i.code, i.expires_at, u.name AS created_by FROM invites i LEFT JOIN users u ON u.id = i.created_by
    WHERE i.household_id = ? AND i.expires_at > ? ORDER BY i.created_at DESC`).all(hid, new Date().toISOString())
    .map((r) => ({ code: r.code, expiresAt: r.expires_at, createdBy: r.created_by }));
}
export function deleteInvite(hid, code) { getDb().prepare('DELETE FROM invites WHERE household_id = ? AND code = ?').run(hid, code); }

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

export function listRecipes(hid, { withIngredients = true } = {}) {
  const d = getDb();
  const rows = d.prepare(`${RECIPE_SELECT} WHERE r.household_id = ? ORDER BY r.title COLLATE NOCASE`).all(hid);
  if (!withIngredients) return rows.map((r) => rowToRecipe(r));
  const ings = d.prepare(`SELECT i.* FROM ingredients i JOIN recipes r ON r.id = i.recipe_id
    WHERE r.household_id = ? ORDER BY i.recipe_id, i.position`).all(hid);
  const byRecipe = new Map();
  for (const i of ings) {
    if (!byRecipe.has(i.recipe_id)) byRecipe.set(i.recipe_id, []);
    byRecipe.get(i.recipe_id).push(i);
  }
  return rows.map((r) => rowToRecipe(r, byRecipe.get(r.id) || []));
}

export function getRecipe(hid, id) {
  const d = getDb();
  const r = d.prepare(`${RECIPE_SELECT} WHERE r.id = ? AND r.household_id = ?`).get(id, hid);
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

export function saveRecipe(hid, input, id = null) {
  return tx((d) => {
    const ingredients = normalizeIngredients(input.ingredients);
    const existing = id ? d.prepare('SELECT * FROM recipes WHERE id = ? AND household_id = ?').get(id, hid) : null;
    if (id && !existing) throw Object.assign(new Error('Recipe not found'), { status: 404 });
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
      const res = d.prepare(`INSERT INTO recipes (household_id, title, servings, prep_minutes, instructions, notes, tags, health,
        health_source, favorite, source, source_path, source_rev) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(hid, ...Object.values(fields));
      recipeId = Number(res.lastInsertRowid);
    }
    if (input.ingredients) writeIngredients(d, recipeId, ingredients);
    return recipeId;
  });
}

export function patchRecipe(hid, id, patch) {
  const d = getDb();
  if (patch.favorite != null) d.prepare('UPDATE recipes SET favorite = ? WHERE id = ? AND household_id = ?').run(patch.favorite ? 1 : 0, id, hid);
  if (patch.health != null) d.prepare("UPDATE recipes SET health = ?, health_source = 'manual' WHERE id = ? AND household_id = ?").run(Number(patch.health), id, hid);
}

export function deleteRecipe(hid, id) {
  getDb().prepare('DELETE FROM recipes WHERE id = ? AND household_id = ?').run(id, hid);
}

export function findBySourcePath(hid, p) {
  return getDb().prepare('SELECT id, source_rev FROM recipes WHERE household_id = ? AND source_path = ?').get(hid, p);
}

function ownsRecipe(hid, recipeId) {
  return !!getDb().prepare('SELECT 1 FROM recipes WHERE id = ? AND household_id = ?').get(recipeId, hid);
}

// ---------- plan ----------
export function listPlan(hid) {
  return getDb().prepare(`SELECT p.*, u.name AS added_by_name FROM plan_items p LEFT JOIN users u ON u.id = p.added_by
    WHERE p.household_id = ? ORDER BY p.planned_for IS NULL, p.planned_for, p.added_at`).all(hid)
    .map((p) => ({ id: p.id, recipeId: p.recipe_id, plannedFor: p.planned_for, servings: p.servings, addedBy: p.added_by_name }));
}
export function addToPlan(hid, recipeId, { plannedFor = null, servings = null, userId = null } = {}) {
  if (!ownsRecipe(hid, recipeId)) throw Object.assign(new Error('Recipe not found'), { status: 404 });
  const res = getDb().prepare('INSERT INTO plan_items (household_id, recipe_id, planned_for, servings, added_by) VALUES (?, ?, ?, ?, ?)')
    .run(hid, recipeId, plannedFor || null, servings ? Number(servings) : null, userId);
  return Number(res.lastInsertRowid);
}
export function updatePlanItem(hid, id, { plannedFor, servings }) {
  const d = getDb();
  if (plannedFor !== undefined) d.prepare('UPDATE plan_items SET planned_for = ? WHERE id = ? AND household_id = ?').run(plannedFor || null, id, hid);
  if (servings !== undefined) d.prepare('UPDATE plan_items SET servings = ? WHERE id = ? AND household_id = ?').run(servings ? Number(servings) : null, id, hid);
}
export function removePlanItem(hid, id) {
  getDb().prepare('DELETE FROM plan_items WHERE id = ? AND household_id = ?').run(id, hid);
}
export function clearPlan(hid) {
  tx((d) => {
    d.prepare('DELETE FROM plan_items WHERE household_id = ?').run(hid);
    d.prepare('DELETE FROM shopping_checks WHERE household_id = ?').run(hid);
    d.prepare('DELETE FROM shopping_manual WHERE household_id = ? AND checked = 1').run(hid);
  });
}

// ---------- cooking history ----------
export function logCooked(hid, recipeId, { date, userId = null } = {}) {
  if (!ownsRecipe(hid, recipeId)) throw Object.assign(new Error('Recipe not found'), { status: 404 });
  getDb().prepare('INSERT INTO cook_log (household_id, recipe_id, user_id, cooked_on) VALUES (?, ?, ?, ?)')
    .run(hid, recipeId, userId, date || new Date().toISOString().slice(0, 10));
}
export function cookHistory(hid, limit = 60) {
  return getDb().prepare(`SELECT c.id, c.recipe_id AS recipeId, c.cooked_on AS cookedOn, r.title, u.name AS cookedBy
    FROM cook_log c JOIN recipes r ON r.id = c.recipe_id LEFT JOIN users u ON u.id = c.user_id
    WHERE c.household_id = ? ORDER BY c.cooked_on DESC, c.id DESC LIMIT ?`).all(hid, limit);
}
export function deleteCookEntry(hid, id) {
  getDb().prepare('DELETE FROM cook_log WHERE id = ? AND household_id = ?').run(id, hid);
}

// ---------- shopping state ----------
export function getChecks(hid) {
  return new Set(getDb().prepare('SELECT key FROM shopping_checks WHERE household_id = ?').all(hid).map((r) => r.key));
}
export function setCheck(hid, key, checked) {
  const d = getDb();
  if (checked) d.prepare('INSERT OR IGNORE INTO shopping_checks (household_id, key) VALUES (?, ?)').run(hid, key);
  else d.prepare('DELETE FROM shopping_checks WHERE household_id = ? AND key = ?').run(hid, key);
}
export function listManual(hid) {
  return getDb().prepare(`SELECT m.*, u.name AS added_by_name FROM shopping_manual m LEFT JOIN users u ON u.id = m.added_by
    WHERE m.household_id = ? ORDER BY m.added_at`).all(hid)
    .map((m) => ({ id: m.id, label: m.label, category: m.category, checked: !!m.checked, addedBy: m.added_by_name }));
}
export function addManual(hid, label, category, userId = null) {
  const res = getDb().prepare('INSERT INTO shopping_manual (household_id, label, category, added_by) VALUES (?, ?, ?, ?)').run(hid, label, category, userId);
  return Number(res.lastInsertRowid);
}
export function updateManual(hid, id, { checked }) {
  getDb().prepare('UPDATE shopping_manual SET checked = ? WHERE id = ? AND household_id = ?').run(checked ? 1 : 0, id, hid);
}
export function deleteManual(hid, id) {
  getDb().prepare('DELETE FROM shopping_manual WHERE id = ? AND household_id = ?').run(id, hid);
}
export function clearCheckedManual(hid) {
  getDb().prepare('DELETE FROM shopping_manual WHERE household_id = ? AND checked = 1').run(hid);
}
