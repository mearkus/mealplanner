// Our Meals — single-page app, no build step.
const $view = document.getElementById('view');
const $title = document.getElementById('page-title');
const $tabs = document.getElementById('tabs');

const state = { status: null, rev: 0, route: '', recipesCache: null };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEALTH = { 1: 'Indulgent', 2: 'Comfort', 3: 'Balanced', 4: 'Healthy', 5: 'Very healthy' };
const healthPill = (h) => `<span class="pill h${h}" title="Healthiness ${h}/5">${HEALTH[h] || '—'}</span>`;
const star = (on) => (on ? '★' : '☆');

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
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: { ...(opts.headers || {}) } };
  if (opts.body !== undefined && !(opts.body instanceof Blob) && !(opts.body instanceof ArrayBuffer)) {
    init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body);
  } else if (opts.body !== undefined) init.body = opts.body;
  const res = await fetch(`/api${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/') && !path.startsWith('/me/password')) { location.hash = '#/login'; throw new Error('Please log in'); }
  if (res.status === 409 && data.code === 'no_family') { location.hash = '#/welcome'; throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  if (init.method !== 'GET') state.recipesCache = null;
  return data;
}

function setTitle(t) { $title.textContent = t; document.title = `${t} · Our Meals`; }

function weekDays() {
  const out = [];
  const start = new Date(); start.setHours(12, 0, 0, 0);
  for (let i = 0; i < 14; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    out.push({ value: d.toISOString().slice(0, 10), label: d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) });
  }
  return out;
}
const dayLabel = (v) => (v ? new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) : 'Any day');

async function recipes() {
  if (!state.recipesCache) state.recipesCache = await api('/recipes');
  return state.recipesCache;
}

// ---------- views ----------
const views = {};

const PUBLIC_ROUTES = new Set(['login', 'signup', 'join', 'welcome']);

views.login = async () => {
  setTitle('Our Meals');
  $view.innerHTML = `
    <form class="card login" data-form="login">
      <h2>Welcome back 👋</h2>
      <input type="email" name="email" autocomplete="username" placeholder="Email" required autofocus>
      <input type="password" name="password" autocomplete="current-password" placeholder="Password" required>
      <button class="primary">Log in</button>
      <p class="small muted">New here? <a href="#/signup">Create an account</a></p>
    </form>`;
};

function signupFields() {
  return `
    <input name="name" autocomplete="name" placeholder="Your first name" required>
    <input type="email" name="email" autocomplete="username" placeholder="Email" required>
    <input type="password" name="password" autocomplete="new-password" placeholder="Password (8+ characters)" minlength="8" required>`;
}

views.signup = async () => {
  setTitle('Our Meals');
  const s = await fetch('/api/session').then((r) => r.json());
  const canStart = s.firstRun || s.openSignup || s.signupCodeRequired;
  $view.innerHTML = `
    <div class="card login">
      <h2>Create your account</h2>
      ${canStart ? `
        <form data-form="signup" class="stack">
          ${signupFields()}
          <input name="familyName" placeholder="Family name (e.g. The Smiths)">
          ${s.signupCodeRequired && !s.firstRun ? '<input name="signupCode" placeholder="Sign-up code from whoever runs this server" required>' : ''}
          <button class="primary">Create account & family</button>
        </form>
        <p class="small muted">Joining someone's family? Open the invite link they sent you instead.</p>` : `
        <p>To join, ask someone in your family for an <strong>invite link</strong> (More → Family → Invite) and open it on this device.</p>
        <form data-form="go-invite" class="row gap"><input name="code" placeholder="…or type the invite code" class="grow" required><button>Go</button></form>`}
      <p class="small muted">Already have an account? <a href="#/login">Log in</a></p>
    </div>`;
};

views.join = async (code) => {
  setTitle('Join family');
  let inv;
  try { inv = await api(`/invites/${encodeURIComponent(code)}`); } catch (err) {
    $view.innerHTML = `<div class="card login"><h2>Invite not valid</h2><p>${esc(err.message)}</p><p class="small">Ask for a new link.</p><a class="btn" href="#/login">Log in</a></div>`;
    return;
  }
  const s = await fetch('/api/session').then((r) => r.json());
  const intro = `<h2>Join ${esc(inv.familyName)} 🏡</h2><p class="muted">${inv.invitedBy ? `${esc(inv.invitedBy)} invited you to` : 'You\'re invited to'} share recipes, meal plans and shopping lists.</p>`;
  if (s.authed) {
    $view.innerHTML = `<div class="card login">${intro}
      ${s.hasFamily ? '<p class="small danger">You\'ll leave your current family. Its recipes stay with the people still in it.</p>' : ''}
      <button class="primary" data-action="join-family" data-code="${esc(code)}">Join ${esc(inv.familyName)}</button>
      <a class="btn" href="#/plan">Not now</a></div>`;
  } else {
    $view.innerHTML = `<div class="card login">${intro}
      <form data-form="signup" class="stack"><input type="hidden" name="inviteCode" value="${esc(code)}">${signupFields()}
        <button class="primary">Create account & join</button></form>
      <p class="small muted">Already have an account? <a href="#/login?next=${encodeURIComponent(`/join/${code}`)}">Log in to join</a></p></div>`;
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
      <button class="link" data-action="logout">Log out</button>
    </div>`;
};

