-- Our Meals schema (Cloudflare D1 / SQLite). Everything a family shares is scoped by household_id.

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,          -- Google's stable account id ("dev:<email>" for local testing)
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
  role TEXT DEFAULT 'member',               -- 'owner' | 'member'
  token_version INTEGER DEFAULT 0,          -- bump to log someone out everywhere
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX users_household ON users(household_id);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX invites_household ON invites(household_id);

-- Per-family settings: Dropbox connection (tokens never leave the server), folder, recipes version, ...
CREATE TABLE household_settings (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (household_id, key)
);

CREATE TABLE recipes (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
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
CREATE INDEX recipes_household ON recipes(household_id);
CREATE UNIQUE INDEX recipes_hh_source_path ON recipes(household_id, source_path) WHERE source_path IS NOT NULL;

CREATE TABLE ingredients (
  id INTEGER PRIMARY KEY,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL,            -- denormalised so one indexed query loads a family's ingredients
  position INTEGER,
  raw TEXT,
  qty REAL,
  unit TEXT,
  name TEXT,
  note TEXT,
  category TEXT,
  staple INTEGER DEFAULT 0
);
CREATE INDEX ingredients_household ON ingredients(household_id, recipe_id);

CREATE TABLE plan_items (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  planned_for TEXT,
  servings INTEGER,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX plan_household ON plan_items(household_id);

CREATE TABLE cook_log (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cooked_on TEXT NOT NULL
);
CREATE INDEX cook_log_household ON cook_log(household_id, cooked_on);

CREATE TABLE shopping_checks (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  checked_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, key)
);

CREATE TABLE shopping_manual (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  category TEXT DEFAULT 'Other',
  checked INTEGER DEFAULT 0,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX manual_household ON shopping_manual(household_id);

-- Files that were tried and produced no recipe (or failed), so imports don't retry them forever.
CREATE TABLE import_log (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL,
  status TEXT NOT NULL,                     -- 'empty' | 'error' | 'needs_ocr'
  detail TEXT,
  at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (household_id, source_path)
);
