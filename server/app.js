import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as auth from './auth.js';
import { aiEnabled } from './ai.js';
import { lighterTips, scoreHealth, HEALTH_LEVELS } from './health.js';
import { normalizeName, categorize } from './ingredients.js';
import { importFile, importUrl, extractFromFile, supportedExtensions } from './importer.js';
import * as planner from './planner.js';
import * as dropbox from './dropbox.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Bumped per family on every change, so other family members' phones know to refresh.
const revisions = new Map();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (req) => Number(req.params.id);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function recipeSummary(r) {
  return {
    id: r.id, title: r.title, servings: r.servings, prepMinutes: r.prepMinutes, tags: r.tags, health: r.health,
    favorite: r.favorite, lastCooked: r.lastCooked, timesCooked: r.timesCooked, source: r.source,
    ingredientCount: r.ingredients?.length ?? 0,
    ingredientNames: [...new Set((r.ingredients || []).map((i) => i.name))],
  };
}

function planPayload(hid) {
  const recipes = db.listRecipes(hid);
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const items = db.listPlan(hid).filter((p) => byId.has(p.recipeId));
  const planRecipes = items.map((p) => byId.get(p.recipeId));
  const healthAvg = planRecipes.length ? planRecipes.reduce((s, r) => s + r.health, 0) / planRecipes.length : null;
  return {
    items: items.map((p) => ({ ...p, recipe: recipeSummary(byId.get(p.recipeId)) })),
    batches: planner.batchGroups(planRecipes),
    complements: planner.complementarySuggestions(planRecipes, recipes),
    healthAvg,
  };
}