views.plan = async () => {
  setTitle('This week');
  const plan = await api('/plan');
  const avg = plan.healthAvg;
  const byDay = [...plan.items].sort((a, b) => (a.plannedFor || '9999').localeCompare(b.plannedFor || '9999'));
  const days = weekDays();
  $view.innerHTML = `
    ${plan.items.length ? `
      <div class="card summary">
        <div><strong>${plan.items.length}</strong> meal${plan.items.length === 1 ? '' : 's'} planned</div>
        ${avg ? `<div class="meter" title="Average healthiness ${avg.toFixed(1)}/5"><span style="width:${(avg / 5) * 100}%"></span></div>
        <div class="muted small">Average: ${HEALTH[Math.round(avg)]} (${avg.toFixed(1)}/5)</div>` : ''}
        <div class="row gap">
          <a class="btn primary" href="#/shop">🛒 Shopping list</a>
          <a class="btn" href="#/ideas">💡 More ideas</a>
        </div>
      </div>
      <ul class="list">
        ${byDay.map((p) => `
          <li class="item plan-item">
            <div class="grow">
              <a href="#/recipe/${p.recipe.id}" class="title">${p.recipe.favorite ? '<span class="fav">★</span> ' : ''}${esc(p.recipe.title)}</a>
              <div class="meta">${healthPill(p.recipe.health)}
                <select data-action="plan-day" data-id="${p.id}" aria-label="Day">
                  <option value="">Any day</option>
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
          </li>`).join('')}
      </ul>
      ${plan.batches.length ? `
        <h3>🍳 Cook these together</h3>
        ${plan.batches.map((b) => `
          <div class="card batch">
            <div class="batch-recipes">${b.recipes.map((r) => `<a href="#/recipe/${r.id}">${esc(r.title)}</a>`).join('<span class="plus">+</span>')}</div>
            <div class="chips">${b.shared.slice(0, 10).map((s) => `<span class="chip">${esc(s.name)} ×${s.recipes.length}</span>`).join('')}</div>
            ${b.tips.map((t) => `<p class="tip">${esc(t)}</p>`).join('')}
          </div>`).join('')}` : ''}
      ${plan.complements.length ? `
        <h3>♻️ Use up what you're buying</h3>
        <p class="muted small">These recipes reuse ingredients already on your list.</p>
        <ul class="list">${plan.complements.map((c) => `
          <li class="item">
            <div class="grow"><a href="#/recipe/${c.id}" class="title">${esc(c.title)}</a>
              <div class="meta">${healthPill(c.health)} <span class="small">Shares ${esc(c.shared.slice(0, 4).join(', '))}${c.newItems ? ` · ${c.newItems} new item${c.newItems > 1 ? 's' : ''}` : ' · nothing new to buy'}</span></div></div>
            <button class="icon add" data-action="plan-add" data-recipe="${c.id}" title="Add to plan">＋</button>
          </li>`).join('')}</ul>` : ''}
      <p class="center"><button class="link danger" data-action="plan-clear">Start a new week (clear plan)</button></p>
    ` : `
      <div class="empty card">
        <h2>Nothing planned yet</h2>
        <p>Let the app pick a week for you, or choose recipes yourself.</p>
        <div class="row gap center">
          <a class="btn primary" href="#/ideas">💡 Suggest meals</a>
          <a class="btn" href="#/recipes">📖 Pick recipes</a>
        </div>
      </div>`}
  `;
};

