// Meals: the week's suppers, the shared grocery list, what's in the house, recipes, and flyer deals (Flipp).

const $ = sel => document.querySelector(sel);
const today = toISO(new Date());
const TITLES = { plan: "Suppers", list: "Grocery list", pantry: "In the house", recipes: "Recipes", deals: "Deals" };
const PLACES = [["fridge", "🧊 Fridge"], ["freezer", "❄️ Freezer"], ["cupboard", "🥫 Cupboard"], ["other", "📦 Other"]];
const state = { view: "plan", week: addDays(today, -parseISO(today).getDay()), recipes: [], list: [], deals: null, flyer: null };

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 4000 : 2000);
}
async function run(fn) { try { await fn(); } catch (e) { toast(e.message, true); } }
function openSheet(html, onMount) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheet-backdrop").hidden = false;
  requestAnimationFrame(() => $("#sheet").classList.add("open"));
  onMount($("#sheet-body"));
}
function closeSheet() { $("#sheet").classList.remove("open"); $("#sheet").hidden = true; $("#sheet-backdrop").hidden = true; }
function store(k, v) { try { localStorage.setItem(`meals-${k}`, v); } catch (_) {} }
function recall(k) { try { return localStorage.getItem(`meals-${k}`); } catch (_) { return null; } }
const money = d => d.price != null ? `$${d.price.toFixed(2)}` : (d.text || "on sale");
const until = d => d.to ? `until ${relDay(d.to, today)}` : "";

// ------------------------------------------------------------ suppers

async function renderPlan() {
  const [plan, recipes] = await Promise.all([api(`/api/meals/plan?start=${state.week}`), api("/api/meals/recipes")]);
  state.recipes = recipes;
  const s = parseISO(state.week), e = parseISO(addDays(state.week, 6));
  $("#view-plan").innerHTML = `
    <div class="week-nav">
      <button class="icon-btn" data-week="-7" aria-label="Last week"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <h2>${MONTH_NAMES[s.getMonth()].slice(0, 3)} ${s.getDate()} – ${MONTH_NAMES[e.getMonth()].slice(0, 3)} ${e.getDate()}</h2>
      <button class="icon-btn" data-week="7" aria-label="Next week"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <div class="card list">${plan.map(d => {
      const dt = parseISO(d.date);
      const what = d.recipe ? `${d.emoji || "🍽️"} ${esc(d.recipe)}` : d.title ? `🍽️ ${esc(d.title)}` : "";
      return `<div class="supper ${d.date === today ? "today" : ""}" data-day="${d.date}">
        <div class="day"><b>${d.date === today ? "Today" : DAY_NAMES[dt.getDay()].slice(0, 3)}</b><span>${MONTH_NAMES[dt.getMonth()].slice(0, 3)} ${dt.getDate()}</span></div>
        <div class="what ${what ? "" : "empty-slot"}">${what || "+ Pick supper"}${d.notes ? `<div class="mono-small">${esc(d.notes)}</div>` : ""}</div>
      </div>`;
    }).join("")}</div>
    <div class="row-actions">
      <button class="btn" id="week-to-list">🛒 Add this week's ingredients to the list</button>
    </div>
    <div class="row-actions">
      <button class="btn secondary" id="ideas-btn">🧑‍🍳 Cook with what we have</button>
    </div>
    <p class="hint center">Suppers show on the wall screen and the calendar. Ingredients you already have (In the house) aren't added.</p>`;
}

function pickSupper(day) {
  const dt = parseISO(day);
  openSheet(`
    <h2>Supper · ${DAY_NAMES[dt.getDay()]} ${MONTH_NAMES[dt.getMonth()].slice(0, 3)} ${dt.getDate()}</h2>
    <input id="recipe-filter" placeholder="Search recipes" autocomplete="off">
    <div class="card list recipe-pick">${state.recipes.map(r => `<div class="row" data-pick="${r.id}">
      <div class="row-main"><div class="row-title">${esc(r.emoji)} ${esc(r.name)}</div>
      <div class="row-meta">${r.minutes ? `${r.minutes} min · ` : ""}${r.items.length} ingredients</div></div></div>`).join("")}</div>
    <form id="free-form" class="two" style="align-items:end">
      <label>Or just a name<input name="title" placeholder="Leftovers, Takeout…" autocomplete="off"></label>
      <button class="btn">Save</button>
    </form>
    <div class="sheet-actions"><button type="button" class="btn danger" id="clear-day">Clear this day</button>
      <button type="button" class="btn secondary" id="p-close">Close</button></div>`, body => {
    const save = b => run(async () => { await api(`/api/meals/plan/${day}`, { method: "PUT", body: b }); closeSheet(); renderPlan(); });
    body.querySelector("#recipe-filter").addEventListener("input", e => {
      const q = e.target.value.toLowerCase();
      body.querySelectorAll("[data-pick]").forEach(r => (r.hidden = !r.textContent.toLowerCase().includes(q)));
    });
    body.querySelectorAll("[data-pick]").forEach(r => r.addEventListener("click", () => save({ recipe_id: Number(r.dataset.pick) })));
    body.querySelector("#free-form").addEventListener("submit", e => { e.preventDefault(); if (e.target.title.value.trim()) save({ title: e.target.title.value }); });
    body.querySelector("#clear-day").addEventListener("click", () => save({ recipe_id: null, title: "" }));
    body.querySelector("#p-close").addEventListener("click", closeSheet);
  });
}

