// Dropbox integration: PKCE "paste the code" OAuth (no redirect URL or app secret needed),
// then list a folder and import every supported recipe file.
import crypto from 'node:crypto';
import path from 'node:path';
import { getSetting, setSetting, findBySourcePath } from './db.js';
import { importFile, isSupported } from './importer.js';

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

function appKey() {
  return process.env.DROPBOX_APP_KEY || getSetting('dropbox_app_key');
}

export function dropboxStatus() {
  const tok = getSetting('dropbox_token');
  return {
    appKeyConfigured: !!appKey(),
    appKeyFromEnv: !!process.env.DROPBOX_APP_KEY,
    connected: !!(tok?.refresh_token || process.env.DROPBOX_REFRESH_TOKEN),
    account: getSetting('dropbox_account'),
    folder: getSetting('dropbox_folder', process.env.DROPBOX_FOLDER || '/Recipes'),
    lastSync: getSetting('dropbox_last_sync'),
  };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function startAuth(key) {
  if (key) setSetting('dropbox_app_key', key.trim());
  const clientId = appKey();
  if (!clientId) throw new Error('Dropbox app key is required');
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  setSetting('dropbox_pkce', verifier);
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

export async function finishAuth(code) {
  const verifier = getSetting('dropbox_pkce');
  if (!verifier) throw new Error('Start the Dropbox connection first');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: code.trim(), client_id: appKey(), code_verifier: verifier });
  setSetting('dropbox_token', { ...tok, expires_at: Date.now() + (tok.expires_in - 60) * 1000 });
  setSetting('dropbox_pkce', null);
  try {
    const acct = await rpc('/2/users/get_current_account', null);
    setSetting('dropbox_account', acct?.name?.display_name || acct?.email || 'Dropbox');
  } catch { /* account name is cosmetic */ }
  return dropboxStatus();
}

export function disconnect() {
  setSetting('dropbox_token', null);
  setSetting('dropbox_account', null);
}

export function setFolder(folder) {
  let f = (folder || '').trim();
  if (f && !f.startsWith('/')) f = `/${f}`;
  if (f === '/') f = '';
  setSetting('dropbox_folder', f);
}

async function accessToken() {
  let tok = getSetting('dropbox_token');
  const refresh = tok?.refresh_token || process.env.DROPBOX_REFRESH_TOKEN;
  if (!refresh) throw new Error('Dropbox is not connected');
  if (!tok?.access_token || Date.now() > (tok.expires_at || 0)) {
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: appKey() });
    tok = { ...tok, ...fresh, refresh_token: refresh, expires_at: Date.now() + (fresh.expires_in - 60) * 1000 };
    setSetting('dropbox_token', tok);
  }
  return tok.access_token;
}

async function rpc(endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dropbox ${endpoint} failed (${res.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// The Dropbox-API-Arg header must be ASCII; escape anything else.
const headerSafeJson = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function download(p) {
  const res = await fetch(`${CONTENT}/2/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Dropbox-API-Arg': headerSafeJson({ path: p }) },
  });
  if (!res.ok) throw new Error(`Download failed for ${p} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function listFiles(folder = dropboxStatus().folder) {
  const entries = [];
  let page = await rpc('/2/files/list_folder', { path: folder, recursive: true, limit: 2000 });
  entries.push(...page.entries);
  while (page.has_more) {
    page = await rpc('/2/files/list_folder/continue', { cursor: page.cursor });
    entries.push(...page.entries);
  }
  return entries.filter((e) => e['.tag'] === 'file');
}

// ---------- background sync job ----------
let job = null;

export function syncStatus() {
  return job;
}

export function startSync({ force = false } = {}) {
  if (job?.running) return job;
  job = { running: true, startedAt: new Date().toISOString(), total: 0, done: 0, imported: 0, skipped: 0, unsupported: 0, errors: [], current: null };
  runSync(job, force).catch((e) => { job.errors.push({ file: '(listing)', error: e.message }); }).finally(() => {
    job.running = false; job.current = null; job.finishedAt = new Date().toISOString();
    setSetting('dropbox_last_sync', { at: job.finishedAt, imported: job.imported, skipped: job.skipped, errors: job.errors.length });
  });
  return job;
}

async function runSync(state, force) {
  const files = await listFiles();
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
        if (!force && (findBySourcePath(sourcePath) || findBySourcePath(`${sourcePath}#1`))) { state.skipped++; state.done++; continue; }
        const buffer = await download(f.path_lower);
        const r = await importFile({ name: f.name, buffer, sourcePath, sourceRev: f.rev, source: 'dropbox', force });
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