views.ideas = async () => {
  setTitle('Ideas');
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const goal = q.get('goal') || localStorage.getItem('goal') || 'balanced';
  const count = Number(q.get('count') || localStorage.getItem('count') || 5);
  const favorites = q.get('favorites') || 'normal';
  const seed = q.get('seed') || '';
  const data = await api(`/suggestions?goal=${goal}&count=${count}&favorites=${favorites}&seed=${seed}`);
  const goals = { light: '🥗 Light', balanced: '⚖️ Balanced', comfort: '🍝 Comfort', any: '🎲 Anything' };
  $view.innerHTML = `
    <div class="card">
      <div class="label">How healthy this week?</div>
      <div class="segmented">${Object.entries(goals).map(([k, v]) => `<button data-action="ideas-set" data-key="goal" data-value="${k}" class="${k === goal ? 'on' : ''}">${v}</button>`).join('')}</div>
      <div class="row gap wrap">
        <label>Meals <select data-action="ideas-count">${[2, 3, 4, 5, 6, 7].map((n) => `<option ${n === count ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Favourites <select data-action="ideas-fav">
          <option value="less" ${favorites === 'less' ? 'selected' : ''}>Try new things</option>
          <option value="normal" ${favorites === 'normal' ? 'selected' : ''}>Mix</option>
          <option value="more" ${favorites === 'more' ? 'selected' : ''}>Mostly favourites</option></select></label>
      </div>
    </div>
    ${data.suggested.length ? `
      <form data-form="add-suggestions">
        <ul class="list">${data.suggested.map((s) => `
          <li class="item">
            <label class="check"><input type="checkbox" name="r" value="${s.id}" checked></label>
            <div class="grow"><a href="#/recipe/${s.id}" class="title">${s.favorite ? '<span class="fav">★</span> ' : ''}${esc(s.title)}</a>
              <div class="meta">${healthPill(s.health)} <span class="small muted">${esc(daysAgo(s.lastCooked))}</span></div>
              ${s.reasons.length ? `<div class="small reasons">${s.reasons.map(esc).join(' · ')}</div>` : ''}</div>
          </li>`).join('')}</ul>
        <div class="row gap sticky-actions">
          <button class="primary grow">Add selected to plan</button>
          <button type="button" data-action="ideas-shuffle">🔀 Shuffle</button>
        </div>
      </form>` : `<div class="empty card"><p>No recipes yet. <a href="#/more">Import some</a> to get suggestions.</p></div>`}
    ${data.forgotten.length ? `
      <h3>⭐ Favourites you haven't had in a while</h3>
      <ul class="list">${data.forgotten.map((f) => `
        <li class="item">
          <div class="grow"><a href="#/recipe/${f.id}" class="title">${esc(f.title)}</a>
            <div class="meta">${healthPill(f.health)} <span class="small muted">${f.days == null ? 'never cooked here' : `last had ${f.days} days ago`}</span></div></div>
          <button class="icon add" data-action="plan-add" data-recipe="${f.id}" title="Add to plan">＋</button>
        </li>`).join('')}</ul>` : ''}
  `;
};

views.shop = async () => {
  setTitle('Shopping');
  const list = await api('/shopping');
  const itemRow = (i) => `
    <li class="shop-item ${i.checked ? 'done' : ''}">
      <label><input type="checkbox" data-action="shop-check" data-key="${esc(i.key)}" ${i.checked ? 'checked' : ''}>
        <span class="name">${esc(i.name)}</span>
        ${i.amount ? `<span class="amt">${esc(i.amount)}</span>` : ''}
        ${i.shared ? `<span class="shared" title="Used in: ${esc(i.meals.join(', '))}">♻️ ${i.meals.length} meals</span>` : ''}
      </label>
      <div class="for small muted">${esc(i.meals.join(' · '))}</div>
    </li>`;
  const manualRow = (m) => `
    <li class="shop-item ${m.checked ? 'done' : ''}">
      <label><input type="checkbox" data-action="manual-check" data-id="${m.id}" ${m.checked ? 'checked' : ''}><span class="name">${esc(m.label)}</span>${m.addedBy ? `<span class="amt small">${esc(m.addedBy)}</span>` : ''}</label>
      <button class="icon small" data-action="manual-del" data-id="${m.id}" title="Remove">✕</button>
    </li>`;
  $view.innerHTML = `
    <form class="row gap add-item" data-form="manual-add">
      <input name="label" placeholder="Add something else (e.g. coffee)" autocomplete="off">
      <button class="primary">Add</button>
    </form>
    ${list.total ? `<div class="progress"><span style="width:${(list.done / list.total) * 100}%"></span></div>
    <p class="small muted">${list.done} of ${list.total} in the cart</p>` : ''}
    ${list.groups.length ? list.groups.map((g) => `
      <h3>${esc(g.category)}</h3>
      <ul class="shop">${g.items.map(itemRow).join('')}${g.manual.map(manualRow).join('')}</ul>`).join('')
    : '<div class="empty card"><p>Your list is empty. <a href="#/plan">Plan some meals</a> and their ingredients show up here automatically.</p></div>'}
    ${list.pantry.length ? `
      <details class="pantry">
        <summary>🧂 Check the pantry (${list.pantry.length} staples)</summary>
        <ul class="shop">${list.pantry.map(itemRow).join('')}</ul>
      </details>` : ''}
    ${list.total ? `<div class="row gap center"><button data-action="shop-share">📤 Share list</button><button data-action="shop-clear">Remove checked extras</button></div>` : ''}
  `;
  state.shopList = list;
};

views.recipes = async () => {
  setTitle('Recipes');
  const all = await recipes();
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const filter = q.get('f') || 'all';
  const search = q.get('q') || '';
  $view.innerHTML = `
    <div class="row gap">
      <input type="search" id="recipe-search" placeholder="Search recipes or ingredients…" value="${esc(search)}" class="grow">
      <a class="btn primary" href="#/edit/new" title="New recipe">＋</a>
    </div>
    <div class="segmented small">
      ${[['all', 'All'], ['fav', '★ Favourites'], ['healthy', '🥗 Healthy'], ['comfort', '🍝 Comfort'], ['stale', '⏳ Not lately']]
        .map(([k, v]) => `<button data-action="recipes-filter" data-value="${k}" class="${k === filter ? 'on' : ''}">${v}</button>`).join('')}
    </div>
    <ul class="list" id="recipe-list"></ul>
    ${all.length ? '' : '<div class="empty card"><p>No recipes yet.</p><a class="btn primary" href="#/more">Import from Dropbox</a></div>'}
  `;
  const render = () => {
    const term = document.getElementById('recipe-search').value.trim().toLowerCase();
    let list = all.filter((r) => !term || r.title.toLowerCase().includes(term) || r.tags.some((t) => t.toLowerCase().includes(term)) || r.ingredientNames.some((n) => n.includes(term)));
    if (filter === 'fav') list = list.filter((r) => r.favorite);
    if (filter === 'healthy') list = list.filter((r) => r.health >= 4);
    if (filter === 'comfort') list = list.filter((r) => r.health <= 2);
    if (filter === 'stale') list = list.filter((r) => !r.lastCooked || (Date.now() - new Date(r.lastCooked)) / 86400000 > 30)
      .sort((a, b) => (a.lastCooked || '').localeCompare(b.lastCooked || ''));
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
  const r = await api(`/recipes/${rid}`);
  setTitle(r.title);
  const steps = (r.instructions || '').split('\n').filter(Boolean);
  $view.innerHTML = `
    <div class="card">
      <div class="row between">
        <button class="icon big fav-toggle ${r.favorite ? 'on' : ''}" data-action="fav" data-id="${r.id}" data-on="${r.favorite ? 1 : 0}" title="Favourite">${star(r.favorite)}</button>
        <div class="muted small right">${r.servings} servings${r.prepMinutes ? ` · ${r.prepMinutes} min` : ''}<br>${esc(daysAgo(r.lastCooked))}${r.timesCooked ? ` · made ${r.timesCooked}×` : ''}</div>
      </div>
      <div class="label">Healthiness</div>
      <div class="segmented small">${[1, 2, 3, 4, 5].map((h) => `<button data-action="set-health" data-id="${r.id}" data-value="${h}" class="${h === r.health ? 'on' : ''} h${h}">${HEALTH[h]}</button>`).join('')}</div>
      ${r.healthSource === 'auto' && r.autoHealth.reasons.length ? `<p class="small muted">Auto-rated: ${esc(r.autoHealth.reasons.join(', '))}. Tap to change.</p>` : ''}
      ${r.tags.length ? `<div class="chips">${r.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="row gap wrap">
        <button class="primary" data-action="plan-add" data-recipe="${r.id}">＋ Add to plan</button>
        <button data-action="cooked-today" data-id="${r.id}">✅ Cooked today</button>
        <a class="btn" href="#/edit/${r.id}">✏️ Edit</a>
      </div>
    </div>
    ${r.lighterTips.length ? `<details class="card tips"><summary>🥗 Make it lighter</summary><ul>${r.lighterTips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>` : ''}
    <h3>Ingredients</h3>
    <ul class="ingredients">${r.ingredients.map((i) => `<li>${esc(i.raw)}${i.staple ? ' <span class="muted small">(pantry)</span>' : ''}</li>`).join('')}</ul>
    ${steps.length ? `<h3>Method</h3><ol class="steps">${steps.map((s) => `<li>${esc(s.replace(/^\d+[.)]\s*/, ''))}</li>`).join('')}</ol>` : ''}
    ${r.notes ? `<h3>Notes</h3><p class="notes">${esc(r.notes).replace(/\n/g, '<br>')}</p>` : ''}
    ${r.similar.length ? `<h3>♻️ Batches well with</h3><ul class="list">${r.similar.map((s) => `
      <li class="item"><div class="grow"><a href="#/recipe/${s.id}" class="title">${esc(s.title)}</a><div class="small muted">Shares ${esc(s.shared.slice(0, 5).join(', '))}</div></div>
      <button class="icon add" data-action="plan-add" data-recipe="${s.id}" title="Add to plan">＋</button></li>`).join('')}</ul>` : ''}
    <p class="small muted">Source: ${esc(r.source)}${r.sourcePath ? ` — ${esc(r.sourcePath.replace(/^dropbox:/, 'Dropbox '))}` : ''}</p>
    <p class="center"><button class="link danger" data-action="recipe-delete" data-id="${r.id}">Delete recipe</button></p>
  `;
};

views.edit = async (rid) => {
  const isNew = rid === 'new';
  const r = isNew ? { title: '', servings: 4, prepMinutes: '', tags: [], ingredients: [], instructions: '', notes: '' } : await api(`/recipes/${rid}`);
  setTitle(isNew ? 'New recipe' : 'Edit recipe');
  $view.innerHTML = `
    <form class="card form" data-form="recipe" data-id="${isNew ? '' : r.id}">
      <label>Title <input name="title" value="${esc(r.title)}" required></label>
      <div class="row gap">
        <label>Servings <input name="servings" type="number" min="1" value="${esc(r.servings)}"></label>
        <label>Minutes <input name="prepMinutes" type="number" min="0" value="${esc(r.prepMinutes ?? '')}"></label>
      </div>
      <label>Tags <input name="tags" value="${esc(r.tags.join(', '))}" placeholder="mexican, quick, vegetarian"></label>
      <label>Ingredients <span class="muted small">(one per line, e.g. "2 cups rice")</span>
        <textarea name="ingredients" rows="10" required>${esc(r.ingredients.map((i) => i.raw).join('\n'))}</textarea></label>
      <label>Method <textarea name="instructions" rows="8">${esc(r.instructions)}</textarea></label>
      <label>Notes <textarea name="notes" rows="3">${esc(r.notes)}</textarea></label>
      <button class="primary">Save</button>
    </form>`;
};

views.more = async () => {
  setTitle('Import & more');
  const [status, history, me, invites] = await Promise.all([api('/dropbox'), api('/history?limit=20'), api('/me'), api('/family/invites')]);
  const owner = me.user.role === 'owner';
  state.status = await api('/status');
  const ai = state.status.ai;
  const sync = status.sync;
  $view.innerHTML = `
    <div class="card">
      <h2>🏡 ${esc(me.family.name)}</h2>
      <ul class="list compact">${me.family.members.map((m) => `
        <li class="item"><div class="grow"><strong>${esc(m.name)}</strong>${m.id === me.user.id ? ' (you)' : ''} ${m.role === 'owner' ? '<span class="chip">owner</span>' : ''}<div class="small muted">${esc(m.email)}</div></div>
        ${owner && m.id !== me.user.id ? `<button class="icon small" data-action="remove-member" data-id="${m.id}" data-name="${esc(m.name)}" title="Remove from family">✕</button>` : ''}</li>`).join('')}</ul>
      <div class="row gap wrap"><button class="primary" data-action="invite">✉️ Invite someone</button><button data-action="rename-family">Rename</button></div>
      <div id="invite-box"></div>
      ${invites.length ? `<details class="small"><summary>${invites.length} open invite${invites.length > 1 ? 's' : ''}</summary><ul class="list compact">${invites.map((i) => `
        <li class="item"><div class="grow"><code>${esc(i.code)}</code> <span class="muted">by ${esc(i.createdBy || '?')}, expires ${new Date(i.expiresAt).toLocaleDateString()}</span></div>
        <button class="icon small" data-action="cancel-invite" data-code="${esc(i.code)}" title="Cancel invite">✕</button></li>`).join('')}</ul></details>` : ''}
      <p class="small muted">Everyone in the family shares recipes, the plan, the shopping list, favourites and the Dropbox connection.</p>
    </div>

    <div class="card">
      <h2>📦 Dropbox recipes</h2>
      ${status.connected ? `
        <p>Connected${status.account ? ` to <strong>${esc(status.account)}</strong>'s Dropbox` : ''}${status.connectedBy ? ` by ${esc(status.connectedBy)}` : ''} — shared with everyone in ${esc(me.family.name)}.</p>
        <form class="row gap" data-form="dropbox-folder">
          <input name="folder" value="${esc(status.folder)}" placeholder="/Recipes" class="grow" aria-label="Dropbox folder">
          <button>Save folder</button>
        </form>
        <div class="row gap wrap">
          <button class="primary" data-action="dropbox-sync" ${sync?.running ? 'disabled' : ''}>⬇️ Import new recipes</button>
          <button data-action="dropbox-sync-force" ${sync?.running ? 'disabled' : ''}>Re-import all</button>
          <button class="link" data-action="dropbox-disconnect">Disconnect</button>
        </div>
        <div id="sync-status">${syncHtml(sync, status.lastSync)}</div>
      ` : `
        <p class="small">Connect once and everyone in your family can import from it. The access key stays on the server.</p>
        <ol class="steps small">
          <li>Go to <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener">dropbox.com/developers/apps</a> → <em>Create app</em> → <em>Scoped access</em> → <em>Full Dropbox</em> (or App folder). Name it anything.</li>
          <li>On the <em>Permissions</em> tab tick <code>files.content.read</code> and press <em>Submit</em>.</li>
          <li>Copy the <em>App key</em> from the Settings tab${status.appKeyFromEnv ? ' (already set on the server)' : ''}.</li>
        </ol>
        <form data-form="dropbox-start" class="row gap">
          ${status.appKeyFromEnv ? '' : '<input name="appKey" placeholder="Dropbox app key" class="grow" required>'}
          <button class="primary">Connect Dropbox</button>
        </form>
        <form data-form="dropbox-finish" class="row gap" id="dropbox-code" hidden>
          <input name="code" placeholder="Paste the code Dropbox shows you" class="grow" required>
          <button class="primary">Finish</button>
        </form>`}
      <p class="small muted">Reads: ${esc(state.status.supportedExtensions.join(' '))}${ai ? '' : '<br>Add an <code>ANTHROPIC_API_KEY</code> on the server to also read PDFs and photos of recipe cards, and to parse messy files more accurately.'}</p>
    </div>

    <div class="card">
      <h2>➕ Add recipes other ways</h2>
      <label class="label">Upload files</label>
      <input type="file" id="upload" multiple accept="${esc(state.status.supportedExtensions.join(','))}">
      <form data-form="import-url" class="row gap">
        <input name="url" type="url" placeholder="Paste a recipe web link" class="grow">
        <button>Import</button>
      </form>
      <form data-form="import-text">
        <textarea name="text" rows="5" placeholder="…or paste a recipe (title, ingredients, method)"></textarea>
        <button>Add pasted recipe</button>
      </form>
    </div>

    <div class="card">
      <h2>🕑 Recently cooked</h2>
      ${history.length ? `<ul class="list compact">${history.map((h) => `
        <li class="item"><div class="grow"><a href="#/recipe/${h.recipeId}">${esc(h.title)}</a> <span class="small muted">${esc(h.cookedOn)}${h.cookedBy ? ` · ${esc(h.cookedBy)}` : ''}</span></div>
        <button class="icon small" data-action="history-del" data-id="${h.id}" title="Remove">✕</button></li>`).join('')}</ul>`
        : '<p class="muted">Tap ✅ on a planned meal after you cook it — the app uses this to remember favourites you haven\'t had in a while.</p>'}
    </div>

    <div class="card">
      <h2>👤 ${esc(me.user.name)}</h2>
      <p class="small muted">${esc(me.user.email)}</p>
      <details><summary>Change name or password</summary>
        <form data-form="rename-me" class="row gap"><input name="name" value="${esc(me.user.name)}" class="grow" required><button>Save name</button></form>
        <form data-form="change-password" class="stack">
          <input type="password" name="current" autocomplete="current-password" placeholder="Current password" required>
          <input type="password" name="password" autocomplete="new-password" placeholder="New password (8+ characters)" minlength="8" required>
          <button>Change password</button></form>
      </details>
      <div class="row gap wrap">
        <a class="btn" href="/api/export">💾 Download backup</a>
        <button data-action="logout">Log out</button>
        <button class="link" data-action="logout-everywhere">Log out on all devices</button>
        <button class="link danger" data-action="leave-family">Leave family</button>
      </div>
      <p class="small muted">Tip: open this page in Safari/Chrome and choose <em>Add to Home Screen</em> to use it like an app.</p>
    </div>
  `;
  if (sync?.running) pollSync();
};

function syncHtml(sync, last) {
  if (sync?.running) {
    return `<div class="progress"><span style="width:${sync.total ? (sync.done / sync.total) * 100 : 5}%"></span></div>
      <p class="small">Importing ${sync.done}/${sync.total || '…'}${sync.current ? ` — ${esc(sync.current)}` : ''}</p>`;
  }
  if (sync) {
    return `<p class="small">Done: ${sync.imported} recipe${sync.imported === 1 ? '' : 's'} imported, ${sync.skipped} already here${sync.unsupported ? `, ${sync.unsupported} files skipped (${esc((sync.unsupportedExamples || []).join(' '))})` : ''}.</p>
      ${sync.errors.length ? `<details class="small"><summary>${sync.errors.length} problem${sync.errors.length > 1 ? 's' : ''}</summary><ul>${sync.errors.map((e) => `<li>${esc(e.file)}: ${esc(e.error)}</li>`).join('')}</ul></details>` : ''}`;
  }
  if (last) return `<p class="small muted">Last import ${new Date(last.at).toLocaleString()}: ${last.imported} new.</p>`;
  return '';
}

let syncTimer;
function pollSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const s = await api('/dropbox').catch(() => null);
    const el = document.getElementById('sync-status');
    if (!s || !el) return;
    el.innerHTML = syncHtml(s.sync, s.lastSync);
    if (s.sync?.running) pollSync(); else { state.recipesCache = null; document.querySelectorAll('[data-action^="dropbox-sync"]').forEach((b) => { b.disabled = false; }); }
  }, 1500);
}

