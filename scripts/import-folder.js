// Import every recipe file in a local folder (e.g. your Dropbox desktop folder):
//   npm run import -- "~/Dropbox/Recipes"
// Re-running only imports new files. Add --force to re-import everything.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../server/db.js';
import { importFile, isSupported } from '../server/importer.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dirArg = args.find((a) => !a.startsWith('--'));
if (!dirArg) { console.error('Usage: npm run import -- <folder> [--force]'); process.exit(1); }
const root = path.resolve(dirArg.replace(/^~(?=$|\/)/, os.homedir()));

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p); else yield p;
  }
}

openDb();
let imported = 0; let skipped = 0; let unsupported = 0; const failed = [];
for await (const file of walk(root)) {
  if (!isSupported(file)) { unsupported++; continue; }
  const rel = path.relative(root, file);
  try {
    const r = await importFile({ name: path.basename(file), buffer: await fs.readFile(file), sourcePath: `local:${rel.toLowerCase()}`, source: 'folder', force });
    if (r.status === 'imported') { imported += r.ids.length; console.log(`✓ ${rel}`); }
    else if (r.status === 'skipped') skipped++;
    else failed.push(`${rel}: no recipe found`);
  } catch (e) { failed.push(`${rel}: ${e.message}`); }
}
console.log(`\nImported ${imported}, already had ${skipped}, unsupported files ${unsupported}.`);
if (failed.length) console.log(`Problems:\n  ${failed.join('\n  ')}`);
