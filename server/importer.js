// Turn a file (from Dropbox, an upload, a local folder or a URL) into saved recipes.
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import mammoth from 'mammoth';
import { parseRecipeText } from './parser.js';
import { aiEnabled, extractRecipes } from './ai.js';
import { saveRecipe, findBySourcePath } from './db.js';

export const TEXT_EXT = ['.txt', '.md', '.markdown', '.text', '.rtf'];
export const HTML_EXT = ['.html', '.htm'];
export const DOCX_EXT = ['.docx'];
export const PDF_EXT = ['.pdf'];
export const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
export const JSON_EXT = ['.json'];

export function supportedExtensions() {
  const base = [...TEXT_EXT, ...HTML_EXT, ...DOCX_EXT, ...JSON_EXT];
  return aiEnabled() ? [...base, ...PDF_EXT, ...Object.keys(IMAGE_EXT)] : base;
}

export function isSupported(name) {
  return supportedExtensions().includes(path.extname(name).toLowerCase());
}

function stripRtf(s) {
  return s.replace(/\\par[d]?/g, '\n').replace(/\{\\[^{}]*\}/g, '').replace(/\\[a-z]+-?\d* ?/g, '').replace(/[{}]/g, '');
}

export function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&frac12;/g, '½').replace(/&frac14;/g, '¼').replace(/&frac34;/g, '¾')
    .replace(/\n{3,}/g, '\n\n');
}

function isoDurationToMinutes(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(d || '');
  if (!m) return null;
  const mins = Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  return mins || null;
}

function flattenInstructions(ins) {
  if (!ins) return [];
  if (typeof ins === 'string') return htmlToText(ins).split('\n').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(flattenInstructions);
  if (ins.itemListElement) return flattenInstructions(ins.itemListElement);
  if (ins.text) return [htmlToText(ins.text).trim()];
  return [];
}

/** schema.org/Recipe JSON-LD (most recipe websites embed this). */
export function recipesFromJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = node['@type'];
    if (type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'))) out.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  while ((m = re.exec(html))) {
    try { visit(JSON.parse(m[1].trim())); } catch { /* ignore malformed blocks */ }
  }
  return out.map((r) => {
    const yieldStr = Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield;
    const servings = parseInt(String(yieldStr || '').match(/\d+/)?.[0] || '', 10) || 4;
    return {
      title: htmlToText(r.name || 'Untitled recipe').trim(),
      servings,
      prepMinutes: isoDurationToMinutes(r.totalTime) || isoDurationToMinutes(r.cookTime),
      ingredients: (r.recipeIngredient || r.ingredients || []).map((s) => htmlToText(String(s)).trim()),
      instructions: flattenInstructions(r.recipeInstructions).map((s, i) => `${i + 1}. ${s}`).join('\n'),
      notes: r.description ? htmlToText(r.description).trim() : '',
      tags: [].concat(r.recipeCuisine || [], r.recipeCategory || []).flatMap((t) => String(t).split(',')).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5),
    };
  });
}

/** Extract recipe objects from a file without saving. */
export async function extractFromFile(name, buffer) {
  const ext = path.extname(name).toLowerCase();
  const fallbackTitle = path.basename(name, ext).replace(/[_-]+/g, ' ').trim();
  const useAi = aiEnabled();

  if (IMAGE_EXT[ext]) {
    if (!useAi) throw new Error('Photos need the Claude integration (set ANTHROPIC_API_KEY)');
    return extractRecipes({ image: buffer, mediaType: IMAGE_EXT[ext], filename: name });
  }
  if (PDF_EXT.includes(ext)) {
    if (!useAi) throw new Error('PDFs need the Claude integration (set ANTHROPIC_API_KEY)');
    return extractRecipes({ pdf: buffer, filename: name });
  }

  let text;
  if (HTML_EXT.includes(ext)) {
    const html = buffer.toString('utf8');
    const ld = recipesFromJsonLd(html);
    if (ld.length) return ld;
    text = htmlToText(html);
  } else if (DOCX_EXT.includes(ext)) {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (JSON_EXT.includes(ext)) {
    const data = JSON.parse(buffer.toString('utf8'));
    const list = Array.isArray(data) ? data : data.recipes || [data];
    return list.filter((r) => r && (r.title || r.name)).map((r) => ({
      ...r, title: r.title || r.name, ingredients: r.ingredients || r.recipeIngredient || [],
    }));
  } else if (ext === '.rtf') {
    text = stripRtf(buffer.toString('utf8'));
  } else {
    text = buffer.toString('utf8');
  }

  if (!text.trim()) return [];
  if (useAi) {
    try { return await extractRecipes({ text, filename: name }); } catch (e) {
      console.warn(`AI extraction failed for ${name}, using basic parser:`, e.message);
    }
  }
  return [parseRecipeText(text, fallbackTitle)];
}

/**
 * Import a file and save its recipes. Skips files already imported (by sourcePath) unless force.
 * @returns {{status: 'imported'|'skipped'|'empty', ids: number[]}}
 */
export async function importFile(hid, { name, buffer, sourcePath = null, sourceRev = null, source = 'upload', force = false }) {
  if (sourcePath && !force) {
    const existing = findBySourcePath(hid, sourcePath) || findBySourcePath(hid, `${sourcePath}#1`);
    if (existing) return { status: 'skipped', ids: [existing.id] };
  }
  const recipes = (await extractFromFile(name, buffer)).filter((r) => r.title && r.ingredients?.length);
  if (!recipes.length) return { status: 'empty', ids: [] };
  const ids = recipes.map((r, idx) => {
    const sp = sourcePath ? (recipes.length > 1 ? `${sourcePath}#${idx + 1}` : sourcePath) : null;
    const existing = sp ? findBySourcePath(hid, sp) : null;
    return saveRecipe(hid, { ...r, source, sourcePath: sp, sourceRev }, existing?.id ?? null);
  });
  return { status: 'imported', ids };
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Refuse links that point at the server's own network (localhost, cloud metadata, LAN). */
export async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) links are supported');
  const addrs = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => []);
  if (!addrs.length) throw new Error("Couldn't find that website");
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That link points to a private network address');
}

export async function importUrl(hid, url) {
  let current = url; let res;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(current);
    res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HouseholdMealPlanner/1.0)' } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).href; continue; }
    break;
  }
  if (!res.ok) throw new Error(`Could not fetch page (${res.status})`);
  const html = await res.text();
  const ld = recipesFromJsonLd(html);
  const recipes = ld.length ? ld : (await extractFromFile('page.html', Buffer.from(html)));
  const good = recipes.filter((r) => r.title && r.ingredients?.length);
  return good.map((r) => saveRecipe(hid, { ...r, source: 'web', notes: [r.notes, `Source: ${url}`].filter(Boolean).join('\n') }));
}