// ---------- actions ----------
async function addToPlan(recipeId) {
  await api('/plan', { body: { recipeId } });
  toast('Added to this week ✓');
}

const actions = {
  'plan-add': async (el) => { await addToPlan(Number(el.dataset.recipe)); if (state.route === 'plan') render(); },
  'plan-remove': async (el) => { await api(`/plan/${el.dataset.id}`, { method: 'DELETE' }); render(); },
  'plan-cooked': async (el) => { await api(`/plan/${el.dataset.id}/cooked`, { body: {} }); toast('Nice! Logged as cooked 🍽'); render(); },
  'plan-clear': async () => { if (confirm('Clear the whole plan and shopping ticks?')) { await api('/plan', { method: 'DELETE' }); render(); } },
  fav: async (el) => {
    const on = el.dataset.on !== '1';
    await api(`/recipes/${el.dataset.id}`, { method: 'PATCH', body: { favorite: on } });
    el.dataset.on = on ? '1' : '0'; el.textContent = star(on); el.classList.toggle('on', on);
  },
  'set-health': async (el) => { await api(`/recipes/${el.dataset.id}`, { method: 'PATCH', body: { health: Number(el.dataset.value) } }); render(); },
  'cooked-today': async (el) => { await api(`/recipes/${el.dataset.id}/cooked`, { body: {} }); toast('Logged as cooked today'); render(); },
  'recipe-delete': async (el) => { if (confirm('Delete this recipe?')) { await api(`/recipes/${el.dataset.id}`, { method: 'DELETE' }); location.hash = '#/recipes'; } },
  'recipes-filter': (el) => { const q = new URLSearchParams(location.hash.split('?')[1] || ''); q.set('f', el.dataset.value); q.set('q', document.getElementById('recipe-search').value); location.hash = `#/recipes?${q}`; },
  'ideas-set': (el) => { localStorage.setItem(el.dataset.key, el.dataset.value); setIdeas({ [el.dataset.key]: el.dataset.value }); },
  'ideas-shuffle': () => setIdeas({ seed: String(Math.floor(Math.random() * 1e9)) }),
  'shop-share': async () => {
    const l = state.shopList; const lines = [];
    for (const g of l.groups) {
      const todo = [...g.items.filter((i) => !i.checked).map((i) => `${i.name}${i.amount ? ` (${i.amount})` : ''}`), ...g.manual.filter((m) => !m.checked).map((m) => m.label)];
      if (todo.length) lines.push(`${g.category}:`, ...todo.map((t) => `• ${t}`), '');
    }
    const text = lines.join('\n') || 'All done!';
    if (navigator.share) { try { await navigator.share({ title: 'Shopping list', text }); return; } catch { /* cancelled */ } }
    await navigator.clipboard.writeText(text); toast('Copied to clipboard');
  },
  'shop-clear': async () => { await api('/shopping/clear-checked', { body: {} }); render(); },
  'manual-del': async (el) => { await api(`/shopping/manual/${el.dataset.id}`, { method: 'DELETE' }); render(); },
  'history-del': async (el) => { await api(`/history/${el.dataset.id}`, { method: 'DELETE' }); render(); },
  'dropbox-sync': async () => { await api('/dropbox/sync', { body: {} }); render(); },
  'dropbox-sync-force': async () => { if (confirm('Re-import every file? Edits you made to imported recipes will be replaced.')) { await api('/dropbox/sync', { body: { force: true } }); render(); } },
  'dropbox-disconnect': async () => { if (confirm('Disconnect Dropbox? Imported recipes stay.')) { await api('/dropbox/disconnect', { body: {} }); render(); } },
  logout: async () => { await api('/auth/logout', { body: {} }); state.recipesCache = null; location.hash = '#/login'; },
  'logout-everywhere': async () => { if (confirm('Log out on every phone and computer?')) { await api('/me/logout-everywhere', { body: {} }); location.hash = '#/login'; } },
  'leave-family': async () => { if (confirm('Leave this family? You will lose access to its recipes and plans.')) { await api('/family/leave', { body: {} }); location.hash = '#/welcome'; } },
  'join-family': async (el) => { await api('/family/join', { body: { code: el.dataset.code } }); state.recipesCache = null; toast('Welcome to the family 🎉'); location.hash = '#/plan'; },
  'remove-member': async (el) => { if (confirm(`Remove ${el.dataset.name} from the family?`)) { await api(`/family/members/${el.dataset.id}`, { method: 'DELETE' }); render(); } },
  'rename-family': async () => { const name = prompt('Family name'); if (name?.trim()) { await api('/family', { method: 'PATCH', body: { name } }); render(); } },
  'cancel-invite': async (el) => { await api(`/family/invites/${encodeURIComponent(el.dataset.code)}`, { method: 'DELETE' }); render(); },
  invite: async () => {
    const inv = await api('/family/invites', { body: {} });
    const url = `${location.origin}/#/join/${inv.code}`;
    document.getElementById('invite-box').innerHTML = `
      <div class="invite"><p class="small">Send this link (valid 7 days). They create their own login and join your family:</p>
      <input readonly value="${esc(url)}" onclick="this.select()">
      <div class="row gap"><button class="primary" data-action="share-invite" data-url="${esc(url)}">📤 Share</button><span class="small muted">Code: <code>${esc(inv.code)}</code></span></div></div>`;
  },
  'share-invite': async (el) => {
    const text = `Join our family meal planner: ${el.dataset.url}`;
    if (navigator.share) { try { await navigator.share({ title: 'Our Meals', text, url: el.dataset.url }); return; } catch { /* cancelled */ } }
    await navigator.clipboard.writeText(el.dataset.url); toast('Link copied');
  },
};

