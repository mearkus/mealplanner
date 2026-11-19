// Turns recipe files into text / recipes on the phone (no server CPU, no paid services).
// The pure functions here are shared with the Node tests; the loaders at the bottom use browser builds.
import { parseRecipeText } from './parser.js';

import { SUPPORTED, extOf, isSupported } from './filetypes.js';

export { SUPPORTED, extOf, isSupported };

// ---------- HTML ----------
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h\d|\/tr|\/section|\/article)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&frac12;/g, '½').replace(/&frac14;/g, '¼').replace(/&frac34;/g, '¾')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function isoDurationToMinutes(d) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(d || '');
  if (!m) return null;
  return Number(m[1] || 0) * 1440 + Number(m[2] || 0) * 60 + Number(m[3] || 0) || null;
}
function flattenInstructions(ins) {
  if (!ins) return [];
  if (typeof ins === 'string') return htmlToText(ins).split('\n').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(ins)) return ins.flatMap(flattenInstructions);
  if (ins.itemListElement) return flattenInstructions(ins.itemListElement);
  if (ins.text) return [htmlToText(ins.text).trim()];
  return [];
}

/** schema.org/Recipe JSON-LD (most recipe websites embed this, and it survives "Save page"). */
export function recipesFromJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const t = node['@type'];
    if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) out.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  let m;
  while ((m = re.exec(html))) { try { visit(JSON.parse(m[1].trim())); } catch { /* skip malformed */ } }
  return out.map((r) => {
    const y = Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield;
    return {
      title: htmlToText(r.name || 'Untitled recipe'),
      servings: parseInt(String(y || '').match(/\d+/)?.[0] || '', 10) || 4,
      prepMinutes: isoDurationToMinutes(r.totalTime) || isoDurationToMinutes(r.cookTime),
      ingredients: (r.recipeIngredient || r.ingredients || []).map((s) => htmlToText(String(s))),
      instructions: flattenInstructions(r.recipeInstructions).map((s, i) => `${i + 1}. ${s}`).join('\n'),
      notes: r.description ? htmlToText(r.description) : '',
      tags: [].concat(r.recipeCuisine || [], r.recipeCategory || []).flatMap((t) => String(t).split(','))
        .map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5),
    };
  });
}

export function stripRtf(s) {
  return String(s).replace(/\\par[d]?/g, '\n').replace(/\{\\[^{}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/g, '').replace(/[{}]/g, '');
}

// ---------- PDF layout ----------
/**
 * Rebuilds reading order from positioned text items (pdf.js getTextContent).
 * Detects a two-column layout (e.g. ingredients sidebar beside the method) by looking for a vertical
 * gutter with no text, and reads the left column fully before the right one.
 * items: [{ str, x, y, w, h }] in PDF units (y grows upwards).
 */
export function layoutPageText(items, pageWidth) {
  const words = items.filter((i) => i.str && i.str.trim());
  if (!words.length) return '';
  const W = pageWidth || Math.max(...words.map((w) => w.x + w.w));
  const rows = groupRows(words);
  const split = findGutter(rows, W);
  if (split == null) return linesFrom(words);
  // Walk down the page. Lines that cross the gutter (titles, full-width notes) are read in place; between
  // them, the left column is read fully before the right one.
  const out = []; let left = []; let right = [];
  const flush = () => {
    if (left.length) out.push(linesFrom(left));
    if (right.length) out.push(linesFrom(right));
    left = []; right = [];
  };
  for (const row of rows) {
    if (row.words.some((w) => w.x < split && w.x + w.w > split)) { flush(); out.push(linesFrom(row.words)); continue; }
    for (const w of row.words) (w.x + w.w / 2 < split ? left : right).push(w);
  }
  flush();
  return out.join('\n\n');
}

function groupRows(words) {
  const sorted = [...words].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const w of sorted) {
    const tol = Math.max(2, (w.h || 10) * 0.45);
    const row = rows.find((r) => Math.abs(r.y - w.y) <= tol);
    if (row) row.words.push(w); else rows.push({ y: w.y, words: [w] });
  }
  return rows.sort((a, b) => b.y - a.y);
}

/** x-position of a vertical gutter that most lines respect, or null for a single-column page. */
function findGutter(rows, W) {
  if (rows.length < 4) return null;
  const buckets = 100; const cover = new Array(buckets).fill(0);
  for (const row of rows) {
    const hit = new Set();
    for (const w of row.words) {
      const a = Math.max(0, Math.floor((w.x / W) * buckets)); const b = Math.min(buckets - 1, Math.floor(((w.x + w.w) / W) * buckets));
      for (let i = a; i <= b; i++) hit.add(i);
    }
    for (const i of hit) cover[i] += 1;
  }
  const allowed = Math.max(2, Math.floor(rows.length * 0.34)); // titles / notes may cross it
  let best = null;
  for (let i = 25; i <= 75; i++) {
    if (cover[i] > allowed) continue;
    let j = i; while (j + 1 <= 75 && cover[j + 1] <= allowed) j++;
    if (!best || j - i > best[1] - best[0]) best = [i, j];
    i = j;
  }
  if (!best || best[1] - best[0] < 2) return null;
  const split = ((best[0] + best[1] + 1) / 2 / buckets) * W;
  // Real two-column evidence: several lines with text on both sides of the gap at the same height.
  const bothSides = rows.filter((r) => r.words.some((w) => w.x + w.w <= split) && r.words.some((w) => w.x >= split)).length;
  return bothSides >= 3 ? split : null;
}

function linesFrom(words) {
  const sorted = [...words].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const w of sorted) {
    const tol = Math.max(2, (w.h || 10) * 0.45);
    const line = lines.find((l) => Math.abs(l.y - w.y) <= tol);
    if (line) line.words.push(w); else lines.push({ y: w.y, h: w.h || 10, words: [w] });
  }
  lines.sort((a, b) => b.y - a.y);
  let out = ''; let prev = null;
  for (const l of lines) {
    l.words.sort((a, b) => a.x - b.x);
    let text = '';
    for (const [i, w] of l.words.entries()) {
      const p = l.words[i - 1];
      const gap = p ? w.x - (p.x + p.w) : 0;
      text += p && gap > Math.max(1, (w.h || 10) * 0.15) && !/\s$/.test(text) && !/^\s/.test(w.str) ? ` ${w.str}` : w.str;
    }
    // A bigger vertical jump than usual means a new paragraph/section.
    if (prev && prev.y - l.y > Math.max(prev.h, l.h) * 1.9) out += '\n';
    out += `${text.replace(/\s+/g, ' ').trim()}\n`;
    prev = l;
  }
  return out.trim();
}