function mePayload(user) {
  const household = user.householdId ? db.getHousehold(user.householdId) : null;
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    family: household,
    canCreateFamily: true, // anyone with an account may start a family (accounts themselves are invite-gated)
  };
}

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '2mb' }));

  // ---------- public: accounts ----------
  app.get('/api/session', (req, res) => {
    const user = auth.currentUser(req);
    res.json({
      authed: !!user,
      hasFamily: !!user?.householdId,
      firstRun: db.countUsers() === 0,
      openSignup: process.env.ALLOW_NEW_FAMILIES === 'true',
      signupCodeRequired: !!process.env.FAMILY_SIGNUP_CODE,
    });
  });

  app.get('/api/invites/:code', (req, res) => {
    const inv = db.getInvite(req.params.code);
    if (!inv) return res.status(404).json({ error: 'This invite has expired or does not exist' });
    res.json({ familyName: inv.familyName, invitedBy: inv.invitedBy, expiresAt: inv.expiresAt });
  });

  app.post('/api/auth/signup', wrap(async (req, res) => {
    if (!auth.throttle(req)) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
    const { name, email, password, inviteCode, familyName, signupCode } = req.body || {};
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Please enter your name' });
    if (!EMAIL_RE.test(String(email || ''))) return res.status(400).json({ error: 'Please enter a valid email' });
    if (String(password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (db.getUserAuthByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists — log in instead' });

    let invite = null;
    if (inviteCode) {
      invite = db.getInvite(inviteCode);
      if (!invite) return res.status(400).json({ error: 'That invite has expired or does not exist' });
    } else if (!auth.canCreateFamily(signupCode)) {
      return res.status(403).json({ error: 'You need an invite from someone in your family to sign up' });
    }
    const uid = db.createUser({ email, name, passwordHash: await auth.hashPassword(password) });
    if (invite) db.joinHousehold(uid, invite.householdId);
    else db.createHousehold(familyName || `${String(name).trim()}'s family`, uid);
    auth.resetThrottle(req);
    auth.setSessionCookie(req, res, db.getUser(uid));
    res.json(mePayload(db.getUser(uid)));
  }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    if (!auth.throttle(req)) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
    const row = db.getUserAuthByEmail(req.body?.email || '');
    // Hash even when the user doesn't exist so response time doesn't reveal which emails have accounts.
    const ok = row ? await auth.verifyPassword(req.body?.password || '', row.password_hash)
      : (await auth.verifyPassword('x', 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='), false);
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
    auth.resetThrottle(req);
    const user = db.getUser(row.id);
    auth.setSessionCookie(req, res, user);
    res.json(mePayload(user));
  }));

  app.post('/api/auth/logout', (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

  // ---------- logged in: account & family ----------
  app.use('/api', auth.requireUser);

  app.get('/api/me', (req, res) => res.json(mePayload(req.user)));
  app.patch('/api/me', (req, res) => {
    if (String(req.body?.name || '').trim()) db.updateUserName(req.user.id, req.body.name);
    res.json(mePayload(db.getUser(req.user.id)));
  });
  app.post('/api/me/password', wrap(async (req, res) => {
    const row = db.getUserAuth(req.user.id);
    if (!(await auth.verifyPassword(req.body?.current || '', row.password_hash))) return res.status(400).json({ error: 'Current password is wrong' });
    if (String(req.body?.password || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    db.setPassword(req.user.id, await auth.hashPassword(req.body.password)); // logs out other devices
    auth.setSessionCookie(req, res, db.getUser(req.user.id));
    res.json({ ok: true });
  }));
  app.post('/api/me/logout-everywhere', (req, res) => {
    db.bumpTokenVersion(req.user.id);
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.post('/api/family', (req, res) => {
    if (req.user.householdId) return res.status(400).json({ error: 'You are already in a family' });
    db.createHousehold(String(req.body?.name || `${req.user.name}'s family`), req.user.id);
    res.json(mePayload(db.getUser(req.user.id)));
  });
  app.post('/api/family/join', (req, res) => {
    const inv = db.getInvite(req.body?.code || '');
    if (!inv) return res.status(400).json({ error: 'That invite has expired or does not exist' });
    if (req.user.householdId === inv.householdId) return res.json(mePayload(req.user));
    if (req.user.householdId) db.leaveHousehold(req.user.id);
    db.joinHousehold(req.user.id, inv.householdId);
    const user = db.getUser(req.user.id);
    auth.setSessionCookie(req, res, user); // leaving bumped the token version
    res.json(mePayload(user));
  });

  app.use('/api', auth.requireFamily);
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) revisions.set(req.hid, Date.now()); });
    next();
  });

  app.patch('/api/family', (req, res) => {
    if (String(req.body?.name || '').trim()) db.renameHousehold(req.hid, req.body.name);
    res.json(mePayload(req.user));
  });
  app.get('/api/family/invites', (req, res) => res.json(db.listInvites(req.hid)));
  app.post('/api/family/invites', (req, res) => res.json(db.createInvite(req.hid, req.user.id, auth.newInviteCode())));
  app.delete('/api/family/invites/:code', (req, res) => { db.deleteInvite(req.hid, req.params.code); res.json({ ok: true }); });
  app.delete('/api/family/members/:id', auth.requireOwner, (req, res) => {
    const member = db.getUser(id(req));
    if (!member || member.householdId !== req.hid) return res.status(404).json({ error: 'Not in your family' });
    if (member.id === req.user.id) return res.status(400).json({ error: 'Use "Leave family" to remove yourself' });
    db.leaveHousehold(member.id);
    res.json(mePayload(req.user));
  });
  app.post('/api/family/leave', (req, res) => {
    const fam = db.getHousehold(req.hid);
    if (fam.members.length === 1) return res.status(400).json({ error: "You're the only member — invite someone first, or keep the family" });
    db.leaveHousehold(req.user.id);
    const user = db.getUser(req.user.id);
    auth.setSessionCookie(req, res, user);
    res.json(mePayload(user));
  });

  app.get('/api/rev', (req, res) => res.json({ rev: revisions.get(req.hid) || 0 }));
  app.get('/api/status', (req, res) => res.json({
    ai: aiEnabled(), dropbox: dropbox.dropboxStatus(req.hid), supportedExtensions: supportedExtensions(), healthLevels: HEALTH_LEVELS,
    goals: planner.HEALTH_GOALS,
  }));

  // ---------- recipes ----------
  app.get('/api/recipes', (req, res) => res.json(db.listRecipes(req.hid).map(recipeSummary)));

  app.get('/api/recipes/:id', (req, res) => {
    const r = db.getRecipe(req.hid, id(req));
    if (!r) return res.status(404).json({ error: 'Not found' });
    const all = db.listRecipes(req.hid);
    const similar = all.filter((o) => o.id !== r.id)
      .map((o) => ({ id: o.id, title: o.title, ...planner.sharedIngredients(r, o) }))
      .filter((o) => o.shared.length >= 2)
      .sort((a, b) => b.weight - a.weight).slice(0, 5)
      .map((o) => ({ id: o.id, title: o.title, shared: o.shared.map((s) => s.name) }));
    res.json({ ...r, lighterTips: r.health <= 3 ? lighterTips(r.ingredients) : [], autoHealth: scoreHealth(r.title, r.ingredients), similar });
  });

  app.post('/api/recipes', (req, res) => res.json(db.getRecipe(req.hid, db.saveRecipe(req.hid, req.body))));
  app.put('/api/recipes/:id', (req, res) => res.json(db.getRecipe(req.hid, db.saveRecipe(req.hid, req.body, id(req)))));
  app.patch('/api/recipes/:id', (req, res) => { db.patchRecipe(req.hid, id(req), req.body); res.json(db.getRecipe(req.hid, id(req))); });
  app.delete('/api/recipes/:id', (req, res) => { db.deleteRecipe(req.hid, id(req)); res.json({ ok: true }); });
  app.post('/api/recipes/:id/cooked', (req, res) => { db.logCooked(req.hid, id(req), { date: req.body?.date, userId: req.user.id }); res.json({ ok: true }); });

  // ---------- importing ----------
  app.post('/api/import/text', wrap(async (req, res) => {
    const text = String(req.body?.text || '');
    if (!text.trim()) return res.status(400).json({ error: 'Paste a recipe first' });
    const recipes = await extractFromFile('pasted.txt', Buffer.from(text));
    const ids = recipes.filter((r) => r.ingredients?.length).map((r) => db.saveRecipe(req.hid, { ...r, source: 'pasted' }));
    if (!ids.length) return res.status(422).json({ error: "Couldn't find ingredients in that text" });
    res.json({ ids });
  }));

  app.post('/api/import/upload', express.raw({ type: () => true, limit: '25mb' }), wrap(async (req, res) => {
    const name = decodeURIComponent(req.headers['x-filename'] || 'upload.txt');
    const r = await importFile(req.hid, { name, buffer: req.body, source: 'upload' });
    if (r.status === 'empty') return res.status(422).json({ error: `No recipe found in ${name}` });
    res.json(r);
  }));

  app.post('/api/import/url', wrap(async (req, res) => {
    const url = String(req.body?.url || '');
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Enter a full https:// link' });
    const ids = await importUrl(req.hid, url);
    if (!ids.length) return res.status(422).json({ error: "Couldn't find a recipe on that page" });
    res.json({ ids });
  }));

  // ---------- dropbox (shared by the whole family) ----------
  app.get('/api/dropbox', (req, res) => res.json({ ...dropbox.dropboxStatus(req.hid), sync: dropbox.syncStatus(req.hid) }));
  app.post('/api/dropbox/auth/start', (req, res) => res.json({ url: dropbox.startAuth(req.hid, req.body?.appKey) }));
  app.post('/api/dropbox/auth/finish', wrap(async (req, res) => res.json(await dropbox.finishAuth(req.hid, req.user.id, String(req.body?.code || '')))));
  app.post('/api/dropbox/folder', (req, res) => { dropbox.setFolder(req.hid, req.body?.folder); res.json(dropbox.dropboxStatus(req.hid)); });
  app.post('/api/dropbox/disconnect', (req, res) => { dropbox.disconnect(req.hid); res.json(dropbox.dropboxStatus(req.hid)); });
  app.get('/api/dropbox/files', wrap(async (req, res) => {
    const files = await dropbox.listFiles(req.hid);
    res.json(files.map((f) => ({ path: f.path_display, size: f.size })));
  }));
  app.post('/api/dropbox/sync', (req, res) => res.json(dropbox.startSync(req.hid, { force: !!req.body?.force, startedBy: req.user.name })));

  // ---------- plan ----------
  app.get('/api/plan', (req, res) => res.json(planPayload(req.hid)));
  app.post('/api/plan', (req, res) => {
    const ids = req.body.recipeIds || [req.body.recipeId];
    for (const rid of ids) db.addToPlan(req.hid, Number(rid), { ...req.body, userId: req.user.id });
    res.json(planPayload(req.hid));
  });
  app.patch('/api/plan/:id', (req, res) => { db.updatePlanItem(req.hid, id(req), req.body); res.json(planPayload(req.hid)); });
  app.delete('/api/plan/:id', (req, res) => { db.removePlanItem(req.hid, id(req)); res.json(planPayload(req.hid)); });
  app.delete('/api/plan', (req, res) => { db.clearPlan(req.hid); res.json(planPayload(req.hid)); });
  app.post('/api/plan/:id/cooked', (req, res) => {
    const item = db.listPlan(req.hid).find((p) => p.id === id(req));
    if (!item) return res.status(404).json({ error: 'Not in plan' });
    db.logCooked(req.hid, item.recipeId, { date: req.body?.date, userId: req.user.id });
    db.removePlanItem(req.hid, item.id);
    res.json(planPayload(req.hid));
  });

  // ---------- suggestions & memory ----------
  app.get('/api/suggestions', (req, res) => {
    const recipes = db.listRecipes(req.hid);
    const plan = db.listPlan(req.hid);
    const suggested = planner.suggestMeals(recipes, {
      count: Math.min(Number(req.query.count) || 5, 14),
      goal: req.query.goal || 'balanced',
      seedRecipeIds: plan.map((p) => p.recipeId),
      seed: Number(req.query.seed) || Date.now(),
      favoritesWeight: req.query.favorites === 'more' ? 2 : req.query.favorites === 'less' ? 0.3 : 1,
    });
    res.json({ suggested, forgotten: planner.forgottenFavorites(recipes) });
  });

  app.get('/api/history', (req, res) => res.json(db.cookHistory(req.hid, Number(req.query.limit) || 60)));
  app.delete('/api/history/:id', (req, res) => { db.deleteCookEntry(req.hid, id(req)); res.json({ ok: true }); });

  // ---------- shopping ----------
  const shopping = (hid) => {
    const recipes = db.listRecipes(hid);
    return planner.buildShoppingList(db.listPlan(hid), new Map(recipes.map((r) => [r.id, r])), db.getChecks(hid), db.listManual(hid));
  };
  app.get('/api/shopping', (req, res) => res.json(shopping(req.hid)));
  app.post('/api/shopping/check', (req, res) => { db.setCheck(req.hid, String(req.body.key), !!req.body.checked); res.json(shopping(req.hid)); });
  app.post('/api/shopping/manual', (req, res) => {
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Empty item' });
    db.addManual(req.hid, label, categorize(normalizeName(label)), req.user.id);
    res.json(shopping(req.hid));
  });
  app.patch('/api/shopping/manual/:id', (req, res) => { db.updateManual(req.hid, id(req), req.body); res.json(shopping(req.hid)); });
  app.delete('/api/shopping/manual/:id', (req, res) => { db.deleteManual(req.hid, id(req)); res.json(shopping(req.hid)); });
  app.post('/api/shopping/clear-checked', (req, res) => { db.clearCheckedManual(req.hid); res.json(shopping(req.hid)); });

  // ---------- backup ----------
  app.get('/api/export', (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="recipes-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exportedAt: new Date().toISOString(), recipes: db.listRecipes(req.hid), history: db.cookHistory(req.hid, 100000) });
  });

  app.use('/api', (err, req, res, _next) => {
    if (!err.status || err.status >= 500) console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong' });
  });

  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));
  return app;
}
