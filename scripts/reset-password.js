// Reset someone's password from the server (there's no email-based reset):
//   npm run reset-password -- someone@example.com 'new-password'
import { openDb, getUserAuthByEmail, setPassword } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) { console.error('Usage: npm run reset-password -- <email> <new password, 8+ chars>'); process.exit(1); }
openDb();
const u = getUserAuthByEmail(email);
if (!u) { console.error(`No account with email ${email}`); process.exit(1); }
setPassword(u.id, await hashPassword(password));
console.log(`Password updated for ${u.name}. They've been logged out on other devices.`);
