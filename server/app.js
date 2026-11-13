import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { requireAuth, login, logout, isAuthed, authEnabled } from './auth.js';
import { aiEnabled } from './ai.js';
import { lighterTips, scoreHealth, HEALTH_LEVELS } from './health.js';
import { normalizeName, categorize } from './ingredients.js';
import { importFile, importUrl, extractFromFile, supportedExtensions } from './importer.js';
import * as planner from './planner.js';
import * as dropbox from './dropbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Bumped on every change so the other person's phone knows to refresh.
let revision = Date.now();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (req) => Number(req.params.id);

function recipeSummary(r) {
  return {
    id: r.id, title: r.title, servings: r.servings, prepMinutes: r.prepMinutes, tags: r.tags, health: r.health,
    favorite: r.favorite, lastCooked: r.lastCooked, timesCooked: r.timesCooked, source: r.source,
    ingredientCount: r.ingredients?.length ?? 0,
    ingredientNames: [...new Set((r.ingredients || []).map((i) => i.name))],
  };
}

function planPayload() {
  const recipes = db.listRecipes();
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const items = db.listPlan().filter((p) => byId.has(p.recipeId));
  const planRecipes = items.map((p) => byId.get(p.recipeId));
  const healthAvg = planRecipes.length ? planRecipes.reduce((s, r) => s + r.health, 0) / planRecipes.length : null;
  return {
    items: items.map((p) => ({ ...p, recipe: recipeSummary(byId.get(p.recipeId)) })),
    batches: planner.batchGroups(planRecipes),
    complements: planner.complementarySuggestions(planRecipes, recipes),
    healthAvg,
  };
}

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  app.post('/api/login', login);
  app.post('/api/logout', logout);
  app.get('/api/session', (req, res) => res.json({ authed: isAuthed(req), authRequired: authEnabled() }));

  app.use('/api', requireAuth);
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) revision = Date.now(); });
    next();
  });

  app.get('/api/rev', (req, res) => res.json({ rev: revision }));
  app.get('/api/status', (req, res) => res.json({
    ai: aiEnabled(), dropbox: dropbox.dropboxStatus(), supportedExtensions: supportedExtensions(), healthLevels: HEALTH_LEVELS,
    goals: planner.HEALTH_GOALS,
  }));

  // ---------- recipes ----------
  app.get('/api/recipes', (req, res) => res.json(db.listRecipes().map(recipeSummary)));

  app.get('/api/recipes/:id', (req, res) => {
    const r = db.getRecipe(id(req));
    if (!r) return res.status(404).json({ error: 'Not found' });
    const all = db.listRecipes();
    const similar = all.filter((o) => o.id !== r.id)
      .map((o) => ({ id: o.id, title: o.title, ...planner.sharedIngredients(r, o) }))
      .filter((o) => o.shared.length >= 2)
      .sort((a, b) => b.weight - a.weight).slice(0, 5)
      .map((o) => ({ id: o.id, title: o.title, shared: o.shared.map((s) => s.name) }));
    res.json({ ...r, lighterTips: r.health <= 3 ? lighterTips(r.ingredients) : [], autoHealth: scoreHealth(r.title, r.ingredients), similar });
  });

  app.post('/api/recipes', (req, res) => res.json(db.getRecipe(db.saveRecipe(req.body))));
  app.put('/api/recipes/:id', (req, res) => res.json(db.getRecipe(db.saveRecipe(req.body, id(req)))));
  app.patch('/api/recipes/:id', (req, res) => { db.patchRecipe(id(req), req.body); res.json(db.getRecipe(id(req))); });
  app.delete('/api/recipes/:id', (req, res) => { db.deleteRecipe(id(req)); res.json({ ok: true }); });
  app.post('/api/recipes/:id/cooked', (req, res) => { db.logCooked(id(req), req.body?.date); res.json({ ok: true }); });

  // ---------- importing ----------
  app.post('/api/import/text', wrap(async (req, res) => {
    const text = String(req.body?.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'Paste a recipe first' });
    const recipes = await extractFromFile('pasted.txt', Buffer.from(text));
    const ids = recipes.filter((r) => r.ingredients?.length).map((r) => db.saveRecipe({ ...r, source: 'pasted' }));
    if (!ids.length) return res.status(422).json({ error: "Couldn't find ingredients in that text" });
    res.json({ ids });
  }));

  app.post('/api/import/upload', express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
    const name = decodeURIComponent(req.headers['x-filename'] || 'upload.txt');
    const r = await importFile({ name, buffer: req.body, source: 'upload' });
    if (r.status === 'empty') return res.status(422).json({ error: `No recipe found in ${name}` });
    res.json(r);
  }));

  app.post('/api/import/url', wrap(async (req, res) => {
    const url = String(req.body?.url || '');
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Enter a full https:// link' });
    const ids = await importUrl(url);
    if (!ids.length) return res.status(422).json({ error: "Couldn't find a recipe on that page" });
    res.json({ ids });
  }));

  // ---------- dropbox ----------
  app.get('/api/dropbox', (req, res) => res.json({ ...dropbox.dropboxStatus(), sync: dropbox.syncStatus() }));
  app.post('/api/dropbox/auth/start', (req, res) => res.json({ url: dropbox.startAuth(req.body?.appKey) }));
  app.post('/api/dropbox/auth/finish', wrap(async (req, res) => res.json(await dropbox.finishAuth(String(req.body?.code || '')))));
  app.post('/api/dropbox/folder', (req, res) => { dropbox.setFolder(req.body?.folder); res.json(dropbox.dropboxStatus()); });
  app.post('/api/dropbox/disconnect', (req, res) => { dropbox.disconnect(); res.json(dropbox.dropboxStatus()); });
  app.get('/api/dropbox/files', wrap(async (req, res) => {
    const files = await dropbox.listFiles();
    res.json(files.map((f) => ({ path: f.path_display, size: f.size })));
  }));
  app.post('/api/dropbox/sync', (req, res) => res.json(dropbox.startSync({ force: !!req.body?.force })));

  // ---------- plan ----------
  app.get('/api/plan', (req, res) => res.json(planPayload()));
  app.post('/api/plan', (req, res) => {
    const ids = req.body.recipeIds || [req.body.recipeId];
    for (const rid of ids) db.addToPlan(Number(rid), req.body);
    res.json(planPayload());
  });
  app.patch('/api/plan/:id', (req, res) => { db.updatePlanItem(id(req), req.body); res.json(planPayload()); });
  app.delete('/api/plan/:id', (req, res) => { db.removePlanItem(id(req)); res.json(planPayload()); });
  app.delete('/api/plan', (req, res) => { db.clearPlan(); res.json(planPayload()); });
  app.post('/api/plan/:id/cooked', (req, res) => {
    const item = db.listPlan().find((p) => p.id === id(req));
    if (!item) return res.status(404).json({ error: 'Not in plan' });
    db.logCooked(item.recipeId, req.body?.date);
    db.removePlanItem(item.id);
    res.json(planPayload());
  });

  // ---------- suggestions & memory ----------
  app.get('/api/suggestions', (req, res) => {
    const recipes = db.listRecipes();
    const plan = db.listPlan();
    const suggested = planner.suggestMeals(recipes, {
      count: Math.min(Number(req.query.count) || 5, 14),
      goal: req.query.goal || 'balanced',
      seedRecipeIds: plan.map((p) => p.recipeId),
      seed: Number(req.query.seed) || Date.now(),
      favoritesWeight: req.query.favorites === 'more' ? 2 : req.query.favorites === 'less' ? 0.3 : 1,
    });
    res.json({ suggested, forgotten: planner.forgottenFavorites(recipes) });
  });

  app.get('/api/history', (req, res) => res.json(db.cookHistory(Number(req.query.limit) || 60)));
  app.delete('/api/history/:id', (req, res) => { db.deleteCookEntry(id(req)); res.json({ ok: true }); });

  // ---------- shopping ----------
  const shopping = () => {
    const recipes = db.listRecipes();
    return planner.buildShoppingList(db.listPlan(), new Map(recipes.map((r) => [r.id, r])), db.getChecks(), db.listManual());
  };
  app.get('/api/shopping', (req, res) => res.json(shopping()));
  app.post('/api/shopping/check', (req, res) => { db.setCheck(String(req.body.key), !!req.body.checked); res.json(shopping()); });
  app.post('/api/shopping/manual', (req, res) => {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Empty item' });
    db.addManual(label, categorize(normalizeName(label)));
    res.json(shopping());
  });
  app.patch('/api/shopping/manual/:id', (req, res) => { db.updateManual(id(req), req.body); res.json(shopping()); });
  app.delete('/api/shopping/manual/:id', (req, res) => { db.deleteManual(id(req)); res.json(shopping()); });
  app.post('/api/shopping/clear-checked', (req, res) => { db.clearCheckedManual(); res.json(shopping()); });

  // ---------- backup ----------
  app.get('/api/export', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="recipes-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exportedAt: new Date().toISOString(), recipes: db.listRecipes(), history: db.cookHistory(100000) });
  });

  app.use('/api', (err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Something went wrong' });
  });

  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));
  return app;
}
