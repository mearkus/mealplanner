// Applies database migrations from inside the Worker, so a plain `npx wrangler deploy` is all a deploy needs.
// Uses the same bookkeeping table as `wrangler d1 migrations apply` (d1_migrations), so the two never clash.
// Add new migration files here in order (a test checks this list matches the migrations/ folder).
import m0001 from '../migrations/0001_init.sql';

export const MIGRATIONS = [['0001_init.sql', m0001]];

const TRACKING_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** Splits a migration file into statements (comments removed; our migrations don't put ';' inside strings). */
export function splitSql(sql) {
  return sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
    .split(';').map((s) => s.trim()).filter(Boolean);
}

async function applyPending(db) {
  await db.prepare(TRACKING_TABLE).run();
  const applied = new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (applied.has(name)) continue;
    // One atomic batch per migration: either all of it lands (and is recorded) or none of it.
    await db.batch([...splitSql(sql).map((s) => db.prepare(s)), db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name)]);
  }
}

let done = null;
/** Runs once per Worker instance; cheap afterwards. Retries once if another instance migrated at the same moment. */
export function ensureMigrated(db) {
  done ??= applyPending(db).catch(() => applyPending(db)).catch((err) => { done = null; throw err; });
  return done;
}