const changeActions = {
  'plan-day': (el) => api(`/plan/${el.dataset.id}`, { method: 'PATCH', body: { plannedFor: el.value } }),
  'plan-servings': (el) => api(`/plan/${el.dataset.id}`, { method: 'PATCH', body: { servings: Number(el.value) } }),
  'shop-check': async (el) => { el.closest('li').classList.toggle('done', el.checked); state.shopList = await api('/shopping/check', { body: { key: el.dataset.key, checked: el.checked } }); updateProgress(); },
  'manual-check': async (el) => { el.closest('li').classList.toggle('done', el.checked); state.shopList = await api(`/shopping/manual/${el.dataset.id}`, { method: 'PATCH', body: { checked: el.checked } }); updateProgress(); },
  'ideas-count': (el) => { localStorage.setItem('count', el.value); setIdeas({ count: el.value }); },
  'ideas-fav': (el) => setIdeas({ favorites: el.value }),
};

function updateProgress() {
  const l = state.shopList; const bar = document.querySelector('.progress span');
  if (bar && l.total) { bar.style.width = `${(l.done / l.total) * 100}%`; bar.parentElement.nextElementSibling.textContent = `${l.done} of ${l.total} in the cart`; }
}

function setIdeas(patch) {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  for (const [k, v] of Object.entries(patch)) q.set(k, v);
  if (!patch.seed) q.delete('seed');
  location.hash = `#/ideas?${q}`;
}

