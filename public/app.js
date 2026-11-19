// Our Meals — single-page app (no build step). The server stores family data; this file computes the plan,
// shopping list, batching and suggestions on the phone, and reads recipe files (PDF/Word/web) locally.
import { buildShoppingList, batchGroups, complementarySuggestions, forgottenFavorites, suggestMeals, sharedIngredients } from './lib/planner.js';
import { lighterTips, scoreHealth } from './lib/health.js';
import { fileToRecipes, browserLibs, textToRecipes, recipesFromJsonLd, htmlToText, isSupported, SUPPORTED } from './lib/extract.js';

const $view = document.getElementById('view');
const $title = document.getElementById('page-title');
const $tabs = document.getElementById('tabs');

const S = { session: null, me: null, family: null, recipes: [], live: null, dropbox: null, route: '', loaded: false, importing: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEALTH = { 1: 'Indulgent', 2: 'Comfort', 3: 'Balanced', 4: 'Healthy', 5: 'Very healthy' };
const healthPill = (h) => `<span class="pill h${h}" title="Healthiness ${h}/5">${HEALTH[h] || '—'}</span>`;
const star = (on) => (on ? '★' : '☆');
const PUBLIC_ROUTES = new Set(['login', 'join', 'welcome']);

function daysAgo(date) {
  if (!date) return 'never cooked';
  const d = Math.round((Date.now() - new Date(`${date}T12:00:00`).getTime()) / 86400000);
  if (d <= 0) return 'cooked today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
}

function toast(msg, ms = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const res = await fetch(`/api${path}`, init);
  if (opts.raw) { if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`); return res; }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) { S.loaded = false; location.hash = '#/login'; throw new Error('Please sign in'); }
  if (res.status === 409 && data.code === 'no_family') { location.hash = '#/welcome'; throw new Error('Please sign in'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { code: data.code });
  return data;
}

function setTitle(t) { $title.textContent = t; document.title = `${t} · Our Meals`; }

// ---------- data ----------
async function loadAll() {
  const st = await api('/state');
  S.me = st.user; S.family = st.family; S.recipes = st.recipes; S.live = st.live; S.dropbox = st.dropbox; S.loaded = true;
}
async function ensureLoaded() { if (!S.loaded) await loadAll(); }
async function applyLive(live) {
  const recipesChanged = S.live && live.recipesVersion !== S.live.recipesVersion;
  S.live = live;
  if (recipesChanged) await loadAll();
}
async function refreshLive() { await applyLive(await api('/state/live')); }

/** Recipes with lastCooked / timesCooked from the shared cooking history. */
function recipesWithStats() {
  const last = new Map(); const count = new Map();
  for (const c of S.live.cookLog) {
    count.set(c.recipeId, (count.get(c.recipeId) || 0) + 1);
    if (!last.has(c.recipeId) || c.cookedOn > last.get(c.recipeId)) last.set(c.recipeId, c.cookedOn);
  }
  return S.recipes.map((r) => ({ ...r, lastCooked: last.get(r.id) || null, timesCooked: count.get(r.id) || 0 }));
}
const byId = (list) => new Map(list.map((r) => [r.id, r]));

function weekDays() {
  const out = []; const start = new Date(); start.setHours(12, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    out.push({ value: d.toISOString().slice(0, 10), label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) });
  }
  return out;
}
const dayLabel = (v) => (v ? new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : 'Any day');

// ---------- sign-in ----------
let gsiPromise;
function loadGoogle() {
  gsiPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = resolve; s.onerror = () => reject(new Error("Couldn't load Google sign-in")); document.head.append(s);
  });
  return gsiPromise;
}

async function renderSignIn(el, extra = () => ({})) {
  const s = S.session;
  if (s.googleClientId) {
    try {
      await loadGoogle();
      google.accounts.id.initialize({
        client_id: s.googleClientId,
        callback: async (resp) => {
          try { await finishSignIn(await api('/auth/google', { body: { credential: resp.credential, ...extra() } })); } catch (err) { showSignInError(err); }
        },
      });
      google.accounts.id.renderButton(el.querySelector('.gsi'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 280 });
    } catch (err) { el.querySelector('.gsi').innerHTML = `<p class="danger small">${esc(err.message)}</p>`; }
  } else {
    el.querySelector('.gsi').innerHTML = '<p class="small muted">Google sign-in isn\'t set up on this server yet (GOOGLE_CLIENT_ID).</p>';
  }
  if (s.devLogin) {
    el.querySelector('.dev').innerHTML = `
      <form data-form="dev-login" class="stack"><p class="small muted">Local testing sign-in</p>
        <input name="name" placeholder="Name" required><input name="email" type="email" placeholder="Email" required>
        <button>Sign in (dev)</button></form>`;
    forms['dev-login'] = async (f) => finishSignIn(await api('/auth/dev', { body: { name: f.name.value, email: f.email.value, ...extra() } })).catch(showSignInError);
  }
}
function showSignInError(err) {
  const box = document.getElementById('signin-error');
  if (box) box.innerHTML = err.code === 'invite_required'
    ? '<p>To join, ask someone in your family for an <strong>invite link</strong> (More → Family → Invite) and open it on this phone.</p>'
    : `<p class="danger">${esc(err.message)}</p>`;
}
async function finishSignIn(me) {
  S.session = await fetch('/api/session').then((r) => r.json());
  S.loaded = false;
  connectLive();
  const next = new URLSearchParams(location.hash.split('?')[1] || '').get('next');
  location.hash = me.family ? (next ? `#${next}` : '#/plan') : '#/welcome';
}

// ---------- views ----------
const views = {};

views.login = async () => {
  setTitle('Our Meals');
  const first = S.session.firstRun;
  $view.innerHTML = `
    <div class="card login">
      <h2>${first ? 'Welcome! Set up your family 🏡' : 'Welcome back 👋'}</h2>
      ${first ? '<p class="muted">You\'re the first one here. Name your family, then sign in. You\'ll be able to invite others after.</p><input id="family-name" placeholder="Family name (e.g. The Smiths)">' : ''}
      <div class="gsi center"></div>
      <div id="signin-error"></div>
      <div class="dev"></div>
      ${first ? '' : '<p class="small muted">New here? Open the invite link someone in your family sent you.</p>'}
    </div>`;
  await renderSignIn($view, () => ({ familyName: document.getElementById('family-name')?.value || undefined }));
};

views.join = async (code) => {
  setTitle('Join family');
  let inv;
  try { inv = await api(`/invites/${encodeURIComponent(code)}`); } catch (err) {
    $view.innerHTML = `<div class="card login"><h2>Invite not valid</h2><p>${esc(err.message)}</p><p class="small">Ask for a new link.</p><a class="btn" href="#/login">Sign in</a></div>`;
    return;
  }
  const intro = `<h2>Join ${esc(inv.familyName)} 🏡</h2><p class="muted">${inv.invitedBy ? `${esc(inv.invitedBy)} invited you to` : "You're invited to"} share recipes, meal plans and shopping lists.</p>`;
  if (S.session.authed) {
    $view.innerHTML = `<div class="card login">${intro}
      ${S.session.hasFamily ? '<p class="small danger">You\'ll leave your current family. Its recipes stay with the people still in it.</p>' : ''}
      <button class="primary" data-action="join-family" data-code="${esc(code)}">Join ${esc(inv.familyName)}</button>
      <a class="btn" href="#/plan">Not now</a></div>`;
  } else {
    $view.innerHTML = `<div class="card login">${intro}<div class="gsi center"></div><div id="signin-error"></div><div class="dev"></div></div>`;
    await renderSignIn($view, () => ({ inviteCode: code }));
  }
};

views.welcome = async () => {
  setTitle('Our Meals');
  const me = await api('/me');
  if (me.family) { location.hash = '#/plan'; return; }
  $view.innerHTML = `
    <div class="card login">
      <h2>Hi ${esc(me.user.name)} 👋</h2>
      <p class="muted">You're not in a family yet. Start one, or join with an invite code.</p>
      <form data-form="create-family" class="stack"><input name="name" placeholder="Family name" value="${esc(me.user.name)}'s family"><button class="primary">Start a family</button></form>
      <form data-form="go-invite" class="row gap"><input name="code" placeholder="Invite code" class="grow" required><button>Join</button></form>
      <button class="link" data-action="logout">Sign out</button>
    </div>`;
};

views.plan = async () => {
  setTitle('This week');
  await ensureLoaded();
  const recipes = recipesWithStats(); const map = byId(recipes);
  const items = S.live.plan.filter((p) => map.has(p.recipeId)).map((p) => ({ ...p, recipe: map.get(p.recipeId) }));
  const planRecipes = items.map((p) => p.recipe);
  const avg = planRecipes.length ? planRecipes.reduce((s, r) => s + r.health, 0) / planRecipes.length : null;
  const batches = batchGroups(planRecipes); const complements = complementarySuggestions(planRecipes, recipes);
  const days = weekDays();
  $view.innerHTML = items.length ? `
      <div class="card summary">
        <div><strong>${items.length}</strong> meal${items.length === 1 ? '' : 's'} planned</div>
        <div class="meter" title="Average healthiness ${avg.toFixed(1)}/5"><span style="width:${(avg / 5) * 100}%"></span></div>
        <div class="muted small">Average: ${HEALTH[Math.round(avg)]} (${avg.toFixed(1)}/5)</div>
        <div class="row gap"><a class="btn primary" href="#/shop">🛒 Shopping list</a><a class="btn" href="#/ideas">💡 More ideas</a></div>
      </div>
      <ul class="list">${items.map((p) => `
          <li class="item plan-item">
            <div class="grow">
              <a href="#/recipe/${p.recipe.id}" class="title">${p.recipe.favorite ? '<span class="fav">★</span> ' : ''}${esc(p.recipe.title)}</a>
              <div class="meta">${healthPill(p.recipe.health)}
                <select data-action="plan-day" data-id="${p.id}" aria-label="Day"><option value="">Any day</option>
                  ${days.map((d) => `<option value="${d.value}" ${d.value === p.plannedFor ? 'selected' : ''}>${d.label}</option>`).join('')}
                  ${p.plannedFor && !days.some((d) => d.value === p.plannedFor) ? `<option value="${p.plannedFor}" selected>${dayLabel(p.plannedFor)}</option>` : ''}
                </select>
                <label class="servings">🍽 <input type="number" min="1" max="30" value="${p.servings || p.recipe.servings}" data-action="plan-servings" data-id="${p.id}" aria-label="Servings"></label>
              </div>
              ${p.addedBy ? `<div class="small muted">added by ${esc(p.addedBy)}</div>` : ''}
            </div>
            <div class="actions">
              <button class="icon" data-action="plan-cooked" data-id="${p.id}" title="We cooked this">✅</button>
              <button class="icon" data-action="plan-remove" data-id="${p.id}" title="Remove">✕</button>
            </div>
          </li>`).join('')}</ul>
      ${batches.length ? `<h3>🍳 Cook these together</h3>${batches.map((b) => `
          <div class="card batch">
            <div class="batch-recipes">${b.recipes.map((r) => `<a href="#/recipe/${r.id}">${esc(r.title)}</a>`).join('<span class="plus">+</span>')}</div>
            <div class="chips">${b.shared.slice(0, 10).map((s) => `<span class="chip">${esc(s.name)} ×${s.recipes.length}</span>`).join('')}</div>
            ${b.tips.map((t) => `<p class="tip">${esc(t)}</p>`).join('')}
          </div>`).join('')}` : ''}
      ${complements.length ? `<h3>♻️ Use up what you're buying</h3><p class="muted small">These recipes reuse ingredients already on your list.</p>
        <ul class="list">${complements.map((c) => `
          <li class="item"><div class="grow"><a href="#/recipe/${c.id}" class="title">${esc(c.title)}</a>
              <div class="meta">${healthPill(c.health)} <span class="small">Shares ${esc(c.shared.slice(0, 4).join(', '))}${c.newItems ? ` · ${c.newItems} new item${c.newItems > 1 ? 's' : ''}` : ' · nothing new to buy'}</span></div></div>
            <button class="icon add" data-action="plan-add" data-recipe="${c.id}" title="Add to plan">＋</button></li>`).join('')}</ul>` : ''}
      <p class="center"><button class="link danger" data-action="plan-clear">Start a new week (clear plan)</button></p>`
    : `<div class="empty card"><h2>Nothing planned yet</h2>
        <p>${S.recipes.length ? 'Let the app pick a week for you, or choose recipes yourself.' : 'Start by importing your recipes from Dropbox.'}</p>
        <div class="row gap center">${S.recipes.length ? '<a class="btn primary" href="#/ideas">💡 Suggest meals</a><a class="btn" href="#/recipes">📖 Pick recipes</a>' : '<a class="btn primary" href="#/more">📦 Import recipes</a>'}</div></div>`;
};

views.ideas = async () => {
  setTitle('Ideas');
  await ensureLoaded();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const goal = q.get('goal') || localStorage.getItem('goal') || 'balanced';
  const count = Number(q.get('count') || localStorage.getItem('count') || 5);
  const favorites = q.get('favorites') || 'normal';
  const seed = Number(q.get('seed')) || Math.floor(Date.now() / 3600000);
  const recipes = recipesWithStats();
  const suggested = suggestMeals(recipes, { count, goal, seed, seedRecipeIds: S.live.plan.map((p) => p.recipeId), favoritesWeight: favorites === 'more' ? 2 : favorites === 'less' ? 0.3 : 1 });
  const forgotten = forgottenFavorites(recipes);
  const goals = { light: '🥗 Light', balanced: '⚖️ Balanced', comfort: '🍝 Comfort', any: '🎲 Anything' };
  $view.innerHTML = `
    <div class="card">
      <div class="label">How healthy this week?</div>
      <div class="segmented">${Object.entries(goals).map(([k, v]) => `<button data-action="ideas-set" data-key="goal" data-value="${k}" class="${k === goal ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="row gap wrap">
        <label>Meals <select data-action="ideas-count">${[2, 3, 4, 5, 6, 7].map((n) => `<option ${n === count ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Favourites <select data-action="ideas-fav">
          <option value="less" ${favorites === 'less' ? 'selected' : ''}>Try new things</option><option value="normal" ${favorites === 'normal' ? 'selected' : ''}>Mix</option>
          <option value="more" ${favorites === 'more' ? 'selected' : ''}>Mostly favourites</option></select></label>
      </div>
    </div>
    ${suggested.length ? `<form data-form="add-suggestions"><ul class="list">${suggested.map((s) => `
          <li class="item"><label class="check"><input type="checkbox" name="r" value="${s.id}" checked></label>
            <div class="grow"><a href="#/recipe/${s.id}" class="title">${s.favorite ? '<span class="fav">★</span> ' : ''}${esc(s.title)}</a>
              <div class="meta">${healthPill(s.health)} <span class="small muted">${esc(daysAgo(s.lastCooked))}</span></div>
              ${s.reasons.length ? `<div class="small reasons">${s.reasons.map(esc).join(' · ')}</div>` : ''}</div></li>`).join('')}</ul>
        <div class="row gap sticky-actions"><button class="primary grow">Add selected to plan</button><button type="button" data-action="ideas-shuffle">🔀 Shuffle</button></div></form>`
      : '<div class="empty card"><p>No recipes yet. <a href="#/more">Import some</a> to get suggestions.</p></div>'}
    ${forgotten.length ? `<h3>⭐ Favourites you haven't had in a while</h3><ul class="list">${forgotten.map((f) => `
        <li class="item"><div class="grow"><a href="#/recipe/${f.id}" class="title">${esc(f.title)}</a>
            <div class="meta">${healthPill(f.health)} <span class="small muted">${f.days == null ? 'not cooked yet' : `last had ${f.days} days ago`}</span></div></div>
          <button class="icon add" data-action="plan-add" data-recipe="${f.id}" title="Add to plan">＋</button></li>`).join('')}</ul>` : ''}`;
};

function shoppingList() {
  return buildShoppingList(S.live.plan, byId(S.recipes), new Set(S.live.checks), S.live.manual);
}

views.shop = async () => {
  setTitle('Shopping');
  await ensureLoaded();
  const list = shoppingList();
  const itemRow = (i) => `
    <li class="shop-item ${i.checked ? 'done' : ''}">
      <label><input type="checkbox" data-action="shop-check" data-key="${esc(i.key)}" ${i.checked ? 'checked' : ''}>
        <span class="name">${esc(i.name)}</span>${i.amount ? `<span class="amt">${esc(i.amount)}</span>` : ''}
        ${i.shared ? `<span class="shared" title="Used in: ${esc(i.meals.join(', '))}">♻️ ${i.meals.length} meals</span>` : ''}</label>
      <div class="for small muted">${esc(i.meals.join(' · '))}</div>
    </li>`;
  const manualRow = (m) => `
    <li class="shop-item ${m.checked ? 'done' : ''}">
      <label><input type="checkbox" data-action="manual-check" data-id="${m.id}" ${m.checked ? 'checked' : ''}><span class="name">${esc(m.label)}</span>${m.addedBy ? `<span class="amt small">${esc(m.addedBy)}</span>` : ''}</label>
      <button class="icon small" data-action="manual-del" data-id="${m.id}" title="Remove">✕</button>
    </li>`;
  $view.innerHTML = `
    <form class="row gap add-item" data-form="manual-add"><input name="label" placeholder="Add something else (e.g. coffee)" autocomplete="off"><button class="primary">Add</button></form>
    ${list.total ? `<div class="progress"><span style="width:${(list.done / list.total) * 100}%"></span></div><p class="small muted" id="shop-progress">${list.done} of ${list.total} in the cart</p>` : ''}
    ${list.groups.length ? list.groups.map((g) => `<h3>${esc(g.category)}</h3><ul class="shop">${g.items.map(itemRow).join('')}${g.manual.map(manualRow).join('')}</ul>`).join('')
      : '<div class="empty card"><p>Your list is empty. <a href="#/plan">Plan some meals</a> and their ingredients show up here automatically.</p></div>'}
    ${list.pantry.length ? `<details class="pantry"><summary>🧂 Check the pantry (${list.pantry.length} staples)</summary><ul class="shop">${list.pantry.map(itemRow).join('')}</ul></details>` : ''}
    ${list.total ? '<div class="row gap center"><button data-action="shop-share">📤 Share list</button><button data-action="shop-clear">Remove checked extras</button></div>' : ''}`;
};

views.recipes = async () => {
  setTitle('Recipes');
  await ensureLoaded();
  const all = recipesWithStats();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const filter = q.get('f') || 'all';
  $view.innerHTML = `
    <div class="row gap"><input type="search" id="recipe-search" placeholder="Search recipes or ingredients…" value="${esc(q.get('q') || '')}" class="grow"><a class="btn primary" href="#/edit/new" title="New recipe">＋</a></div>
    <div class="segmented small">${[['all', 'All'], ['fav', '★ Favourites'], ['healthy', '🥗 Healthy'], ['comfort', '🍝 Comfort'], ['stale', '⏳ Not lately']]
      .map(([k, v]) => `<button data-action="recipes-filter" data-value="${k}" class="${k === filter ? 'on' : ''}">${v}</button>`).join('')}</div>
    <ul class="list" id="recipe-list"></ul>
    ${all.length ? '' : '<div class="empty card"><p>No recipes yet.</p><a class="btn primary" href="#/more">Import from Dropbox</a></div>'}`;
  const render = () => {
    const term = document.getElementById('recipe-search').value.trim().toLowerCase();
    let list = all.filter((r) => !term || r.title.toLowerCase().includes(term) || r.tags.some((t) => t.toLowerCase().includes(term)) || r.ingredients.some((i) => i.name.includes(term)));
    if (filter === 'fav') list = list.filter((r) => r.favorite);
    if (filter === 'healthy') list = list.filter((r) => r.health >= 4);
    if (filter === 'comfort') list = list.filter((r) => r.health <= 2);
    if (filter === 'stale') list = list.filter((r) => !r.lastCooked || (Date.now() - new Date(r.lastCooked)) / 86400000 > 30).sort((a, b) => (a.lastCooked || '').localeCompare(b.lastCooked || ''));
    document.getElementById('recipe-list').innerHTML = list.map((r) => `
      <li class="item">
        <button class="icon fav-toggle ${r.favorite ? 'on' : ''}" data-action="fav" data-id="${r.id}" data-on="${r.favorite ? 1 : 0}" title="Favourite">${star(r.favorite)}</button>
        <div class="grow"><a href="#/recipe/${r.id}" class="title">${esc(r.title)}</a>
          <div class="meta">${healthPill(r.health)} <span class="small muted">${esc(daysAgo(r.lastCooked))}${r.prepMinutes ? ` · ${r.prepMinutes} min` : ''}</span></div></div>
        <button class="icon add" data-action="plan-add" data-recipe="${r.id}" title="Add to plan">＋</button>
      </li>`).join('') || (all.length ? '<li class="muted center">No matches</li>' : '');
  };
  render();
  document.getElementById('recipe-search').addEventListener('input', render);
};

views.recipe = async (rid) => {
  await ensureLoaded();
  const all = recipesWithStats();
  const r = all.find((x) => x.id === Number(rid));
  if (!r) { $view.innerHTML = '<div class="card">Recipe not found. <a href="#/recipes">Back to recipes</a></div>'; return; }
  setTitle(r.title);
  const auto = scoreHealth(r.title, r.ingredients);
  const tips = r.health <= 3 ? lighterTips(r.ingredients) : [];
  const similar = all.filter((o) => o.id !== r.id).map((o) => ({ ...o, ...sharedIngredients(r, o) }))
    .filter((o) => o.shared.length >= 2).sort((a, b) => b.weight - a.weight).slice(0, 5);
  const steps = (r.instructions || '').split('\n').filter(Boolean);
  const fromDropbox = r.sourcePath?.startsWith('dropbox:');
  $view.innerHTML = `
    <div class="card">
      <div class="row between">
        <button class="icon big fav-toggle ${r.favorite ? 'on' : ''}" data-action="fav" data-id="${r.id}" data-on="${r.favorite ? 1 : 0}" title="Favourite">${star(r.favorite)}</button>
        <div class="muted small right">${r.servings} servings${r.prepMinutes ? ` · ${r.prepMinutes} min` : ''}<br>${esc(daysAgo(r.lastCooked))}${r.timesCooked ? ` · made ${r.timesCooked}×` : ''}</div>
      </div>
      <div class="label">Healthiness</div>
      <div class="segmented small">${[1, 2, 3, 4, 5].map((h) => `<button data-action="set-health" data-id="${r.id}" data-value="${h}" class="${h === r.health ? 'on' : ''} h${h}">${HEALTH[h]}</button>`).join('')}</div>
      ${r.healthSource === 'auto' && auto.reasons.length ? `<p class="small muted">Auto-rated: ${esc(auto.reasons.join(', '))}. Tap to change.</p>` : ''}
      ${r.tags.length ? `<div class="chips">${r.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="row gap wrap">
        <button class="primary" data-action="plan-add" data-recipe="${r.id}">＋ Add to plan</button>
        <button data-action="cooked-today" data-id="${r.id}">✅ Cooked today</button>
        <a class="btn" href="#/edit/${r.id}">✏️ Edit</a>
        ${fromDropbox ? `<button data-action="open-original" data-path="${esc(r.sourcePath.replace(/^dropbox:/, '').replace(/#\d+$/, ''))}">📄 Original</button>` : ''}
      </div>
    </div>
    ${tips.length ? `<details class="card tips"><summary>🥗 Make it lighter</summary><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
    <h3>Ingredients</h3>
    <ul class="ingredients">${r.ingredients.map((i) => `<li>${esc(i.raw)}${i.staple ? ' <span class="muted small">(pantry)</span>' : ''}</li>`).join('')}</ul>
    ${steps.length ? `<h3>Method</h3><ol class="steps">${steps.map((s) => `<li>${esc(s.replace(/^\d+[.)]\s*/, ''))}</li>`).join('')}</ol>` : ''}
    ${r.notes ? `<h3>Notes</h3><p class="notes">${esc(r.notes).replace(/\n/g, '<br>')}</p>` : ''}
    ${similar.length ? `<h3>♻️ Batches well with</h3><ul class="list">${similar.map((s) => `
      <li class="item"><div class="grow"><a href="#/recipe/${s.id}" class="title">${esc(s.title)}</a><div class="small muted">Shares ${esc(s.shared.map((x) => x.name).slice(0, 5).join(', '))}</div></div>
      <button class="icon add" data-action="plan-add" data-recipe="${s.id}" title="Add to plan">＋</button></li>`).join('')}</ul>` : ''}
    <p class="small muted">Source: ${esc(r.source)}${r.sourcePath ? ` — ${esc(r.sourcePath.replace(/^dropbox:/, 'Dropbox '))}` : ''}</p>
    <p class="center"><button class="link danger" data-action="recipe-delete" data-id="${r.id}">Delete recipe</button></p>`;
};

views.edit = async (rid) => {
  await ensureLoaded();
  const isNew = rid === 'new';
  const r = isNew ? { title: '', servings: 4, prepMinutes: '', tags: [], ingredients: [], instructions: '', notes: '' } : S.recipes.find((x) => x.id === Number(rid));
  if (!r) { location.hash = '#/recipes'; return; }
  setTitle(isNew ? 'New recipe' : 'Edit recipe');
  $view.innerHTML = `
    <form class="card form" data-form="recipe" data-id="${isNew ? '' : r.id}">
      <label>Title <input name="title" value="${esc(r.title)}" required></label>
      <div class="row gap"><label>Servings <input name="servings" type="number" min="1" value="${esc(r.servings)}"></label>
        <label>Minutes <input name="prepMinutes" type="number" min="0" value="${esc(r.prepMinutes ?? '')}"></label></div>
      <label>Tags <input name="tags" value="${esc(r.tags.join(', '))}" placeholder="mexican, quick, vegetarian"></label>
      <label>Ingredients <span class="muted small">(one per line, e.g. "2 cups rice")</span><textarea name="ingredients" rows="10" required>${esc(r.ingredients.map((i) => i.raw).join('\n'))}</textarea></label>
      <label>Method <textarea name="instructions" rows="8">${esc(r.instructions)}</textarea></label>
      <label>Notes <textarea name="notes" rows="3">${esc(r.notes)}</textarea></label>
      <button class="primary">Save</button>
    </form>`;
};

views.more = async () => {
  setTitle('Import & more');
  await ensureLoaded();
  const [dbx, invites] = await Promise.all([api('/dropbox'), api('/family/invites')]);
  S.dropbox = dbx;
  const me = S.me; const fam = S.family; const owner = me.role === 'owner';
  const iConnected = dbx.connectedBy?.id === me.id;
  const history = S.live.cookLog.slice(0, 20).map((h) => ({ ...h, title: S.recipes.find((r) => r.id === h.recipeId)?.title || 'Deleted recipe' }));
  $view.innerHTML = `
    <div class="card">
      <h2>🏡 ${esc(fam.name)}</h2>
      <ul class="list compact">${fam.members.map((m) => `
        <li class="item"><div class="grow"><strong>${esc(m.name)}</strong>${m.id === me.id ? ' (you)' : ''} ${m.role === 'owner' ? '<span class="chip">owner</span>' : ''}<div class="small muted">${esc(m.email)}</div></div>
        ${owner && m.id !== me.id ? `<button class="icon small" data-action="remove-member" data-id="${m.id}" data-name="${esc(m.name)}" title="Remove from family">✕</button>` : ''}</li>`).join('')}</ul>
      <div class="row gap wrap"><button class="primary" data-action="invite">✉️ Invite someone</button><button data-action="rename-family">Rename</button></div>
      <div id="invite-box"></div>
      ${invites.length ? `<details class="small"><summary>${invites.length} open invite${invites.length > 1 ? 's' : ''}</summary><ul class="list compact">${invites.map((i) => `
        <li class="item"><div class="grow"><code>${esc(i.code)}</code> <span class="muted">by ${esc(i.createdBy || '?')}, expires ${new Date(i.expiresAt).toLocaleDateString()}</span></div>
        <button class="icon small" data-action="cancel-invite" data-code="${esc(i.code)}" title="Cancel invite">✕</button></li>`).join('')}</ul></details>` : ''}
      <p class="small muted">Everyone in the family shares recipes, the plan, the shopping list, favourites and the Dropbox connection.</p>
    </div>

    <div class="card">
      <h2>📦 Dropbox recipes</h2>
      ${dbx.connected ? `
        <p>Connected${dbx.account ? ` to <strong>${esc(dbx.account)}</strong>'s Dropbox` : ''}${dbx.connectedBy ? ` by ${esc(dbx.connectedBy.name)}` : ''} — shared with everyone in ${esc(fam.name)}.</p>
        ${iConnected ? `<form class="row gap" data-form="dropbox-folder"><input name="folder" value="${esc(dbx.folder)}" placeholder="/Recipes" class="grow" aria-label="Dropbox folder"><button>Save folder</button></form>
          <div class="row gap"><button type="button" data-action="browse-open">📁 Browse folders…</button></div>
          <div id="folder-browser"></div>
          <p class="small muted">Only files inside this folder (and its subfolders) can be read by your family.</p>`
          : `<p class="small">Folder: <code>${esc(dbx.folder || '/')}</code> <span class="muted">(only ${esc(dbx.connectedBy?.name || 'the person who connected it')} can change it)</span></p>`}
        <div class="row gap wrap">
          <button class="primary" data-action="dropbox-import" ${S.importing ? 'disabled' : ''}>⬇️ Import new recipes</button>
          ${iConnected || owner ? '<button class="link" data-action="dropbox-disconnect">Disconnect</button>' : ''}
        </div>
        <div id="import-status">${importStatusHtml()}</div>
        ${dbx.lastImport && !S.importing ? `<p class="small muted">Last import ${new Date(dbx.lastImport.at).toLocaleString()} by ${esc(dbx.lastImport.by)}: ${dbx.lastImport.imported} new${dbx.lastImport.failed ? `, ${dbx.lastImport.failed} couldn't be read` : ''}.</p>` : ''}
      ` : `
        <p class="small">Connect once and everyone in your family can import from it. The access key stays on the server.</p>
        <ol class="steps small">
          <li>Go to <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">dropbox.com/developers/apps</a> → <em>Create app</em> → <em>Scoped access</em> → <em>Full Dropbox</em>.</li>
          <li>On the <em>Permissions</em> tab tick <code>files.content.read</code> and press <em>Submit</em>.</li>
          <li>Copy the <em>App key</em> from the Settings tab${dbx.appKeyFromEnv ? ' (already set on the server)' : ''}.</li>
        </ol>
        <form data-form="dropbox-start" class="row gap">${dbx.appKeyFromEnv ? '' : '<input name="appKey" placeholder="Dropbox app key" class="grow" required>'}<button class="primary">Connect Dropbox</button></form>
        ${sessionStorage.getItem('dropboxAwaitingCode') ? '<p class="small"><strong>Step 2:</strong> after you tap <em>Allow</em> in Dropbox, copy the code it shows and paste it here.</p>' : ''}
        <form data-form="dropbox-finish" class="row gap" id="dropbox-code" ${sessionStorage.getItem('dropboxAwaitingCode') ? '' : 'hidden'}><input name="code" placeholder="Paste the code Dropbox shows you" class="grow" required><button class="primary">Finish</button></form>`}
      <p class="small muted">Reads PDFs (with text inside), Word (.docx), web pages, text and Markdown files on this phone. Scanned PDFs are listed separately for now.</p>
    </div>

    <div class="card">
      <h2>➕ Add recipes other ways</h2>
      <label class="label">Upload files</label>
      <input type="file" id="upload" multiple accept="${esc(SUPPORTED.join(','))}">
      <form data-form="import-url" class="row gap"><input name="url" type="url" placeholder="Paste a recipe web link" class="grow"><button>Import</button></form>
      <form data-form="import-text"><textarea name="text" rows="5" placeholder="…or paste a recipe (title, ingredients, method)"></textarea><button>Add pasted recipe</button></form>
    </div>

    <div class="card">
      <h2>🕑 Recently cooked</h2>
      ${history.length ? `<ul class="list compact">${history.map((h) => `
        <li class="item"><div class="grow"><a href="#/recipe/${h.recipeId}">${esc(h.title)}</a> <span class="small muted">${esc(h.cookedOn)}${h.cookedBy ? ` · ${esc(h.cookedBy)}` : ''}</span></div>
        <button class="icon small" data-action="history-del" data-id="${h.id}" title="Remove">✕</button></li>`).join('')}</ul>`
        : '<p class="muted">Tap ✅ on a planned meal after you cook it — the app uses this to remember favourites you haven\'t had in a while.</p>'}
    </div>

    <div class="card">
      <h2>👤 ${esc(me.name)}</h2>
      <p class="small muted">${esc(me.email)} · signed in with Google</p>
      <form data-form="rename-me" class="row gap"><input name="name" value="${esc(me.name)}" class="grow" required aria-label="Your name"><button>Save name</button></form>
      <div class="row gap wrap">
        <a class="btn" href="/api/export">💾 Download backup</a>
        <button data-action="logout">Sign out</button>
        <button class="link" data-action="logout-everywhere">Sign out on all devices</button>
        <button class="link danger" data-action="leave-family">Leave family</button>
      </div>
      <p class="small muted">Tip: open this page in Chrome and choose <em>Add to Home screen</em> to use it like an app.</p>
    </div>`;
};

// ---------- importing (runs on this phone) ----------
function importStatusHtml() {
  const j = S.importing;
  if (!j) return '';
  const pct = j.total ? (j.done / j.total) * 100 : 3;
  return `<div class="progress"><span style="width:${pct}%"></span></div>
    <p class="small">${j.finished ? 'Done' : 'Importing'} ${j.done}/${j.total}${j.current && !j.finished ? ` — ${esc(j.current)}` : ''}. ${j.imported} recipe${j.imported === 1 ? '' : 's'} added.
    ${j.finished ? '' : '<br><span class="muted">Keep this screen open until it finishes.</span>'}</p>
    ${j.problems.length ? `<details class="small"><summary>${j.problems.length} file${j.problems.length > 1 ? 's' : ''} couldn't be read</summary><ul>${j.problems.map((p) => `<li>${esc(p.file)}: ${esc(p.detail)}</li>`).join('')}</ul></details>` : ''}`;
}
function updateImportStatus() { const el = document.getElementById('import-status'); if (el) el.innerHTML = importStatusHtml(); }

async function runDropboxImport() {
  const { pending, failed } = await api('/dropbox/pending');
  const files = pending.filter((f) => isSupported(f.name));
  const job = S.importing = { total: files.length, done: 0, imported: 0, problems: [], current: null, finished: false };
  updateImportStatus();
  let lock; try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  try {
    const libs = await browserLibs();
    for (const f of files) {
      job.current = f.path; updateImportStatus();
      const sourcePath = `dropbox:${f.lower}`;
      try {
        const res = await api('/dropbox/download', { body: { path: f.lower }, raw: true });
        const r = await fileToRecipes(f.name, await res.arrayBuffer(), libs);
        if (r.status === 'ok') {
          const { ids } = await api('/import', { body: { recipes: r.recipes, sourcePath, sourceRev: f.rev, source: 'dropbox' } });
          job.imported += ids.length;
        } else {
          job.problems.push({ file: f.path, detail: r.detail });
          await api('/import/failed', { body: { sourcePath, status: r.status, detail: r.detail } });
        }
      } catch (err) {
        job.problems.push({ file: f.path, detail: err.message });
        await api('/import/failed', { body: { sourcePath, status: 'error', detail: err.message } }).catch(() => {});
      }
      job.done++; updateImportStatus();
    }
  } finally {
    job.finished = true; lock?.release?.();
    await api('/dropbox/finished', { body: { imported: job.imported, failed: job.problems.length } }).catch(() => {});
    await loadAll();
    toast(`Imported ${job.imported} recipe${job.imported === 1 ? '' : 's'}${failed.length ? ` (${failed.length} skipped earlier)` : ''}`, 4000);
    S.importing = null;
    if (state('more')) {
      await render();
      if (failed.length || job.problems.length) showFailedNote(failed.length + job.problems.length);
    }
  }
}
function showFailedNote(n) {
  const el = document.getElementById('import-status');
  if (el) el.insertAdjacentHTML('beforeend', `<p class="small">${n} file${n > 1 ? 's' : ''} couldn't be read (often scanned PDFs). <button class="link" data-action="dropbox-retry">Try them again</button></p>`);
}
const state = (route) => S.route === route;

async function importFiles(fileList) {
  const libs = await browserLibs();
  let added = 0; const problems = [];
  for (const file of fileList) {
    toast(`Reading ${file.name}…`, 10000);
    try {
      const r = await fileToRecipes(file.name, await file.arrayBuffer(), libs);
      if (r.status !== 'ok') { problems.push(`${file.name}: ${r.detail}`); continue; }
      added += (await api('/import', { body: { recipes: r.recipes, source: 'upload' } })).ids.length;
    } catch (err) { problems.push(`${file.name}: ${err.message}`); }
  }
  await loadAll();
  toast(`Added ${added} recipe${added === 1 ? '' : 's'}${problems.length ? ` — ${problems.length} file(s) couldn't be read` : ''}`, 4000);
  if (problems.length) alert(problems.join('\n'));
  document.getElementById('upload').value = '';
}

// ---------- Dropbox folder browser (only for the person who connected Dropbox) ----------
async function loadBrowse(path) {
  const box = document.getElementById('folder-browser');
  if (!box) return;
  box.innerHTML = '<p class="small muted">Loading folders…</p>';
  let data; let note = '';
  try { data = await api(`/dropbox/folders?path=${encodeURIComponent(path || '')}`); } catch (err) {
    if (!/not found/i.test(err.message) || !path) throw err;
    data = await api('/dropbox/folders?path='); note = `<p class="small danger">"${esc(path)}" wasn't found, so here's the top of your Dropbox.</p>`;
  }
  const here = data.path || '';
  box.innerHTML = `
    <div class="browser">
      <div class="row between"><strong class="grow">📁 ${esc(here || 'Your Dropbox (top level)')}</strong><button type="button" class="icon small" data-action="browse-close" title="Close">✕</button></div>
      ${note}
      ${data.parent != null ? `<button type="button" class="link" data-action="browse-into" data-path="${esc(data.parent)}">⬆ Up to ${esc(data.parent || 'top level')}</button>` : ''}
      ${data.folders.length ? `<ul class="list compact">${data.folders.map((f) => `
        <li class="item"><button type="button" class="link grow left" data-action="browse-into" data-path="${esc(f.path)}">📁 ${esc(f.name)}</button></li>`).join('')}</ul>`
        : '<p class="small muted">No subfolders here.</p>'}
      <p class="small">${data.recipeFiles} recipe file${data.recipeFiles === 1 ? '' : 's'} directly in this folder${data.otherFiles ? ` (plus ${data.otherFiles} other file${data.otherFiles === 1 ? '' : 's'})` : ''}. Subfolders are included when importing.</p>
      <button type="button" class="primary" data-action="browse-use" data-path="${esc(here)}">Use this folder</button>
    </div>`;
}

// ---------- actions ----------
const live = async (p) => { await applyLive(await p); };
const actions = {
  'browse-open': () => loadBrowse(document.querySelector('[data-form="dropbox-folder"] input[name=folder]')?.value || S.dropbox?.folder || ''),
  'browse-into': (el) => loadBrowse(el.dataset.path),
  'browse-close': () => { document.getElementById('folder-browser').innerHTML = ''; },
  'browse-use': async (el) => {
    const folder = el.dataset.path;
    if (!folder && !confirm('Use your entire Dropbox? Your family would be able to read every file in it. A recipe folder is usually better.')) return;
    await api('/dropbox/folder', { body: { folder } });
    toast(`Folder set to ${folder || 'your whole Dropbox'}`); render();
  },
  'plan-add': async (el) => { await live(api('/plan', { body: { recipeId: Number(el.dataset.recipe) } })); toast('Added to this week ✓'); if (state('plan')) render(); },
  'plan-remove': async (el) => { await live(api(`/plan/${el.dataset.id}`, { method: 'DELETE' })); render(); },
  'plan-cooked': async (el) => { await live(api(`/plan/${el.dataset.id}/cooked`, { body: {} })); toast('Nice! Logged as cooked 🍽'); render(); },
  'plan-clear': async () => { if (confirm('Clear the whole plan and shopping ticks?')) { await live(api('/plan', { method: 'DELETE' })); render(); } },
  fav: async (el) => {
    const on = el.dataset.on !== '1';
    await api(`/recipes/${el.dataset.id}`, { method: 'PATCH', body: { favorite: on } });
    const r = S.recipes.find((x) => x.id === Number(el.dataset.id)); if (r) r.favorite = on;
    el.dataset.on = on ? '1' : '0'; el.textContent = star(on); el.classList.toggle('on', on);
  },
  'set-health': async (el) => { await api(`/recipes/${el.dataset.id}`, { method: 'PATCH', body: { health: Number(el.dataset.value) } }); await loadAll(); render(); },
  'cooked-today': async (el) => { await live(api(`/recipes/${el.dataset.id}/cooked`, { body: {} })); toast('Logged as cooked today'); render(); },
  'recipe-delete': async (el) => { if (confirm('Delete this recipe?')) { await api(`/recipes/${el.dataset.id}`, { method: 'DELETE' }); await loadAll(); location.hash = '#/recipes'; } },
  'open-original': async (el) => {
    const win = window.open('', '_blank');
    const res = await api('/dropbox/download', { body: { path: el.dataset.path }, raw: true });
    const type = /\.pdf$/i.test(el.dataset.path) ? 'application/pdf' : 'text/plain';
    const url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
    if (win) win.location = url; else location.href = url;
  },
  'recipes-filter': (el) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); q.set('f', el.dataset.value); q.set('q', document.getElementById('recipe-search').value); location.hash = `#/recipes?${q}`; },
  'ideas-set': (el) => { localStorage.setItem(el.dataset.key, el.dataset.value); setIdeas({ [el.dataset.key]: el.dataset.value }); },
  'ideas-shuffle': () => setIdeas({ seed: String(Math.floor(Math.random() * 1e9)) }),
  'shop-share': async () => {
    const l = shoppingList(); const lines = [];
    for (const g of l.groups) {
      const todo = [...g.items.filter((i) => !i.checked).map((i) => `${i.name}${i.amount ? ` (${i.amount})` : ''}`), ...g.manual.filter((m) => !m.checked).map((m) => m.label)];
      if (todo.length) lines.push(`${g.category}:`, ...todo.map((t) => `• ${t}`), '');
    }
    const text = lines.join('\n') || 'All done!';
    if (navigator.share) { try { await navigator.share({ title: 'Shopping list', text }); return; } catch { /* cancelled */ } }
    await navigator.clipboard.writeText(text); toast('Copied to clipboard');
  },
  'shop-clear': async () => { await live(api('/shopping/clear-checked', { body: {} })); render(); },
  'manual-del': async (el) => { await live(api(`/shopping/manual/${el.dataset.id}`, { method: 'DELETE' })); render(); },
  'history-del': async (el) => { await live(api(`/history/${el.dataset.id}`, { method: 'DELETE' })); render(); },
  'dropbox-import': async () => { if (!S.importing) { render(); await runDropboxImport(); } },
  'dropbox-retry': async () => { await api('/dropbox/retry-failed', { body: {} }); await runDropboxImport(); },
  'dropbox-disconnect': async () => { if (confirm('Disconnect Dropbox? Imported recipes stay.')) { await api('/dropbox/disconnect', { body: {} }); render(); } },
  logout: async () => { await api('/auth/logout', { body: {} }); S.loaded = false; disconnectLive(); location.hash = '#/login'; S.session.authed = false; },
  'logout-everywhere': async () => { if (confirm('Sign out on every phone and computer?')) { await api('/me/logout-everywhere', { body: {} }); S.loaded = false; disconnectLive(); location.hash = '#/login'; } },
  'leave-family': async () => { if (confirm('Leave this family? You will lose access to its recipes and plans.')) { await api('/family/leave', { body: {} }); S.loaded = false; location.hash = '#/welcome'; } },
  'join-family': async (el) => { await api('/family/join', { body: { code: el.dataset.code } }); S.loaded = false; S.session.hasFamily = true; connectLive(); toast('Welcome to the family 🎉'); location.hash = '#/plan'; },
  'remove-member': async (el) => { if (confirm(`Remove ${el.dataset.name} from the family?`)) { await api(`/family/members/${el.dataset.id}`, { method: 'DELETE' }); await loadAll(); render(); } },
  'rename-family': async () => { const name = prompt('Family name', S.family.name); if (name?.trim()) { await api('/family', { method: 'PATCH', body: { name } }); await loadAll(); render(); } },
  'cancel-invite': async (el) => { await api(`/family/invites/${encodeURIComponent(el.dataset.code)}`, { method: 'DELETE' }); render(); },
  invite: async () => {
    const inv = await api('/family/invites', { body: {} });
    const url = `${location.origin}/#/join/${inv.code}`;
    document.getElementById('invite-box').innerHTML = `
      <div class="invite"><p class="small">Send this link (valid 7 days). They sign in with Google and join your family:</p>
      <input readonly value="${esc(url)}" onclick="this.select()">
      <div class="row gap"><button class="primary" data-action="share-invite" data-url="${esc(url)}">📤 Share</button><span class="small muted">Code: <code>${esc(inv.code)}</code></span></div>
      ${S.session.googleClientId ? '<p class="small muted">While your Google sign-in is in "Testing", also add their Gmail under Google Auth Platform → Audience → Test users.</p>' : ''}</div>`;
  },
  'share-invite': async (el) => {
    const text = `Join our family meal planner: ${el.dataset.url}`;
    if (navigator.share) { try { await navigator.share({ title: 'Our Meals', text, url: el.dataset.url }); return; } catch { /* cancelled */ } }
    await navigator.clipboard.writeText(el.dataset.url); toast('Link copied');
  },
};

const changeActions = {
  'plan-day': (el) => live(api(`/plan/${el.dataset.id}`, { method: 'PATCH', body: { plannedFor: el.value } })),
  'plan-servings': (el) => live(api(`/plan/${el.dataset.id}`, { method: 'PATCH', body: { servings: Number(el.value) } })),
  'shop-check': async (el) => {
    el.closest('li').classList.toggle('done', el.checked);
    const key = el.dataset.key; const checks = new Set(S.live.checks);
    if (el.checked) checks.add(key); else checks.delete(key);
    S.live.checks = [...checks]; updateProgress(); // optimistic
    await live(api('/shopping/check', { body: { key, checked: el.checked } }));
  },
  'manual-check': async (el) => {
    el.closest('li').classList.toggle('done', el.checked);
    const m = S.live.manual.find((x) => x.id === Number(el.dataset.id)); if (m) m.checked = el.checked; updateProgress();
    await live(api(`/shopping/manual/${el.dataset.id}`, { method: 'PATCH', body: { checked: el.checked } }));
  },
  'ideas-count': (el) => { localStorage.setItem('count', el.value); setIdeas({ count: el.value }); },
  'ideas-fav': (el) => setIdeas({ favorites: el.value }),
};

function updateProgress() {
  const l = shoppingList(); const bar = document.querySelector('.progress span'); const p = document.getElementById('shop-progress');
  if (bar && l.total) bar.style.width = `${(l.done / l.total) * 100}%`;
  if (p) p.textContent = `${l.done} of ${l.total} in the cart`;
}
function setIdeas(patch) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  for (const [k, v] of Object.entries(patch)) q.set(k, v);
  if (!patch.seed) q.delete('seed');
  location.hash = `#/ideas?${q}`;
}

const forms = {
  'add-suggestions': async (f) => {
    const ids = [...f.querySelectorAll('input[name=r]:checked')].map((i) => Number(i.value));
    if (!ids.length) return toast('Tick at least one meal');
    await live(api('/plan', { body: { recipeIds: ids } }));
    toast(`Added ${ids.length} meal${ids.length > 1 ? 's' : ''} ✓`); location.hash = '#/plan';
  },
  'manual-add': async (f) => { if (!f.label.value.trim()) return; await live(api('/shopping/manual', { body: { label: f.label.value } })); f.label.value = ''; render(); },
  recipe: async (f) => {
    const body = {
      title: f.title.value, servings: Number(f.servings.value) || 4, prepMinutes: f.prepMinutes.value,
      tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      ingredients: f.ingredients.value.split('\n').map((l) => l.trim()).filter(Boolean),
      instructions: f.instructions.value, notes: f.notes.value,
    };
    const { id } = f.dataset.id ? await api(`/recipes/${f.dataset.id}`, { method: 'PUT', body }) : await api('/recipes', { body });
    await loadAll(); toast('Saved'); location.hash = `#/recipe/${id}`;
  },
  'go-invite': (f) => { location.hash = `#/join/${encodeURIComponent(f.code.value.trim().toUpperCase())}`; },
  'create-family': async (f) => { await api('/family', { body: { name: f.name.value } }); S.loaded = false; S.session.hasFamily = true; connectLive(); location.hash = '#/plan'; },
  'rename-me': async (f) => { await api('/me', { method: 'PATCH', body: { name: f.name.value } }); await loadAll(); toast('Saved'); render(); },
  'dropbox-start': async (f) => {
    const { url } = await api('/dropbox/auth/start', { body: { appKey: f.appKey?.value } });
    window.open(url, '_blank', 'noopener');
    // Remember we're waiting for the code: coming back from the Dropbox tab refreshes this screen.
    sessionStorage.setItem('dropboxAwaitingCode', '1');
    document.getElementById('dropbox-code').hidden = false;
    toast('Approve access in Dropbox, then paste the code here', 5000);
  },
  'dropbox-finish': async (f) => {
    await api('/dropbox/auth/finish', { body: { code: f.code.value } });
    sessionStorage.removeItem('dropboxAwaitingCode');
    toast('Dropbox connected 🎉'); render();
  },
  'dropbox-folder': async (f) => { await api('/dropbox/folder', { body: { folder: f.folder.value } }); toast('Folder saved'); render(); },
  'import-url': async (f) => {
    toast('Fetching…');
    const { html } = await api('/fetch-page', { body: { url: f.url.value } });
    const ld = recipesFromJsonLd(html);
    const recipes = ld.length ? ld : textToRecipes(htmlToText(html), 'Web recipe');
    if (!recipes.length) throw new Error("Couldn't find a recipe on that page");
    const { ids } = await api('/import', { body: { recipes: recipes.map((r) => ({ ...r, notes: [r.notes, `Source: ${f.url.value}`].filter(Boolean).join('\n') })), source: 'web' } });
    await loadAll(); location.hash = `#/recipe/${ids[0]}`;
  },
  'import-text': async (f) => {
    const recipes = textToRecipes(f.text.value, 'Pasted recipe');
    if (!recipes.length) throw new Error("Couldn't find ingredients in that text — put each ingredient on its own line");
    const { ids } = await api('/import', { body: { recipes, source: 'pasted' } });
    await loadAll(); location.hash = `#/recipe/${ids[0]}`;
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT' || !actions[el.dataset.action]) return;
  e.preventDefault(); el.disabled = true;
  try { await actions[el.dataset.action](el); } catch (err) { if (err.message !== 'Please sign in') toast(err.message, 4000); } finally { el.disabled = false; }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'upload') return importFiles(el.files);
  const fn = changeActions[el.dataset?.action];
  if (fn) { try { await fn(el); } catch (err) { toast(err.message, 4000); } }
});
document.addEventListener('submit', async (e) => {
  const f = e.target; const fn = forms[f.dataset.form];
  if (!fn) return;
  e.preventDefault();
  const btn = f.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
  try { await fn(f); } catch (err) { if (err.message !== 'Please sign in') toast(err.message, 4000); } finally { if (btn) btn.disabled = false; }
});

// ---------- live updates from the rest of the family ----------
let ws; let wsRetry = 1000; let wsTimer; let pingTimer; let refreshTimer;
function connectLive() {
  if (!S.session?.authed || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`); } catch { return; }
  ws.onopen = () => { wsRetry = 1000; clearInterval(pingTimer); pingTimer = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 30000); };
  ws.onmessage = (ev) => { if (ev.data !== 'pong') scheduleRefresh(); };
  ws.onclose = () => { clearInterval(pingTimer); if (S.session?.authed) { clearTimeout(wsTimer); wsTimer = setTimeout(connectLive, wsRetry); wsRetry = Math.min(wsRetry * 2, 60000); } };
}
function disconnectLive() { S.session && (S.session.authed = false); clearTimeout(wsTimer); ws?.close(); }
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!S.loaded || PUBLIC_ROUTES.has(S.route) || S.route === 'edit') return;
    try {
      await refreshLive();
      // Don't yank the screen while someone is typing or an import is running.
      if (!document.activeElement?.matches('input:not([type=checkbox]), textarea, select') && !S.importing) { const y = window.scrollY; await render(); window.scrollTo(0, y); }
    } catch { /* offline */ }
  }, 300);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { connectLive(); scheduleRefresh(); } });

// ---------- routing ----------
async function render() {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, arg] = path.split('/');
  const route = views[name] ? name : 'plan';
  S.route = route;
  $tabs.hidden = PUBLIC_ROUTES.has(route);
  const tab = { recipe: 'recipes', edit: 'recipes' }[route] || route;
  $tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  try { await views[route](arg); } catch (err) {
    if (err.message !== 'Please sign in') $view.innerHTML = `<div class="card error">⚠️ ${esc(err.message)}</div>`;
  }
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

(async () => {
  S.session = await fetch('/api/session').then((r) => r.json()).catch(() => ({ authed: false }));
  const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  let target = null;
  if (route === 'join') target = null; // invite links work signed in or out
  else if (!S.session.authed) target = '#/login';
  else if (!S.session.hasFamily) target = '#/welcome';
  else if (!route || PUBLIC_ROUTES.has(route)) target = '#/plan';
  if (target && target !== location.hash) location.hash = target; else render();
  if (S.session.authed) connectLive();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
