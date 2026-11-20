// One Dropbox connection per family. Tokens stay in D1 (household_settings) and never reach browsers.
// Family members can only list/download files inside the family's recipe folder, and only the person
// who connected Dropbox (it's their account) can change which folder that is.
import { getFamilySetting, getFamilySettings, setFamilySetting, getUser, HttpError } from './db.js';
import { bytesToB64url } from './auth.js';

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';
const KEYS = ['dropbox_app_key', 'dropbox_token', 'dropbox_account', 'dropbox_connected_by', 'dropbox_folder', 'dropbox_last_import'];

export async function status(env, hid) {
  const s = await getFamilySettings(env.DB, hid, KEYS);
  const by = s.dropbox_connected_by ? await getUser(env.DB, s.dropbox_connected_by) : null;
  return {
    appKeyConfigured: !!(s.dropbox_app_key || env.DROPBOX_APP_KEY),
    appKeyFromEnv: !!env.DROPBOX_APP_KEY && !s.dropbox_app_key,
    connected: !!s.dropbox_token?.refresh_token,
    account: s.dropbox_account || null,
    connectedBy: by ? { id: by.id, name: by.name } : null,
    folder: s.dropbox_folder ?? env.DROPBOX_FOLDER ?? '/Recipes',
    lastImport: s.dropbox_last_import || null,
  };
}

async function appKey(env, hid) {
  return (await getFamilySetting(env.DB, hid, 'dropbox_app_key')) || env.DROPBOX_APP_KEY;
}

export async function startAuth(env, hid, key) {
  if (key) await setFamilySetting(env.DB, hid, 'dropbox_app_key', String(key).trim());
  const clientId = await appKey(env, hid);
  if (!clientId) throw new HttpError(400, 'Dropbox app key is required');
  const verifier = bytesToB64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = bytesToB64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  await setFamilySetting(env.DB, hid, 'dropbox_pkce', verifier);
  const params = new URLSearchParams({
    client_id: clientId, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline',
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

async function tokenRequest(body) {
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(400, `Dropbox sign-in failed: ${json.error_description || json.error || res.status}`);
  return json;
}

export async function finishAuth(env, hid, userId, code) {
  const verifier = await getFamilySetting(env.DB, hid, 'dropbox_pkce');
  if (!verifier) throw new HttpError(400, 'Start the Dropbox connection first');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: String(code).trim(), client_id: await appKey(env, hid), code_verifier: verifier });
  await setFamilySetting(env.DB, hid, 'dropbox_token', { ...tok, expires_at: Date.now() + (tok.expires_in - 60) * 1000 });
  await setFamilySetting(env.DB, hid, 'dropbox_pkce', null);
  await setFamilySetting(env.DB, hid, 'dropbox_connected_by', userId);
  try {
    const acct = await rpc(env, hid, '/2/users/get_current_account', null);
    await setFamilySetting(env.DB, hid, 'dropbox_account', acct?.name?.display_name || acct?.email || 'Dropbox');
  } catch { /* cosmetic */ }
  return status(env, hid);
}

/** Changing the folder or disconnecting is limited to whoever connected it, or the family owner. */
export async function assertCanManage(env, hid, user) {
  const by = await getFamilySetting(env.DB, hid, 'dropbox_connected_by');
  if (by && by !== user.id && user.role !== 'owner') throw new HttpError(403, 'Only the person who connected Dropbox (or the family owner) can change this');
}

export async function setFolder(env, hid, user, folder) {
  const by = await getFamilySetting(env.DB, hid, 'dropbox_connected_by');
  // The folder decides what the whole family can read from the connector's Dropbox, so only they may change it.
  if (by && by !== user.id) throw new HttpError(403, 'Only the person who connected Dropbox can change the folder (it\'s their Dropbox)');
  let f = String(folder || '').trim().replace(/\/+$/, '');
  if (f && !f.startsWith('/')) f = `/${f}`;
  await setFamilySetting(env.DB, hid, 'dropbox_folder', f);
}

export async function disconnect(env, hid) {
  for (const k of ['dropbox_token', 'dropbox_account', 'dropbox_connected_by']) await setFamilySetting(env.DB, hid, k, null);
}

async function accessToken(env, hid) {
  let tok = await getFamilySetting(env.DB, hid, 'dropbox_token');
  if (!tok?.refresh_token) throw new HttpError(400, 'Dropbox is not connected for this family');
  if (!tok.access_token || Date.now() > (tok.expires_at || 0)) {
    const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: await appKey(env, hid) });
    tok = { ...tok, ...fresh, refresh_token: tok.refresh_token, expires_at: Date.now() + (fresh.expires_in - 60) * 1000 };
    await setFamilySetting(env.DB, hid, 'dropbox_token', tok);
  }
  return tok.access_token;
}