const forms = {
  login: async (f) => {
    const me = await api('/auth/login', { body: { email: f.email.value, password: f.password.value } });
    const next = new URLSearchParams(location.hash.split('?')[1] || '').get('next');
    state.recipesCache = null; startSync();
    location.hash = next ? `#${next}` : me.family ? '#/plan' : '#/welcome';
  },
  signup: async (f) => {
    const body = Object.fromEntries(new FormData(f));
    await api('/auth/signup', { body });
    state.recipesCache = null; startSync();
    toast(body.inviteCode ? 'Welcome to the family 🎉' : 'Account created 🎉');
    location.hash = '#/plan';
  },
  'go-invite': (f) => { location.hash = `#/join/${encodeURIComponent(f.code.value.trim().toUpperCase())}`; },
  'create-family': async (f) => { await api('/family', { body: { name: f.name.value } }); location.hash = '#/plan'; },
  'rename-me': async (f) => { await api('/me', { method: 'PATCH', body: { name: f.name.value } }); toast('Saved'); render(); },
  'change-password': async (f) => { await api('/me/password', { body: { current: f.current.value, password: f.password.value } }); f.reset(); toast('Password changed — other devices were logged out', 4000); },
  'add-suggestions': async (f) => {
    const ids = [...f.querySelectorAll('input[name=r]:checked')].map((i) => Number(i.value));
    if (!ids.length) return toast('Tick at least one meal');
    await api('/plan', { body: { recipeIds: ids } });
    toast(`Added ${ids.length} meal${ids.length > 1 ? 's' : ''} ✓`); location.hash = '#/plan';
  },
  'manual-add': async (f) => { if (!f.label.value.trim()) return; await api('/shopping/manual', { body: { label: f.label.value } }); f.label.value = ''; render(); },
  recipe: async (f) => {
    const body = {
      title: f.title.value, servings: Number(f.servings.value) || 4, prepMinutes: f.prepMinutes.value,
      tags: f.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      ingredients: f.ingredients.value.split('\n').map((l) => l.trim()).filter(Boolean),
      instructions: f.instructions.value, notes: f.notes.value,
    };
    const saved = f.dataset.id ? await api(`/recipes/${f.dataset.id}`, { method: 'PUT', body }) : await api('/recipes', { body });
    toast('Saved'); location.hash = `#/recipe/${saved.id}`;
  },
  'dropbox-start': async (f) => {
    const { url } = await api('/dropbox/auth/start', { body: { appKey: f.appKey?.value } });
    window.open(url, '_blank', 'noopener');
    document.getElementById('dropbox-code').hidden = false;
    toast('Approve access in Dropbox, then paste the code here', 5000);
  },
  'dropbox-finish': async (f) => { await api('/dropbox/auth/finish', { body: { code: f.code.value } }); toast('Dropbox connected 🎉'); render(); },
  'dropbox-folder': async (f) => { await api('/dropbox/folder', { body: { folder: f.folder.value } }); toast('Folder saved'); },
  'import-url': async (f) => { toast('Fetching…'); const { ids } = await api('/import/url', { body: { url: f.url.value } }); location.hash = `#/recipe/${ids[0]}`; },
  'import-text': async (f) => { toast('Reading recipe…'); const { ids } = await api('/import/text', { body: { text: f.text.value } }); location.hash = `#/recipe/${ids[0]}`; },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT' || !actions[el.dataset.action]) return;
  e.preventDefault();
  el.disabled = true;
  try { await actions[el.dataset.action](el); } catch (err) { toast(err.message, 4000); } finally { el.disabled = false; }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'upload') return uploadFiles(el.files);
  const fn = changeActions[el.dataset?.action];
  if (fn) { try { await fn(el); } catch (err) { toast(err.message, 4000); } }
});

