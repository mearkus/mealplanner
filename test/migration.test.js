import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('a single-family (v1) database is claimed by the first family created', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meals-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE recipes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, servings INTEGER DEFAULT 4, prep_minutes INTEGER,
      instructions TEXT DEFAULT '', notes TEXT DEFAULT '', tags TEXT DEFAULT '[]', health INTEGER DEFAULT 3, health_source TEXT DEFAULT 'auto',
      favorite INTEGER DEFAULT 0, source TEXT DEFAULT 'manual', source_path TEXT, source_rev TEXT, created_at TEXT, updated_at TEXT);
    CREATE UNIQUE INDEX recipes_source_path ON recipes(source_path) WHERE source_path IS NOT NULL;
    CREATE TABLE ingredients (id INTEGER PRIMARY KEY, recipe_id INTEGER, position INTEGER, raw TEXT, qty REAL, unit TEXT, name TEXT, note TEXT, category TEXT, staple INTEGER);
    CREATE TABLE plan_items (id INTEGER PRIMARY KEY, recipe_id INTEGER, planned_for TEXT, servings INTEGER, added_at TEXT);
    CREATE TABLE cook_log (id INTEGER PRIMARY KEY, recipe_id INTEGER, cooked_on TEXT NOT NULL);
    CREATE TABLE shopping_checks (key TEXT PRIMARY KEY, checked_at TEXT);
    CREATE TABLE shopping_manual (id INTEGER PRIMARY KEY, label TEXT, category TEXT, checked INTEGER DEFAULT 0, added_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO recipes (id, title, favorite, source_path) VALUES (1, 'Old Chili', 1, 'dropbox:/recipes/chili.txt');
    INSERT INTO ingredients (recipe_id, position, raw, name, category) VALUES (1, 0, '1 lb ground beef', 'ground beef', 'Meat & Seafood');
    INSERT INTO cook_log (recipe_id, cooked_on) VALUES (1, '2026-01-01');
    INSERT INTO settings (key, value) VALUES ('dropbox_folder', '"/Old Folder"');
  `);
  old.close();

  const db = await import('../server/db.js');
  db.openDb(file);
  const uid = db.createUser({ email: 'a@example.com', name: 'A', passwordHash: 'scrypt$x$y' });
  const hid = db.createHousehold('Fam', uid);
  const recipes = db.listRecipes(hid);
  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].title, 'Old Chili');
  assert.equal(recipes[0].timesCooked, 1);
  assert.equal(db.getFamilySetting(hid, 'dropbox_folder'), '/Old Folder');
  assert.ok(db.findBySourcePath(hid, 'dropbox:/recipes/chili.txt'));
  // A second family starts empty.
  const uid2 = db.createUser({ email: 'b@example.com', name: 'B', passwordHash: 'scrypt$x$y' });
  assert.equal(db.listRecipes(db.createHousehold('Other', uid2)).length, 0);
});