// ------------------------------------------------------------ cook with what we have
// Pick ingredients -> our recipes that use them, plus more from TheMealDB (free recipe database, with photos).

const cook = { picked: new Set(), sides: false, results: null };

async function cookPicker() {
  const opts = await api("/api/meals/cook/ingredients");
  const chip = n => `<button type="button" class="chip small ${cook.picked.has(n) ? "on" : ""}" data-pick-ing="${esc(n)}">${esc(n)}</button>`;
  const extra = [...cook.picked].filter(p => !opts.house.includes(p) && !opts.common.includes(p));
  openSheet(`
    <h2>🧑‍🍳 Cook with what we have</h2>
    <p class="hint">Tick what you want to cook with (the main things, like chicken, rice, peppers). Up to 6 count most.</p>
    ${opts.house.length ? `<h3 class="section-h">🥫 In the house</h3><div class="watch-chips">${opts.house.map(chip).join("")}</div>` : ""}
    <h3 class="section-h">Other ideas</h3><div class="watch-chips">${opts.common.map(chip).join("")}${extra.map(chip).join("")}</div>
    <form class="add-bar" id="ing-form" style="margin-top:10px"><input name="ing" placeholder="Something else (e.g. zucchini)" autocomplete="off">
      <button class="btn secondary">Add</button></form>
    <label class="switch"><input type="checkbox" id="sides" ${cook.sides ? "checked" : ""}> Also show sides, starters and desserts</label>
    <div class="sheet-actions"><button type="button" class="btn secondary" id="c-clear">Clear</button>
      <button type="button" class="btn secondary" id="c-close">Close</button>
      <button type="button" class="btn" id="c-find">Find suppers${cook.picked.size ? ` (${cook.picked.size})` : ""}</button></div>`, body => {
    const count = () => (body.querySelector("#c-find").textContent = `Find suppers${cook.picked.size ? ` (${cook.picked.size})` : ""}`);
    body.addEventListener("click", e => {
      const c = e.target.closest("[data-pick-ing]");
      if (!c) return;
      const n = c.dataset.pickIng;
      cook.picked.has(n) ? cook.picked.delete(n) : cook.picked.add(n);
      c.classList.toggle("on", cook.picked.has(n));
      count();
    });
    body.querySelector("#ing-form").addEventListener("submit", e => {
      e.preventDefault();
      const v = e.target.ing.value.trim().toLowerCase();
      if (!v) return;
      cook.picked.add(v);
      e.target.ing.value = "";
      run(cookPicker);
    });
    body.querySelector("#sides").addEventListener("change", e => (cook.sides = e.target.checked));
    body.querySelector("#c-clear").addEventListener("click", () => { cook.picked.clear(); run(cookPicker); });
    body.querySelector("#c-close").addEventListener("click", closeSheet);
    body.querySelector("#c-find").addEventListener("click", () => run(async () => {
      if (!cook.picked.size) return toast("Tick at least one thing", true);
      body.querySelector("#c-find").textContent = "Finding…";
      cook.results = await api("/api/meals/cook", { method: "POST", body: { have: [...cook.picked], sides: cook.sides } });
      cookResults();
    }));
  });
}