document.addEventListener('submit', async (e) => {
  const f = e.target; const fn = forms[f.dataset.form];
  if (!fn) return;
  e.preventDefault();
  const btn = f.querySelector('button:not([type=button])'); if (btn) btn.disabled = true;
  try { await fn(f); } catch (err) { toast(err.message, 4000); } finally { if (btn) btn.disabled = false; }
});

async function uploadFiles(files) {
  let ok = 0; const errors = [];
  for (const file of files) {
    toast(`Importing ${file.name}…`, 10000);
    try {
      await api('/import/upload', { body: file, headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'application/octet-stream' } });
      ok++;
    } catch (err) { errors.push(`${file.name}: ${err.message}`); }
  }
  toast(`Imported ${ok} file${ok === 1 ? '' : 's'}${errors.length ? ` — ${errors.length} failed` : ''}`, 4000);
  if (errors.length) alert(errors.join('\n'));
  document.getElementById('upload').value = '';
}

// ---------- routing & live sync ----------
async function render() {
  const [path] = location.hash.replace(/^#\/?/, '').split('?');
  const [name, arg] = path.split('/');
  const route = views[name] ? name : 'plan';
  state.route = route;
  $tabs.hidden = PUBLIC_ROUTES.has(route);
  const tab = { recipe: 'recipes', edit: 'recipes' }[route] || route;
  $tabs.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  try { await views[route](arg); } catch (err) {
    if (err.message !== 'Please log in') $view.innerHTML = `<div class="card error">⚠️ ${esc(err.message)}</div>`;
  }
}

// When the other person changes something, refresh the current screen (unless typing).
async function checkForChanges() {
  if (document.hidden || PUBLIC_ROUTES.has(state.route) || state.route === 'edit') return;
  try {
    const { rev } = await api('/rev');
    if (state.rev && rev !== state.rev && !document.activeElement?.matches('input, textarea, select')) {
      state.recipesCache = null;
      const y = window.scrollY; await render(); window.scrollTo(0, y);
    }
    state.rev = rev;
  } catch { /* offline */ }
}
let syncInterval;
function startSync() { clearInterval(syncInterval); state.rev = 0; syncInterval = setInterval(checkForChanges, 8000); }
document.addEventListener('visibilitychange', checkForChanges);

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

(async () => {
  const s = await fetch('/api/session').then((r) => r.json()).catch(() => ({ authed: true, hasFamily: true }));
  const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  let target = null;
  if (route === 'join') target = null; // invite links work logged in or out
  else if (!s.authed) target = s.firstRun ? '#/signup' : (route === 'signup' ? null : '#/login');
  else if (!s.hasFamily) target = '#/welcome';
  else if (!route || PUBLIC_ROUTES.has(route)) target = '#/plan';
  if (target && target !== location.hash) location.hash = target; else render();
  if (s.authed) { startSync(); checkForChanges(); }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