async function rpc(env, hid, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(env, hid)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 409 && text.includes('not_found')) throw new HttpError(404, 'That Dropbox folder was not found — check the folder name');
    throw new HttpError(502, `Dropbox ${endpoint} failed (${res.status})`);
  }
  return text ? JSON.parse(text) : null;
}

// Dropbox-API-Arg must be ASCII.
const headerSafeJson = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export async function listFolder(env, hid) {
  const { folder } = await status(env, hid);
  const entries = [];
  let page = await rpc(env, hid, '/2/files/list_folder', { path: folder, recursive: true, limit: 2000 });
  entries.push(...page.entries);
  // Each page is one outbound request; the free plan allows 50 per request, plenty for thousands of files.
  for (let i = 0; page.has_more && i < 40; i++) {
    page = await rpc(env, hid, '/2/files/list_folder/continue', { cursor: page.cursor });
    entries.push(...page.entries);
  }
  return { folder, files: entries.filter((e) => e['.tag'] === 'file') };
}

/** True if `path` is inside the family's recipe folder (case-insensitive, like Dropbox). */
export function insideFolder(folder, path) {
  const f = String(folder || '').toLowerCase().replace(/\/+$/, '');
  const p = String(path || '').toLowerCase();
  if (p.includes('/../') || p.endsWith('/..')) return false;
  return f === '' ? p.startsWith('/') : p.startsWith(`${f}/`);
}

export async function download(env, hid, path) {
  const { folder } = await status(env, hid);
  if (!insideFolder(folder, path)) throw new HttpError(403, 'That file is outside the family recipe folder');
  const res = await fetch(`${CONTENT}/2/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(env, hid)}`, 'Dropbox-API-Arg': headerSafeJson({ path }) },
  });
  if (!res.ok) throw new HttpError(502, `Download failed (${res.status})`);
  return res;
}

/**
 * One level of the connector's Dropbox, for the folder picker: subfolders plus a count of recipe files here.
 * Only the person who connected Dropbox may call this (enforced by the route): it reveals their folder names.
 */
export async function browse(env, hid, path, isSupported) {
  let p = String(path || '').trim().replace(/\/+$/, '');
  if (p && !p.startsWith('/')) p = `/${p}`;
  if (p.includes('/../') || p.endsWith('/..')) throw new HttpError(400, 'Bad folder path');
  const entries = [];
  let page = await rpc(env, hid, '/2/files/list_folder', { path: p, recursive: false, limit: 2000 });
  entries.push(...page.entries);
  for (let i = 0; page.has_more && i < 10; i++) {
    page = await rpc(env, hid, '/2/files/list_folder/continue', { cursor: page.cursor });
    entries.push(...page.entries);
  }
  const folders = entries.filter((e) => e['.tag'] === 'folder')
    .map((e) => ({ name: e.name, path: e.path_display }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const files = entries.filter((e) => e['.tag'] === 'file');
  const display = p ? (entries[0]?.path_display?.split('/').slice(0, -1).join('/') || p) : '';
  return { path: display, parent: p ? p.split('/').slice(0, -1).join('/') : null, folders, recipeFiles: files.filter((f) => isSupported(f.name)).length, otherFiles: files.filter((f) => !isSupported(f.name)).length };
}

/** A short-lived (4 hour) direct link to a file in the recipe folder, for "📄 Original" (works in the apps too). */
export async function temporaryLink(env, hid, path) {
  const { folder } = await status(env, hid);
  if (!insideFolder(folder, path)) throw new HttpError(403, 'That file is outside the family recipe folder');
  const res = await rpc(env, hid, '/2/files/get_temporary_link', { path });
  return res.link;
}