function cookResults() {
  const r = cook.results;
  const need = x => x.missing.length ? `Need ${x.missing.length}: ${x.missing.slice(0, 4).map(esc).join(", ")}${x.missing.length > 4 ? "…" : ""}` : "You have everything!";
  openSheet(`
    <h2>🧑‍🍳 With ${r.picked.map(esc).join(", ")}</h2>
    ${r.ours.length ? `<h3 class="section-h">📖 Our recipes</h3><div class="card list">${r.ours.map(o => `<div class="idea">
      <div class="iname"><span>${esc(o.emoji)} ${esc(o.name)}</span><span class="mono-small">uses ${o.uses.map(esc).join(", ")}</span></div>
      <div class="${o.missing.length ? "missing" : "have"}">${need(o)}</div>
      <div class="mail-actions" style="margin-top:6px"><button class="btn secondary small" data-tonight-ours="${o.id}">Tonight</button>
        ${o.missing.length ? `<button class="btn secondary small" data-need-list="${esc(o.missing.join("\n"))}" data-need-src="${esc(o.name)}">🛒 Add what's missing</button>` : ""}</div>
      </div>`).join("")}</div>` : ""}
    <h3 class="section-h">✨ More ideas</h3>
    ${r.more.length ? `<div class="cook-grid">${r.more.map(m => `<button type="button" class="cook-card" data-meal="${esc(m.id)}">
      <img src="${esc(m.image)}/preview" alt="" loading="lazy">
      <span class="cname">${esc(m.name)}</span>
      <span class="cmeta">${esc([m.area, m.category].filter(Boolean).join(" · "))}</span>
      <span class="cmeta">✓ ${m.have.length} of ${m.have.length + m.missing.length} · uses ${m.uses.map(esc).join(", ")}</span>
    </button>`).join("")}</div>` : `<p class="hint">No more ideas found${r.ours.length ? "" : " (or TheMealDB couldn't be reached)"}. Try fewer or simpler ingredients.</p>`}
    <p class="hint">More ideas come from TheMealDB, a free recipe collection. Save one to your recipes to plan it and shop for it.</p>
    <div class="sheet-actions"><button type="button" class="btn secondary" id="c-back">← Change ingredients</button>
      <button type="button" class="btn secondary" id="c-close">Close</button></div>`, body => {
    body.querySelector("#c-back").addEventListener("click", () => run(cookPicker));
    body.querySelector("#c-close").addEventListener("click", closeSheet);
    body.querySelectorAll("[data-tonight-ours]").forEach(b => b.addEventListener("click", () => run(async () => {
      await api(`/api/meals/plan/${today}`, { method: "PUT", body: { recipe_id: Number(b.dataset.tonightOurs) } });
      closeSheet(); toast("Tonight's supper is set"); show("plan");
    })));
    body.querySelectorAll("[data-need-list]").forEach(b => b.addEventListener("click", () => run(async () => {
      const x = await api("/api/meals/list", { method: "POST", body: { text: b.dataset.needList, source: b.dataset.needSrc } });
      toast(`Added ${x.added.length} to the list`); b.disabled = true; b.textContent = "✓ On the list";
    })));
    body.querySelectorAll("[data-meal]").forEach(b => b.addEventListener("click", () => run(() => cookDetail(b.dataset.meal))));
  });
}

async function cookDetail(mid) {
  const m = await api(`/api/meals/cook/meal/${encodeURIComponent(mid)}?picked=${encodeURIComponent([...cook.picked].join(","))}`);
  const missing = m.items.filter(i => !i.have);
  openSheet(`
    <img class="cook-hero" src="${esc(m.image)}" alt="">
    <h2>${esc(m.name)}</h2>
    <p class="hint">${esc([m.area, m.category].filter(Boolean).join(" · "))} · ✓ ${m.items.length - missing.length} of ${m.items.length} in the house</p>
    <div class="card list">${m.items.map(i => `<div class="rank"><span>${i.have ? "✅" : "○"} ${esc(i.name)}</span><span class="rnum">${esc(i.qty)}</span></div>`).join("")}</div>
    <details class="mail-body" open><summary>How to make it</summary><pre>${esc(m.instructions)}</pre></details>
    <p class="hint">${m.youtube ? `<a href="${esc(m.youtube)}" target="_blank" rel="noopener">▶️ Video</a> · ` : ""}${m.source ? `<a href="${esc(m.source)}" target="_blank" rel="noopener">Original recipe ↗</a> · ` : ""}From TheMealDB</p>
    <div class="sheet-actions">
      <button type="button" class="btn secondary" id="d-back">Back</button>
      ${missing.length ? `<button type="button" class="btn secondary" id="d-list">🛒 +${missing.length}</button>` : ""}
      <button type="button" class="btn secondary" id="d-save">Save</button>
      <button type="button" class="btn" id="d-tonight">Tonight</button>
    </div>`, body => {
    const save = async () => (await api(`/api/meals/cook/meal/${encodeURIComponent(mid)}/save`, { method: "POST" })).id;
    body.querySelector("#d-back").addEventListener("click", cookResults);
    body.querySelector("#d-list")?.addEventListener("click", () => run(async () => {
      const x = await api("/api/meals/list", { method: "POST", body: { text: missing.map(i => i.name).join("\n"), source: m.name } });
      toast(`Added ${x.added.length} to the list`);
    }));
    body.querySelector("#d-save").addEventListener("click", () => run(async () => { await save(); toast("Saved to your recipes"); }));
    body.querySelector("#d-tonight").addEventListener("click", () => run(async () => {
      const rid = await save();
      await api(`/api/meals/plan/${today}`, { method: "PUT", body: { recipe_id: rid } });
      closeSheet(); toast(`Tonight: ${m.name}`); show("plan");
    }));
  });
}

// ------------------------------------------------------------ grocery list

async function renderList() {
  state.list = await api("/api/meals/list");
  const open = state.list.filter(i => !i.done), done = state.list.filter(i => i.done);
  const groups = {};
  for (const i of open) (groups[i.category || "🛒 Other"] ||= []).push(i);
  const deal = i => {
    const ds = state.deals?.list?.[i.name];
    if (!ds || !ds.length) return "";
    const b = ds[0];
    return `<div><span class="deal-badge">💲 ${esc(money(b))} · ${esc(b.store)}</span></div>`;
  };
  const row = i => `<div class="gro ${i.done ? "done" : ""}" data-item="${i.id}">
    <button class="box" data-tick="${i.id}" aria-label="${i.done ? "Untick" : "Got it"}">${i.done ? "✓" : ""}</button>
    <div class="gmain" data-edit-item="${i.id}"><span class="gname">${esc(i.name)}</span>${i.qty ? `<span class="gqty">${esc(i.qty)}</span>` : ""}
      ${i.source || i.store ? `<div class="gmeta">${[i.store && `🏪 ${esc(i.store)}`, i.source && esc(i.source)].filter(Boolean).join(" · ")}</div>` : ""}
      ${i.done ? "" : deal(i)}</div></div>`;
  $("#view-list").innerHTML = `
    <form class="add-bar" id="add-form"><input name="item" placeholder="Add to the list (e.g. 2 L milk)" autocomplete="off" enterkeyhint="done">
      <button class="btn">Add</button></form>
    <div class="row-actions"><button class="btn secondary" id="add-many">📋 Add several</button>
      <button class="btn secondary" id="find-deals">💲 ${state.deals ? "Update deals" : "Find deals"}</button></div>
    ${open.length ? `<div class="card list">${Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([g, items]) =>
      `<div class="group-h">${esc(g)}</div>${items.map(row).join("")}`).join("")}</div>`
      : `<div class="empty">The list is empty. Add things above, or from the Suppers tab.</div>`}
    ${done.length ? `<h3 class="section-h">Got it (${done.length})</h3><div class="card list">${done.map(row).join("")}</div>
      <p class="hint center"><button class="linkish" id="clear-done">Clear what's ticked</button> · ticked things go In the house</p>` : ""}`;
}

async function loadDeals() {
  toast("Checking this week's flyers…");
  state.deals = await api("/api/meals/flyers/deals");
  const found = Object.values(state.deals.list).filter(d => d.length).length;
  toast(found ? `On sale this week: ${found} thing${found === 1 ? "" : "s"} on your list` : "Nothing on your list is on sale this week");
}

function editItem(item) {
  const ds = state.deals?.list?.[item.name] || [];
  openSheet(`
    <h2>${esc(item.name)}</h2>
    <form id="item-form">
      <div class="two"><label>Item<input name="name" value="${esc(item.name)}" required></label>
        <label>How much<input name="qty" value="${esc(item.qty)}" placeholder="2 L"></label></div>
      <label>Store (optional)<input name="store" value="${esc(item.store)}" placeholder="Where to get it" list="store-names"></label>
      <datalist id="store-names">${(state.deals?.stores || []).map(s => `<option value="${esc(s)}">`).join("")}</datalist>
      ${ds.length ? `<h3 class="section-h">💲 On sale</h3><div class="card list">${ds.map(dealRow).join("")}</div>`
        : `<p class="hint">${state.deals ? "Not in this week's flyers at your stores." : "Tap “Find deals” on the list to check the flyers."}</p>`}
      <div class="sheet-actions">
        <button type="button" class="btn danger" id="i-del">Remove</button>
        <button type="button" class="btn secondary" id="i-cancel">Cancel</button><button class="btn">Save</button>
      </div>
    </form>`, body => {
    body.querySelector("#i-cancel").addEventListener("click", closeSheet);
    body.querySelector("#i-del").addEventListener("click", () => run(async () => { await api(`/api/meals/list/${item.id}`, { method: "DELETE" }); closeSheet(); renderList(); }));
    body.querySelectorAll("[data-deal-store]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); body.querySelector("[name=store]").value = b.dataset.dealStore; }));
    body.querySelector("#item-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => { await api(`/api/meals/list/${item.id}`, { method: "PUT", body: { name: f.name.value, qty: f.qty.value, store: f.store.value } }); closeSheet(); renderList(); });
    });
  });
}

function addMany(target) {
  openSheet(`
    <h2>${target === "pantry" ? "Add what you have" : "Add several"}</h2>
    <form id="many-form">
      <label>One per line<textarea name="text" rows="8" placeholder="2 L milk&#10;bread&#10;1 lb ground beef&#10;bananas"></textarea></label>
      ${target === "pantry" ? `<label>Where<select name="place"><option value="">Guess for each</option>${PLACES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>` : ""}
      <div class="sheet-actions"><button type="button" class="btn secondary" id="m-cancel">Cancel</button><button class="btn">Add</button></div>
    </form>`, body => {
    body.querySelector("#m-cancel").addEventListener("click", closeSheet);
    body.querySelector("#many-form").addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        const r = await api(target === "pantry" ? "/api/meals/pantry" : "/api/meals/list", { method: "POST",
          body: { text: e.target.text.value, place: e.target.place?.value || "" } });
        closeSheet(); toast(`Added ${r.added.length}`); render();
      });
    });
  });
}

// ------------------------------------------------------------ in the house

async function renderPantry() {
  const items = await api("/api/meals/pantry");
  $("#view-pantry").innerHTML = `
    <form class="add-bar" id="pantry-form"><input name="item" placeholder="Add something you have" autocomplete="off" enterkeyhint="done">
      <button class="btn">Add</button></form>
    <div class="row-actions"><button class="btn secondary" id="pantry-many">📋 Add several</button>
      <button class="btn secondary" id="ideas-btn2">🧑‍🍳 Cook with this</button></div>
    ${PLACES.map(([k, label]) => {
      const list = items.filter(i => i.place === k);
      return list.length ? `<h3 class="section-h">${label}</h3><div class="card list">${list.map(i => `
        <div class="row"><div class="row-main"><div class="row-title">${esc(i.name)}${i.qty ? ` <span class="gqty">${esc(i.qty)}</span>` : ""}</div>
          <div class="row-meta">${i.from_list ? "from the grocery list · " : ""}${esc(relDay(i.added.slice(0, 10), today))}</div></div>
          <button class="btn secondary small" data-used="${i.id}" title="Used up">Used up</button>
          <button class="btn secondary small" data-rebuy="${i.id}" title="Used up, put it on the list">🛒</button></div>`).join("")}</div>` : "";
    }).join("") || `<div class="empty">Nothing here yet. Things you tick off the grocery list land here, or add what you have.</div>`}
    <p class="hint center">🛒 = used up, put it back on the grocery list.</p>`;
}

// ------------------------------------------------------------ recipes

async function renderRecipes() {
  state.recipes = await api("/api/meals/recipes");
  $("#view-recipes").innerHTML = `
    <div class="row-actions"><button class="btn" id="new-recipe">+ New recipe</button></div>
    <input id="recipe-search" placeholder="Search recipes" autocomplete="off" style="margin:4px 0 10px">
    <div class="card list">${state.recipes.map(r => `<div class="row" data-recipe="${r.id}">
      <div class="row-main"><div class="row-title">${esc(r.emoji)} ${esc(r.name)}</div>
        <div class="row-meta">${r.minutes ? `${r.minutes} min · ` : ""}${r.items.map(i => esc(i.name)).join(", ")}</div></div>
      <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></div>`).join("") || `<div class="empty">No recipes yet.</div>`}</div>`;
  $("#recipe-search").addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll("[data-recipe]").forEach(r => (r.hidden = !r.textContent.toLowerCase().includes(q)));
  });
}

function recipeForm(r = null) {
  openSheet(`
    <h2>${r ? "Edit recipe" : "New recipe"}</h2>
    <form id="recipe-form">
      <div class="two" style="grid-template-columns:70px 1fr"><label>Emoji<input name="emoji" value="${esc(r?.emoji || "🍽️")}" maxlength="8"></label>
        <label>Name<input name="name" required value="${esc(r?.name || "")}" placeholder="Chicken pot pie"></label></div>
      <label>Minutes (optional)<input name="minutes" type="number" min="1" max="600" value="${r?.minutes || ""}"></label>
      <label>Ingredients, one per line<textarea name="ingredients" rows="8" placeholder="2 lb chicken breast&#10;1 bag frozen mixed vegetables&#10;pie crust">${esc((r?.items || []).map(i => `${i.qty ? i.qty + " " : ""}${i.name}`).join("\n"))}</textarea></label>
      <label>Notes or steps (optional)<textarea name="notes" rows="3">${esc(r?.notes || "")}</textarea></label>
      <label>Link (optional)<input name="url" type="url" value="${esc(r?.url || "")}" placeholder="https://…"></label>
      ${r?.url ? `<p class="hint"><a href="${esc(r.url)}" target="_blank" rel="noopener">Open the recipe ↗</a></p>` : ""}
      <div class="sheet-actions">
        ${r ? `<button type="button" class="btn danger" id="r-del">Delete</button>` : ""}
        ${r ? `<button type="button" class="btn secondary" id="r-list">🛒 To list</button>` : ""}
        <button type="button" class="btn secondary" id="r-cancel">Cancel</button><button class="btn">Save</button>
      </div>
    </form>`, body => {
    body.querySelector("#r-cancel").addEventListener("click", closeSheet);
    body.querySelector("#r-del")?.addEventListener("click", () => run(async () => {
      if (!confirm(`Delete ${r.name}?`)) return;
      await api(`/api/meals/recipes/${r.id}`, { method: "DELETE" }); closeSheet(); renderRecipes();
    }));
    body.querySelector("#r-list")?.addEventListener("click", () => run(async () => {
      const x = await api("/api/meals/list", { method: "POST", body: { text: r.items.map(i => `${i.qty} ${i.name}`.trim()).join("\n"), source: r.name } });
      toast(`Added ${x.added.length} to the list`);
    }));
    body.querySelector("#recipe-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      const b = { name: f.name.value, emoji: f.emoji.value, minutes: f.minutes.value ? Number(f.minutes.value) : null,
        ingredients: f.ingredients.value, notes: f.notes.value, url: f.url.value };
      run(async () => {
        await api(r ? `/api/meals/recipes/${r.id}` : "/api/meals/recipes", { method: r ? "PUT" : "POST", body: b });
        closeSheet(); toast("Saved"); renderRecipes();
      });
    });
  });
}

// ------------------------------------------------------------ deals (Flipp flyers)

function dealRow(d) {
  return `<div class="deal">
    ${d.image ? `<img src="${esc(d.image)}" alt="" loading="lazy">` : `<div class="noimg">🏷️</div>`}
    <div><div class="dname">${esc(d.name)}</div><div class="dmeta">${esc(d.store)}${d.to ? ` · ${esc(until(d))}` : ""}${d.sale_story ? ` · ${esc(d.sale_story)}` : ""}</div>
      <button class="btn secondary small add-btn" data-add-deal="${esc(d.name)}" data-deal-store="${esc(d.store)}">+ List</button></div>
    <div class="dprice">${esc(money(d))}${d.text && d.price != null && d.text !== money(d) ? `<small>${esc(d.text)}</small>` : ""}</div></div>`;
}

async function renderDeals() {
  const s = await api("/api/meals/flyers/settings");
  state.flyer = s;
  const chosen = new Set(s.stores.map(x => x.toLowerCase()));
  const chip = st => `<button type="button" class="chip ${chosen.has(st.name.toLowerCase()) ? "on" : ""}" data-store="${esc(st.name)}">
    ${st.logo ? `<img src="${esc(st.logo)}" alt="">` : ""}${esc(st.name)}</button>`;
  const grocery = s.available.filter(x => x.grocery || x.pharmacy), other = s.available.filter(x => !x.grocery && !x.pharmacy);
  $("#view-deals").innerHTML = `
    <form class="add-bar" id="search-form"><input name="q" placeholder="Search the flyers (e.g. chicken breast)" autocomplete="off" enterkeyhint="search">
      <button class="btn">Search</button></form>
    <label class="switch" style="margin:-2px 4px 10px"><input type="checkbox" id="all-stores"> Search every store, not just mine</label>
    <div id="search-results"></div>

    <h3 class="section-h">⭐ Watch list</h3>
    <div class="watch-chips">${s.watch.map(w => `<button type="button" class="chip small" data-watch-del="${esc(w)}">${esc(w)}<b>×</b></button>`).join("")}
      <button type="button" class="chip small" id="watch-add">+ Add</button></div>
    <p class="hint">Things you always want a deal on. Their sale prices show below.</p>
    <div id="watch-results"></div>

    <h3 class="section-h">📰 Browse a store's flyer</h3>
    <div class="store-chips">${s.available.filter(x => chosen.has(x.name.toLowerCase())).map(st =>
      `<button type="button" class="chip" data-browse="${esc(st.name)}">${st.logo ? `<img src="${esc(st.logo)}" alt="">` : ""}${esc(st.name)}</button>`).join("")}</div>
    <div id="browse"></div>

    <h3 class="section-h">🏪 My stores</h3>
    ${s.error ? `<p class="hint danger">${esc(s.error)}</p>` : ""}
    <p class="hint">Tap to choose where you shop. ${s.stores.length ? `Deals and searches only look at these (${s.stores.length} chosen).` : "None chosen yet, so every store near you is searched."}</p>
    <div class="store-chips">${grocery.map(chip).join("")}</div>
    ${other.length ? `<details><summary class="hint">Other stores near you (${other.length})</summary><div class="store-chips">${other.map(chip).join("")}</div></details>` : ""}
    <form class="two" id="postal-form" style="align-items:end;margin-top:8px">
      <label>Postal or ZIP code<input name="postal" value="${esc(s.postal)}" maxlength="7" autocomplete="postal-code"></label>
      <button class="btn secondary">Save</button></form>
    <p class="hint">Prices come from the stores' weekly flyers through Flipp. Check the price in store; some deals need the store's loyalty card.</p>`;
  if (s.watch.length) run(loadWatch);
}

async function loadWatch() {
  const el = $("#watch-results");
  if (!el) return;
  el.innerHTML = `<div class="empty small">Checking the flyers…</div>`;
  const d = await api("/api/meals/flyers/deals");
  state.deals = d;
  el.innerHTML = Object.entries(d.watch).map(([name, ds]) => `<div class="card list"><div class="group-h">${esc(name)}</div>
    ${ds.length ? ds.map(dealRow).join("") : `<div class="deal"><div class="noimg">—</div><div class="dmeta">Not on sale this week at your stores</div><div></div></div>`}</div>`).join("");
}

async function searchFlyers(q) {
  const el = $("#search-results");
  el.innerHTML = `<div class="empty small">Searching…</div>`;
  const all = $("#all-stores").checked;
  const r = await api(`/api/meals/flyers/search?q=${encodeURIComponent(q)}${all ? "&all_stores=true" : ""}`);
  el.innerHTML = r.length ? `<div class="card list">${r.map(dealRow).join("")}</div>`
    : `<div class="empty small">No flyer deals for “${esc(q)}” ${all ? "near you" : "at your stores"} this week.</div>`;
}

async function browseStore(name) {
  const el = $("#browse");
  el.innerHTML = `<div class="empty small">Opening ${esc(name)}'s flyer…</div>`;
  const d = await api(`/api/meals/flyers/store?name=${encodeURIComponent(name)}`);
  if (!d.flyers.length) return (el.innerHTML = `<div class="empty small">No current flyer for ${esc(name)}.</div>`);
  el.innerHTML = `<input id="flyer-filter" placeholder="Filter ${esc(name)}'s flyer" autocomplete="off" style="margin-bottom:8px">` +
    d.flyers.map(f => `<p class="hint"><b>${esc(f.name)}</b> · ${esc(relDay(f.from, today))} – ${esc(relDay(f.to, today))} · ${f.items.length} items</p>
      <div class="flyer-grid">${f.items.map(i => `<div class="fitem" data-fname="${esc(i.name.toLowerCase())}">
        ${i.image ? `<img src="${esc(i.image)}" alt="" loading="lazy">` : ""}
        <div class="fname">${esc(i.name)}</div><div class="fprice">${esc(money(i))}</div>
        <button class="btn secondary small" data-add-deal="${esc(i.name)}" data-deal-store="${esc(name)}">+ List</button></div>`).join("")}</div>`).join("");
  $("#flyer-filter").addEventListener("input", e => {
    const q = e.target.value.toLowerCase();
    el.querySelectorAll("[data-fname]").forEach(x => (x.hidden = !x.dataset.fname.includes(q)));
  });
}

async function saveFlyerSettings(body) {
  await api("/api/meals/flyers/settings", { method: "PUT", body });
  state.deals = null;
}

// ------------------------------------------------------------ navigation and clicks

async function render() {
  $("#page-title").textContent = TITLES[state.view];
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== `view-${state.view}`));
  const el = $(`#view-${state.view}`);
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="empty">Loading…</div>`;
  await run(({ plan: renderPlan, list: renderList, pantry: renderPantry, recipes: renderRecipes, deals: renderDeals })[state.view]);
}

function show(view) { state.view = view; store("view", view); scrollTo(0, 0); render(); }

document.addEventListener("click", e => {
  const t = e.target;
  const tab = t.closest(".tabs button");
  if (tab) return show(tab.dataset.view);
  const wk = t.closest("[data-week]");
  if (wk) { state.week = addDays(state.week, Number(wk.dataset.week)); return run(renderPlan); }
  const day = t.closest("[data-day]");
  if (day) return pickSupper(day.dataset.day);
  if (t.closest("#week-to-list")) return run(async () => {
    const r = await api("/api/meals/plan/to-list", { method: "POST", body: { start: state.week, days: 7 } });
    toast(r.added.length ? `Added ${r.added.length} to the list${r.have.length ? ` · already have ${r.have.length}` : ""}` : "Nothing new to add");
  });
  if (t.closest("#ideas-btn") || t.closest("#ideas-btn2")) return run(cookPicker);
  const tick = t.closest("[data-tick]");
  if (tick) return run(async () => {
    const it = state.list.find(i => i.id === Number(tick.dataset.tick));
    await api(`/api/meals/list/${it.id}`, { method: "PUT", body: { done: !it.done } });
    renderList();
  });
  const ed = t.closest("[data-edit-item]");
  if (ed) return editItem(state.list.find(i => i.id === Number(ed.dataset.editItem)));
  if (t.closest("#add-many")) return addMany("list");
  if (t.closest("#pantry-many")) return addMany("pantry");
  if (t.closest("#find-deals")) return run(async () => { await loadDeals(); renderList(); });
  if (t.closest("#clear-done")) return run(async () => { await api("/api/meals/list/clear", { method: "POST" }); renderList(); });
  const used = t.closest("[data-used]") || t.closest("[data-rebuy]");
  if (used) return run(async () => {
    const id = used.dataset.used || used.dataset.rebuy;
    await api(`/api/meals/pantry/${id}${used.dataset.rebuy ? "?to_list=true" : ""}`, { method: "DELETE" });
    toast(used.dataset.rebuy ? "Put back on the grocery list" : "Used up"); renderPantry();
  });
  if (t.closest("#new-recipe")) return recipeForm();
  const rec = t.closest("[data-recipe]");
  if (rec) return recipeForm(state.recipes.find(r => r.id === Number(rec.dataset.recipe)));
  const addDeal = t.closest("[data-add-deal]");
  if (addDeal && !t.closest("#item-form")) return run(async () => {
    await api("/api/meals/list", { method: "POST", body: { text: addDeal.dataset.addDeal, source: `on sale at ${addDeal.dataset.dealStore}` } });
    addDeal.textContent = "✓ Added"; addDeal.disabled = true;
  });
  const st = t.closest("[data-store]");
  if (st) return run(async () => {
    const name = st.dataset.store;
    const on = !st.classList.contains("on");
    const stores = on ? [...state.flyer.stores, name] : state.flyer.stores.filter(x => x.toLowerCase() !== name.toLowerCase());
    await saveFlyerSettings({ stores });
    toast(on ? `Added ${name}` : `Removed ${name}`); renderDeals();
  });
  const br = t.closest("[data-browse]");
  if (br) return run(() => browseStore(br.dataset.browse));
  const wd = t.closest("[data-watch-del]");
  if (wd) return run(async () => { await saveFlyerSettings({ watch: state.flyer.watch.filter(w => w !== wd.dataset.watchDel) }); renderDeals(); });
  if (t.closest("#watch-add")) {
    const w = prompt("Watch for which item? (e.g. ground beef, cereal, diapers)");
    if (w && w.trim()) run(async () => { await saveFlyerSettings({ watch: [...state.flyer.watch, w.trim()] }); renderDeals(); });
  }
});

document.addEventListener("submit", e => {
  const f = e.target;
  if (f.id === "add-form" || f.id === "pantry-form") {
    e.preventDefault();
    const v = f.item.value.trim();
    if (!v) return;
    run(async () => {
      await api(f.id === "add-form" ? "/api/meals/list" : "/api/meals/pantry", { method: "POST", body: { text: v } });
      f.item.value = "";
      if (f.id === "add-form") { await renderList(); $("#add-form [name=item]").focus(); } else { await renderPantry(); $("#pantry-form [name=item]").focus(); }
    });
  } else if (f.id === "search-form") {
    e.preventDefault();
    if (f.q.value.trim()) run(() => searchFlyers(f.q.value.trim()));
  } else if (f.id === "postal-form") {
    e.preventDefault();
    run(async () => { await saveFlyerSettings({ postal: f.postal.value }); toast("Saved"); renderDeals(); });
  }
});

$("#sheet-backdrop").addEventListener("click", closeSheet);
$("#refresh-btn").addEventListener("click", () => { if (state.view === "list" && state.deals) run(async () => { await loadDeals(); renderList(); }); else render(); });

// The back link returns to the page Meals was opened from (My page, the phone page, the planner).
const BACK = { "/me": "← My page", "/my-shifts": "← My planner", "/mobile": "← Family board", "/": "← Planner", "/admin": "← Admin" };
function setBack(role) {
  let from = "";
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && ref.origin === location.origin && BACK[ref.pathname]) sessionStorage.setItem("meals-back", ref.pathname);
    from = sessionStorage.getItem("meals-back") || "";
  } catch (_) {}
  if (!BACK[from]) from = role === "member" ? "/my-shifts" : "/";
  $("#back-link").href = from;
  $("#back-link").textContent = BACK[from];
}

run(async () => {
  const me = await api("/api/me").catch(() => ({}));
  setBack(me.role);
  state.view = TITLES[recall("view")] ? recall("view") : "plan";
  const hash = location.hash.slice(1);
  if (TITLES[hash]) state.view = hash;
  await render();
});