/** Extract text from a PDF with a pdf.js module. Returns { text, pages, scannedPages }. */
export async function pdfToText(pdfjs, data, opts = {}) {
  const task = pdfjs.getDocument({ data, ...opts });
  const doc = await task.promise;
  const pages = []; let scannedPages = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { width } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.abs(it.transform[3]) }));
    const text = layoutPageText(items, width);
    if (text.replace(/\s/g, '').length < 20) scannedPages++;
    pages.push(text);
  }
  const numPages = doc.numPages;
  await task.destroy();
  return { text: pages.join('\n\n'), pages: numPages, scannedPages };
}

// ---------- recipes from extracted text ----------
/** Splits a document that holds several recipes (each starting with a title followed by an Ingredients heading). */
export function splitRecipes(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    if (/^\s*(#+\s*)?ingredients?\b[:\s]*$/i.test(l)) {
      let t = i - 1; while (t >= 0 && !lines[t].trim()) t--;
      // Walk back over "Serves 4" / time lines to the title.
      while (t > 0 && /\b(serves|servings|yield|makes|prep|cook|total|time)\b/i.test(lines[t]) && lines[t].length < 60) t--;
      if (t >= 0) starts.push(t);
    }
  });
  if (starts.length < 2) return [text];
  return starts.map((s, i) => lines.slice(s, starts[i + 1] ?? lines.length).join('\n'));
}

export function textToRecipes(text, fallbackTitle) {
  return splitRecipes(text).map((chunk) => parseRecipeText(chunk, fallbackTitle)).filter((r) => r.ingredients.length);
}

/**
 * Reads one file into recipes. `libs` supplies { pdfjs, mammoth } (browser builds in the app, Node builds in tests).
 * Returns { recipes, status: 'ok'|'empty'|'needs_ocr', detail }.
 */
export async function fileToRecipes(name, bytes, libs) {
  const ext = extOf(name);
  const title = name.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const decode = () => new TextDecoder().decode(bytes);
  let text = '';
  if (ext === '.pdf') {
    const r = await pdfToText(libs.pdfjs, new Uint8Array(bytes), libs.pdfOptions);
    if (r.scannedPages === r.pages) return { recipes: [], status: 'needs_ocr', detail: 'Scanned PDF (no text inside) — needs text recognition' };
    text = r.text;
  } else if (ext === '.docx') {
    text = (await libs.mammoth.extractRawText({ arrayBuffer: bytes instanceof ArrayBuffer ? bytes : bytes.buffer })).value;
  } else if (ext === '.html' || ext === '.htm') {
    const html = decode();
    const ld = recipesFromJsonLd(html);
    if (ld.length) return { recipes: ld, status: 'ok' };
    text = htmlToText(html);
  } else if (ext === '.json') {
    const data = JSON.parse(decode());
    const list = Array.isArray(data) ? data : data.recipes || [data];
    const recipes = list.filter((r) => r && (r.title || r.name)).map((r) => ({ ...r, title: r.title || r.name, ingredients: r.ingredients || r.recipeIngredient || [] }));
    return { recipes, status: recipes.length ? 'ok' : 'empty' };
  } else if (ext === '.rtf') {
    text = stripRtf(decode());
  } else {
    text = decode();
  }
  const recipes = textToRecipes(text, title);
  return recipes.length ? { recipes, status: 'ok' } : { recipes: [], status: 'empty', detail: 'No ingredient list found' };
}

// ---------- browser loaders ----------
let libsPromise;
export function browserLibs() {
  libsPromise ??= (async () => {
    const pdfjs = await import('/vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.mjs';
    if (!globalThis.mammoth) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script'); s.src = '/vendor/mammoth.browser.min.js'; s.onload = resolve; s.onerror = reject; document.head.append(s);
      });
    }
    return { pdfjs, mammoth: globalThis.mammoth, pdfOptions: { cMapUrl: '/vendor/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/standard_fonts/' } };
  })();
  return libsPromise;
}
