// Shared helper for CLI scripts: pick the family to work on.
import { getUserAuthByEmail, listHouseholdIds, getHousehold } from '../server/db.js';

export function resolveFamily(args) {
  const i = args.indexOf('--email');
  if (i !== -1) {
    const u = getUserAuthByEmail(args[i + 1] || '');
    if (!u) throw new Error(`No account with email ${args[i + 1]}`);
    if (!u.household_id) throw new Error(`${args[i + 1]} isn't in a family yet`);
    return u.household_id;
  }
  const ids = listHouseholdIds();
  if (ids.length === 1) return ids[0];
  if (!ids.length) return null;
  throw new Error(`There are ${ids.length} families — add --email <your login email> to choose yours (${ids.map((h) => getHousehold(h).name).join(', ')})`);
}
