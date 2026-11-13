// Dropbox integration, one connection per family: whoever connects it, everyone in the family
// can import from it. Tokens live only on the server (household_settings) and are never sent to browsers.
// Uses PKCE "paste the code" OAuth, so only a Dropbox app key is needed (no secret, no redirect URL).
import crypto from 'node:crypto';
import path from 'node:path';
import { getFamilySetting, setFamilySetting, findBySourcePath, getUser } from './db.js';
import { importFile, isSupported } from './importer.js';

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

function appKey(hid) {
  return getFamilySetting(hid, 'dropbox_app_key') || process.env.DROPBOX_APP_KEY;
}

export function dropboxStatus(hid) {
  const tok = getFamilySetting(hid, 'dropbox_token');
  const by = getFamilySetting(hid, 'dropbox_connected_by');
  return {
    appKeyConfigured: !!appKey(hid),
    appKeyFromEnv: !!process.env.DROPBOX_APP_KEY && !getFamilySetting(hid, 'dropbox_app_key'),
    connected: !!tok?.refresh_token,
    account: getFamilySetting(hid, 'dropbox_account'),
    connectedBy: by ? getUser(by)?.name ?? null : null,
    folder: getFamilySetting(hid, 'dropbox_folder', process.env.DROPBOX_FOLDER || '/Recipes'),
    lastSync: getFamilySetting(hid, 'dropbox_last_sync'),
  };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function startAuth(hid, key) {
  if (key) setFamilySetting(hid, 'dropbox_app_key', key.trim());
  const clientId = appKey(hid);
  if (!clientId) throw new Error('Dropbox app key is required');
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  setFamilySetting(hid, 'dropbox_pkce', verifier);
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', code_challenge: challenge,
    code_challenge_method: 'S256', token_access_type: 'offline',
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Dropbox auth failed: ${json.error_description || json.error || res.status}`);
  return json;
}

export async function finishAuth(hid, userId, code) {
  const verifier = getFamilySetting(hid, 'dropbox_pkce');
  if (!verifier) throw new Error('Start the Dropbox connection first');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: code.trim(), client_id: appKey(hid), code_verifier: verifier });
  setFamilySetting(hid, 'dropbox_token', { ...tok, expires_at: Date.now() + (tok.expires_in - 60) * 1000 });
  setFamilySetting(hid, 'dropbox_pkce', null);
  setFamilySetting(hid, 'dropbox_connected_by', userId);
  try {
    const acct = await rpc(hid, '/2/users/get_current_account', null);
    setFamilySetting(hid, 'dropbox_account', acct?.name?.display_name || acct?.email || 'Dropbox');
  } catch { /* account name is cosmetic */ }
  return dropboxStatus(hid);
}

export function disconnect(hid) {
  setFamilySetting(hid, 'dropbox_token', null);
  setFamilySetting(hid, 'dropbox_account', null);
  setFamilySetting(hid, 'dropbox_connected_by', null);
}

export function setFolder(hid, folder) {
  let f = (folder || '').trim();
  if (f && !f.startsWith('/')) f = `/${f}`;
  if (f === '/') f = '';
  setFamilySetting(hid, 'dropbox_folder', f);
}

async function accessToken(hid) {
  let tok = getFamilySetting(hid, 'dropbox_token');
  if (!tok?.refresh_token) throw new Error('Dropbox is not connected for this family');
  if (!tok.access_token || Date.now() > (tok.expires_at || 0)) {
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: appKey(hid) });
    tok = { ...tok, ...fresh, refresh_token: tok.refresh_token, expires_at: Date.now() + (fresh.expires_in - 60) * 1000 };
    setFamilySetting(hid, 'dropbox_token', tok);
  }
  return tok.access_token;
}

async function rpc(hid, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(hid)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dropbox ${endpoint} failed (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// The Dropbox-API-Arg header must be ASCII; escape anything else.
const headerSafeJson = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function download(hid, p) {
  const res = await fetch(`${CONTENT}/2/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(hid)}`, 'Dropbox-API-Arg': headerSafeJson({ path: p }) },
  });
  if (!res.ok) throw new Error(`Download failed for ${p} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function listFiles(hid, folder = dropboxStatus(hid).folder) {
  const entries = [];
  let page = await rpc(hid, '/2/files/list_folder', { path: folder, recursive: true, limit: 2000 });
  entries.push(...page.entries);
  while (page.has_more) {
    page = await rpc(hid, '/2/files/list_folder/continue', { cursor: page.cursor });
    entries.push(...page.entries);
  }
  return entries.filter((e) => e['.tag'] === 'file');
}

// ---------- background sync job (one per family) ----------
const jobs = new Map();

export function syncStatus(hid) {
  return jobs.get(hid) || null;
}

export function startSync(hid, { force = false, startedBy = null } = {}) {
  const existing = jobs.get(hid);
  if (existing?.running) return existing;
  const job = { running: true, startedAt: new Date().toISOString(), startedBy, total: 0, done: 0, imported: 0, skipped: 0, unsupported: 0, errors: [], current: null };
  jobs.set(hid, job);
  runSync(hid, job, force).catch((e) => { job.errors.push({ file: '(listing)', error: e.message }); }).finally(() => {
    job.running = false; job.current = null; job.finishedAt = new Date().toISOString();
    setFamilySetting(hid, 'dropbox_last_sync', { at: job.finishedAt, by: startedBy, imported: job.imported, skipped: job.skipped, errors: job.errors.length });
  });
  return job;
}

async function runSync(hid, state, force) {
  const files = await listFiles(hid);
  const supported = files.filter((f) => isSupported(f.name));
  state.unsupported = files.length - supported.length;
  state.unsupportedExamples = [...new Set(files.filter((f) => !isSupported(f.name)).map((f) => path.extname(f.name).toLowerCase() || f.name))].slice(0, 8);
  state.total = supported.length;
  const queue = [...supported];
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      state.current = f.path_display;
      const sourcePath = `dropbox:${f.path_lower}`;
      try {
        if (!force && (findBySourcePath(hid, sourcePath) || findBySourcePath(hid, `${sourcePath}#1`))) { state.skipped++; state.done++; continue; }
        const buffer = await download(hid, f.path_lower);
        const r = await importFile(hid, { name: f.name, buffer, sourcePath, sourceRev: f.rev, source: 'dropbox', force });
        if (r.status === 'imported') state.imported += r.ids.length;
        else if (r.status === 'skipped') state.skipped++;
        else state.errors.push({ file: f.path_display, error: 'No recipe found in file' });
      } catch (e) {
        state.errors.push({ file: f.path_display, error: e.message });
      }
      state.done++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}
