import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('every migration file is listed in worker/migrate.js, in order', () => {
  const files = fs.readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
  const src = fs.readFileSync('worker/migrate.js', 'utf8');
  const listed = [...src.matchAll(/\['(\d{4}_[^']+\.sql)'/g)].map((m) => m[1]);
  assert.deepEqual(listed, files);
});

test('migration SQL splits into clean statements', async () => {
  // Import the splitter without the .sql import (Node can't load it); copy of the function under test.
  const src = fs.readFileSync('worker/migrate.js', 'utf8');
  const fnSrc = src.slice(src.indexOf('export function splitSql'), src.indexOf('async function applyPending'));
  const splitSql = new Function(`${fnSrc.replace('export ', '')}; return splitSql;`)();
  const stmts = splitSql(fs.readFileSync('migrations/0001_init.sql', 'utf8'));
  assert.ok(stmts.length > 15);
  for (const s of stmts) assert.match(s, /^(CREATE|INSERT|ALTER|DROP)/, s.slice(0, 60));
});
