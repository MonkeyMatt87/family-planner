// Phone app. Plain JS, no build step.

const state = {
  view: "home",
  today: toISO(new Date()),
  people: [],
  byId: {},
  templates: [],
  taskFilter: "all",
  workPerson: null,
  workPick: null,     // {label, start_time, end_time} to tap onto days, or "clear"
  workChoices: [],    // shifts offered on the Work tab: recent ones first, then shift types
  workMonth: null,    // first day of shown month (ISO)
};

const $ = sel => document.querySelector(sel);
const TITLES = { home: "Home", tasks: "Tasks", lunch: "School Lunch", work: "Work Schedule", bills: "Bills", settings: "Settings" };

function store(key, value) {
  try { value === undefined ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch (_) {}
}
function recall(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 4000 : 1800);
}

async function run(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

function dot(color) {
  return `<span class="dot" style="background:${esc(color)}"></span>`;
}

function personOptions(selected, allowNone = true, noneLabel = "Everyone") {
  let html = allowNone ? `<option value="">${noneLabel}</option>` : "";
  for (const p of state.people) {
    html += `<option value="${p.id}" ${String(selected) === String(p.id) ? "selected" : ""}>${esc(p.name)}</option>`;
  }
  return html;
}

// ------------------------------------------------------------ navigation

function show(view) {
  state.view = view;
  store("view", view);
  history.replaceState(null, "", `#${view}`);
  document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== `view-${view}`));
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#page-title").textContent = TITLES[view];
  $("#fab").hidden = !(view === "home" || view === "tasks");
  window.scrollTo(0, 0);
  render();
}

function render() {
  state.today = toISO(new Date());
  const d = new Date();
  if (!ADMIN) $("#page-sub").textContent = `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
  return run(() => ({ home: renderHome, tasks: renderTasks, lunch: renderLunch, work: renderWork, bills: renderBills, settings: renderSettings })[state.view]());
}

async function loadPeople() {
  state.people = await api("/api/people");
  state.byId = personMap(state.people);
}

// ------------------------------------------------------------ bottom sheet

function openSheet(html, onMount) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheet-backdrop").hidden = false;
  requestAnimationFrame(() => $("#sheet").classList.add("open"));
  if (onMount) onMount($("#sheet-body"));
}

function closeSheet() {
  $("#sheet").classList.remove("open");
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
}

$("#sheet-backdrop").addEventListener("click", closeSheet);

// ------------------------------------------------------------ home

async function renderHome() {
  const [items, lunch] = await Promise.all([
    api(`/api/agenda?start=${state.today}&end=${addDays(state.today, 14)}`),
    api(`/api/lunch?start=${state.today}&end=${addDays(state.today, 4)}`),
  ]);

  let html = `<div class="row-actions"><button class="btn secondary" id="add-appt-btn">📅 Add an appointment</button>
    <a class="btn secondary" href="/meals" style="text-align:center;text-decoration:none">🍽️ Meals &amp; groceries</a></div>`;
  const lunchDay = lunch.find(l => !l.no_school);
  if (lunchDay && state.people.some(p => p.is_kid)) {
    html += `<div class="card lunch-card" data-go="lunch">
      <div class="card-label">Lunch · ${relDay(lunchDay.date, state.today)}</div>
      ${lunchDay.menu ? `<div class="menu-text">${esc(lunchDay.menu)}</div>` : ""}
      <div class="lunch-kids">${lunchDay.kids.map(k => {
        const p = state.byId[k.person_id];
        return p ? `<span class="pill ${k.choice || "unset"}">${dot(p.color)}${esc(p.name)}: ${k.choice ? LUNCH_LABELS[k.choice] : "not set"}</span>` : "";
      }).join("")}</div>
    </div>`;
  }

  const byDay = {};
  for (const it of items) (byDay[it.date] ||= []).push(it);
  const dates = Object.keys(byDay).sort();
  if (!byDay[state.today]) dates.unshift(state.today);

  for (const day of dates) {
    const list = byDay[day] || [];
    html += `<h3 class="day-h ${day === state.today ? "is-today" : ""}">${relDay(day, state.today)}
      <span>${MONTH_NAMES[parseISO(day).getMonth()].slice(0, 3)} ${parseISO(day).getDate()}</span></h3>`;
    if (!list.length) {
      html += `<div class="empty small">Nothing on the calendar.</div>`;
      continue;
    }
    html += `<div class="card list">${list.map(agendaRow).join("")}</div>`;
  }

  if (!items.length) {
    html += `<div class="empty">Nothing coming up in the next two weeks.<br>
      Add Google Calendars in <a href="#" data-go="settings">Settings</a>, or tap + to add a task.</div>`;
  }
  $("#view-home").innerHTML = html;
}

function agendaRow(it) {
  const color = itemColor(it, state.byId);
  const who = state.byId[it.person_id];
  let meta = "";
  if (it.source === "task") meta = `Due · ${CATEGORY_LABELS[it.category] || "Task"}`;
  else if (it.source === "shift") meta = `${fmtRange(it)}${it.overnight ? " (overnight)" : ""}`;
  else if (it.source === "holiday") meta = it.kind === "holiday" ? "Holiday" : "";
  else meta = it.all_day ? "All day" : fmtRange(it);
  if (it.location) meta += ` · ${esc(it.location)}`;
  const attrs = it.source === "task" ? `data-task="${it.id}"` : it.source === "appt" ? `data-appt="${it.id}" data-date="${it.date}"` : "";
  return `<div class="row ${it.source}" ${attrs}>
    <span class="bar" style="background:${esc(color)}"></span>
    <div class="row-main">
      <div class="row-title">${it.source === "shift" && who ? `${esc(nameOf(who))} – ` : ""}${esc(it.title)}</div>
      <div class="row-meta">${meta}${who && it.source !== "shift" && !it.who_in_title ? ` · ${esc(nameOf(who))}` : ""}</div>
    </div>
  </div>`;
}

// ------------------------------------------------------------ tasks

async function renderTasks() {
  const tasks = await api("/api/tasks");
  const f = state.taskFilter;
  $("#task-filter").innerHTML = [["all", "All"], ...state.people.map(p => [String(p.id), p.name]), ["none", "Family"]]
    .map(([v, label]) => `<button class="chip ${f === v ? "on" : ""}" data-filter="${v}">${esc(label)}</button>`).join("");

  const shown = tasks.filter(t => f === "all" || (f === "none" ? !t.person_id : String(t.person_id) === f));
  const groups = { Overdue: [], "This week": [], Later: [], "No date": [], Done: [] };
  for (const t of shown) {
    if (t.done) groups.Done.push(t);
    else if (!t.due_date) groups["No date"].push(t);
    else {
      const diff = daysBetween(state.today, t.due_date);
      if (diff < 0) groups.Overdue.push(t);
      else if (diff < 7) groups["This week"].push(t);
      else groups.Later.push(t);
    }
  }

  let html = "";
  for (const [name, list] of Object.entries(groups)) {
    if (!list.length) continue;
    html += `<h3 class="section-h ${name === "Overdue" ? "danger" : ""}">${name}</h3><div class="card list">`;
    for (const t of list) {
      const p = state.byId[t.person_id];
      const due = t.due_date ? relDay(t.due_date, state.today) : "";
      html += `<div class="row task-row ${t.done ? "done" : ""}" data-task="${t.id}">
        <button class="check ${t.done ? "on" : ""}" data-toggle="${t.id}" aria-label="Mark done">
          <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
        </button>
        <div class="row-main">
          <div class="row-title">${esc(t.title)}</div>
          <div class="row-meta">${[p ? dot(p.color) + esc(p.name) : "Family", CATEGORY_LABELS[t.category], due].filter(Boolean).join(" · ")}</div>
          ${t.notes ? `<div class="row-notes">${esc(t.notes)}</div>` : ""}
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  $("#task-list").innerHTML = html || `<div class="empty">No tasks. Tap + to add one.</div>`;
  renderTasks.cache = tasks;
}

function apptForm(appt = null) {
  appointmentSheet({ appt, people: state.people, day: state.today, base: "/api/appointments", onSaved: render });
}

function taskForm(task = {}) {
  const isNew = !task.id;
  const presetPerson = task.person_id ?? (state.taskFilter !== "all" && state.taskFilter !== "none" ? state.taskFilter : "");
  openSheet(`
    <h2>${isNew ? "New task" : "Edit task"}</h2>
    <form id="task-form">
      <label>What<input name="title" required value="${esc(task.title || "")}" placeholder="Science fair poster" autocomplete="off"></label>
      <div class="two">
        <label>Who<select name="person_id">${personOptions(presetPerson, true, "Family")}</select></label>
        <label>Type<select name="category">${Object.entries(CATEGORY_LABELS).map(([v, l]) =>
          `<option value="${v}" ${(task.category || "school") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <label>Due date<input type="date" name="due_date" value="${esc(task.due_date || "")}"></label>
      <div class="quick-dates">
        <button type="button" class="chip" data-due="${state.today}">Today</button>
        <button type="button" class="chip" data-due="${addDays(state.today, 1)}">Tomorrow</button>
        <button type="button" class="chip" data-due="${addDays(state.today, 7)}">Next week</button>
        <button type="button" class="chip" data-due="">No date</button>
      </div>
      <label>Notes<textarea name="notes" rows="3" placeholder="Supplies, teacher, details…">${esc(task.notes || "")}</textarea></label>
      <div class="sheet-actions">
        ${isNew ? "" : `<button type="button" class="btn danger" id="task-delete">Delete</button>`}
        <button type="button" class="btn secondary" id="sheet-cancel">Cancel</button>
        <button type="submit" class="btn">${isNew ? "Add" : "Save"}</button>
      </div>
    </form>`, body => {
    const form = body.querySelector("#task-form");
    if (isNew) setTimeout(() => form.title.focus(), 250);
    body.querySelectorAll("[data-due]").forEach(b => b.addEventListener("click", () => (form.due_date.value = b.dataset.due)));
    body.querySelector("#sheet-cancel").addEventListener("click", closeSheet);
    body.querySelector("#task-delete")?.addEventListener("click", () => run(async () => {
      await api(`/api/tasks/${task.id}`, { method: "DELETE" });
      closeSheet(); toast("Deleted"); render();
    }));
    form.addEventListener("submit", e => {
      e.preventDefault();
      const data = {
        title: form.title.value,
        person_id: form.person_id.value ? Number(form.person_id.value) : null,
        category: form.category.value,
        due_date: form.due_date.value || null,
        notes: form.notes.value,
        done: !!task.done,
      };
      run(async () => {
        if (isNew) await api("/api/tasks", { method: "POST", body: data });
        else await api(`/api/tasks/${task.id}`, { method: "PUT", body: data });
        closeSheet(); toast(isNew ? "Task added" : "Saved"); render();
      });
    });
  });
}

async function editTask(id) {
  const t = (await api("/api/tasks?include_done=true")).find(x => x.id === id);
  if (t) taskForm(t);
}

async function toggleTask(id) {
  const t = (renderTasks.cache || []).find(x => x.id === id);
  if (!t) return;
  await api(`/api/tasks/${id}`, { method: "PUT", body: { ...t, done: !t.done } });
  if (!t.done) toast(`Done: ${t.title}`);
  render();
}

// ------------------------------------------------------------ lunch

async function renderLunch() {
  const kids = state.people.filter(p => p.is_kid);
  if (!kids.length) {
    $("#lunch-list").innerHTML = `<div class="empty">Mark who is a kid in Settings → People.</div>`;
    return;
  }
  const days = await api(`/api/lunch?start=${state.today}&end=${addDays(state.today, 35)}`);
  let html = "";
  let week = null;
  for (const d of days) {
    const dt = parseISO(d.date);
    const monday = addDays(d.date, -((dt.getDay() + 6) % 7));
    if (monday !== week) {
      week = monday;
      html += `<h3 class="section-h">Week of ${MONTH_NAMES[parseISO(monday).getMonth()].slice(0, 3)} ${parseISO(monday).getDate()}</h3>`;
    }
    html += `<div class="card lunch-day ${d.no_school ? "no-school" : ""} ${d.date === state.today ? "is-today" : ""}">
      <div class="lunch-head" data-menu="${d.date}">
        <div>
          <div class="lunch-date">${relDay(d.date, state.today)}</div>
          <div class="menu-text ${d.menu ? "" : "muted"}">${d.no_school ? "No school" + (d.holiday ? ` – ${esc(d.holiday)}` : d.menu && d.menu !== "No lunch service" ? ` – ${esc(d.menu)}` : "") : esc(d.menu) || "Add menu…"}</div>
        </div>
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </div>
      ${d.no_school ? "" : `<div class="lunch-kids-grid">${d.kids.map(k => {
        const p = state.byId[k.person_id];
        if (!p) return "";
        return `<div class="kid-row">
          <span class="kid-name">${dot(p.color)}${esc(p.name)}${k.liked ? ` <span class="liked" title="On ${esc(p.name)}'s favourites">★</span>` : ""}</span>
          <div class="seg" data-date="${d.date}" data-person="${p.id}">
            ${["buy", "pack"].map(c => `<button class="${k.choice === c ? "on " + c : ""}" data-choice="${c}">${LUNCH_SHORT[c]}</button>`).join("")}
          </div>
        </div>`;
      }).join("")}</div>`}
    </div>`;
  }
  $("#lunch-list").innerHTML = html;
}

function menuForm(dateISO) {
  run(async () => {
    const [day] = await api(`/api/lunch?start=${dateISO}&end=${addDays(dateISO, 1)}`);
    openSheet(`
      <h2>${relDay(dateISO, state.today)}</h2>
      <form id="menu-form">
        <label>School lunch menu<input name="menu" value="${esc(day?.menu || "")}" placeholder="Chicken nuggets, fries, apple" autocomplete="off"></label>
        <label class="switch"><input type="checkbox" name="no_school" ${day?.no_school ? "checked" : ""}> No school this day</label>
        <div class="sheet-actions">
          <button type="button" class="btn secondary" id="sheet-cancel">Cancel</button>
          <button type="submit" class="btn">Save</button>
        </div>
      </form>`, body => {
      const form = body.querySelector("#menu-form");
      body.querySelector("#sheet-cancel").addEventListener("click", closeSheet);
      form.addEventListener("submit", e => {
        e.preventDefault();
        run(async () => {
          await api(`/api/lunch/${dateISO}`, { method: "PUT", body: { menu: form.menu.value, no_school: form.no_school.checked } });
          closeSheet(); render();
        });
      });
    });
  });
}

function importForm() {
  openSheet(`
    <h2>Paste lunch menu</h2>
    <p class="hint">One day per line. Copy from the school menu or type it. Examples:</p>
    <pre class="example">9/29 Chicken nuggets
Tue Sept 30 - Pizza day
Oct 1: Tacos
Oct 10 No school - PD Day</pre>
    <form id="import-form">
      <textarea name="text" rows="9" placeholder="Paste here…"></textarea>
      <div class="sheet-actions">
        <button type="button" class="btn secondary" id="sheet-cancel">Cancel</button>
        <button type="submit" class="btn">Import</button>
      </div>
    </form>`, body => {
    const form = body.querySelector("#import-form");
    body.querySelector("#sheet-cancel").addEventListener("click", closeSheet);
    form.addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        const r = await api("/api/lunch/import", { method: "POST", body: { text: form.text.value } });
        closeSheet();
        toast(`Imported ${r.imported} day${r.imported === 1 ? "" : "s"}${r.skipped.length ? ` · skipped ${r.skipped.length} line(s)` : ""}`);
        render();
      });
    });
  });
}

async function defaultsForm() {
  const kids = state.people.filter(p => p.is_kid);
  const [defaults, likes] = await Promise.all([api("/api/lunch-defaults"), api("/api/lunch-likes")]);
  const get = (pid, wd) => (defaults.find(d => d.person_id === pid && d.weekday === wd) || {}).choice || "";
  const likesOf = pid => likes.filter(l => l.person_id === pid).map(l => l.dish).join("\n");
  const wds = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  openSheet(`
    <h2>Weekly defaults</h2>
    <p class="hint">What each kid usually does. You can still change any single day on the Lunch list.
      <b>Favourites</b>: when the school menu serves one of these, that kid has 🍽️ school lunch; other days it's 🥪 packed.
      Leave favourites empty to use the weekday buttons instead.</p>
    ${kids.map(k => `
      <h3 class="section-h">${dot(k.color)}${esc(k.name)}</h3>
      <div class="defaults-grid">
        ${wds.map((w, i) => `<div class="def-cell">
          <div class="def-wd">${w}</div>
          <div class="seg vertical" data-default-person="${k.id}" data-weekday="${i}">
            ${["buy", "pack"].map(c => `<button class="${get(k.id, i) === c ? "on " + c : ""}" data-choice="${c}" title="${LUNCH_LABELS[c]}">${LUNCH_SHORT[c].split(" ")[0]}</button>`).join("")}
          </div>
        </div>`).join("")}
      </div>
      <label>Favourites (one per line)<textarea rows="4" data-likes-person="${k.id}" placeholder="Cheese Pizza&#10;Pancakes">${esc(likesOf(k.id))}</textarea></label>`).join("")}
    <div class="sheet-actions"><button class="btn" id="sheet-cancel">Done</button></div>`, body => {
    body.querySelector("#sheet-cancel").addEventListener("click", () => run(async () => {
      await Promise.all([...body.querySelectorAll("[data-likes-person]")].map(t =>
        api(`/api/lunch-likes/${t.dataset.likesPerson}`, { method: "PUT", body: { dishes: t.value.split("\n") } })));
      closeSheet(); render();
    }));
    body.querySelectorAll("[data-default-person]").forEach(seg => seg.addEventListener("click", e => {
      const btn = e.target.closest("button");
      if (!btn) return;
      const choice = btn.classList.contains("on") ? null : btn.dataset.choice;
      run(async () => {
        await api("/api/lunch-defaults", { method: "PUT", body: {
          person_id: Number(seg.dataset.defaultPerson), weekday: Number(seg.dataset.weekday), choice } });
        seg.querySelectorAll("button").forEach(b => (b.className = choice && b.dataset.choice === choice ? `on ${choice}` : ""));
      });
    }));
  });
}

// ------------------------------------------------------------ work shifts

async function renderWork() {
  state.templates = await api("/api/shift-templates");
  const adults = state.people.filter(p => !p.is_kid);
  if (!state.workPerson || !state.byId[state.workPerson]) {
    const saved = Number(recall("workPerson"));
    state.workPerson = state.byId[saved] ? saved : (adults[0] || state.people[0])?.id;
  }
  if (!state.workMonth) state.workMonth = state.today.slice(0, 8) + "01";

  $("#work-person").innerHTML = state.people.filter(p => !p.is_kid).map(p =>
    `<button class="chip ${p.id === state.workPerson ? "on" : ""}" data-work-person="${p.id}">${dot(p.color)}${esc(nameOf(p))}</button>`).join("");

  // Recent shifts for this person, then the saved shift types, without repeats.
  const recent = await api(`/api/shifts/recent?person_id=${state.workPerson}`);
  const key = s => `${s.label}|${s.start_time}|${s.end_time}`;
  const seen = new Set();
  state.workChoices = [...recent, ...state.templates.map(t => ({ label: t.name, start_time: t.start_time, end_time: t.end_time })),
    ...(state.workPick && state.workPick !== "clear" ? [state.workPick] : [])]
    .filter(s => !seen.has(key(s)) && seen.add(key(s)));
  if (!state.workPick) state.workPick = "open";
  const picked = typeof state.workPick === "string" ? state.workPick : key(state.workPick);

  $("#work-templates").innerHTML =
    `<button class="chip tpl ${picked === "open" ? "on" : ""}" data-pick="open"><b>📅 Open day</b></button>` +
    `<button class="chip tpl" data-pick="new"><b>+ New shift</b></button>` +
    state.workChoices.map((s, i) =>
    `<button class="chip tpl ${key(s) === picked ? "on" : ""}" data-pick="${i}">
      <b>${esc(s.label)}</b> <span>${fmtTime(s.start_time)}–${fmtTime(s.end_time)}</span></button>`).join("") +
    `<button class="chip tpl ${picked === "clear" ? "on" : ""}" data-pick="clear"><b>Clear day</b></button>`;

  const first = parseISO(state.workMonth);
  $("#month-label").textContent = `${MONTH_NAMES[first.getMonth()]} ${first.getFullYear()}`;
  const gridStart = addDays(state.workMonth, -first.getDay());
  const gridEnd = addDays(gridStart, 42);
  const shifts = await api(`/api/shifts?start=${gridStart}&end=${gridEnd}&person_id=${state.workPerson}`);
  const byDate = {};
  for (const s of shifts) (byDate[s.date] ||= []).push(s);

  let html = ["S", "M", "T", "W", "T", "F", "S"].map(d => `<div class="wd">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const inMonth = parseISO(day).getMonth() === first.getMonth();
    const s = byDate[day] || [];
    html += `<button class="cell ${inMonth ? "" : "out"} ${day === state.today ? "today" : ""} ${s.length ? "has" : ""}" data-day="${day}">
      <span class="num">${parseISO(day).getDate()}</span>
      ${s.map(x => `<span class="shift-tag">${esc(x.label)}</span>`).join("")}
    </button>`;
  }
  $("#month-grid").innerHTML = html;
  $("#month-grid").style.setProperty("--person", state.byId[state.workPerson]?.color || "#888");

  // Every shift in the month on screen; tap one to change it.
  const monthShifts = shifts.filter(s => s.date.slice(0, 7) === state.workMonth.slice(0, 7));
  state.workShifts = Object.fromEntries(monthShifts.map(s => [s.id, s]));
  $("#shifts-heading").textContent = `Shifts in ${MONTH_NAMES[first.getMonth()]} · tap one to change it`;
  $("#shift-list").innerHTML = monthShifts.length
    ? `<div class="card list">${monthShifts.map(s => `<div class="row" data-edit-shift="${s.id}">
        <span class="bar" style="background:${esc(state.byId[s.person_id]?.color)}"></span>
        <div class="row-main"><div class="row-title">${relDay(s.date, state.today)} · ${esc(s.label)}</div>
        <div class="row-meta">${fmtTime(s.start_time)}–${fmtTime(s.end_time)}${s.end_time <= s.start_time ? " (overnight)" : ""}</div></div>
        <button class="icon-btn small" data-del-shift="${s.id}" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join("")}</div>`
    : `<div class="empty small">No shifts this month.</div>`;
}

function shiftForm(s) {
  simpleForm({
    title: "Change shift",
    fields: `
      <label>Name (who or where)<input name="label" required value="${esc(s.label)}" autocomplete="off"></label>
      <label>Whose shift<select name="person_id">${personOptions(s.person_id, false)}</select></label>
      <label>Day<input type="date" name="date" required value="${esc(s.date)}"></label>
      <div class="two">
        <label>Starts<input type="time" name="start" required value="${esc(s.start_time)}"></label>
        <label>Ends<input type="time" name="end" required value="${esc(s.end_time)}"></label>
      </div>
      <label>Notes (optional)<input name="notes" value="${esc(s.notes || "")}" autocomplete="off"></label>`,
    onSave: f => api(`/api/shifts/${s.id}`, { method: "PUT", body: {
      person_id: Number(f.person_id.value), date: f.date.value, start_time: f.start.value, end_time: f.end.value,
      label: f.label.value, notes: f.notes.value } }),
    onDelete: () => api(`/api/shifts/${s.id}`, { method: "DELETE" }),
  });
}

async function tapDay(day) {
  if (state.workPick === "open") return dayForm(day);
  if (state.workPick === "clear") {
    const shifts = await api(`/api/shifts?start=${day}&end=${addDays(day, 1)}&person_id=${state.workPerson}`);
    for (const s of shifts) await api(`/api/shifts/${s.id}`, { method: "DELETE" });
  } else if (state.workPick) {
    await api("/api/shifts/toggle", { method: "POST", body: { person_id: state.workPerson, date: day, ...state.workPick } });
  } else {
    toast("Tap “+ New shift” first", true);
    return;
  }
  renderWork();
}

// One day's shifts for the selected person: tap one to change it, or add another.
async function dayForm(day) {
  const person = state.byId[state.workPerson];
  const shifts = await api(`/api/shifts?start=${day}&end=${addDays(day, 1)}&person_id=${state.workPerson}`);
  const labels = [...new Set(state.workChoices.map(s => s.label))];
  openSheet(`
    <h2>${esc(nameOf(person))} · ${esc(relDay(day, state.today))}</h2>
    <div class="card list">${shifts.map(s => `
      <div class="row" data-day-shift="${s.id}">
        <div class="row-main"><div class="row-title">${esc(s.label)}</div>
          <div class="row-meta">${fmtTime(s.start_time)}–${fmtTime(s.end_time)}${s.notes ? ` · ${esc(s.notes)}` : ""}</div></div>
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </div>`).join("") || `<div class="row"><div class="row-main"><div class="row-meta">Nothing yet.</div></div></div>`}
    </div>
    <form id="day-add">
      <h3 class="section-h">Add a shift</h3>
      <label>Name (who or where)<input name="label" required list="shift-labels" autocomplete="off" placeholder="Office"></label>
      <datalist id="shift-labels">${labels.map(l => `<option value="${esc(l)}">`).join("")}</datalist>
      <div class="two">
        <label>Starts<input type="time" name="start" required value="08:00"></label>
        <label>Ends<input type="time" name="end" required value="10:00"></label>
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn secondary" id="sheet-cancel">Done</button>
        <button type="submit" class="btn">Add</button>
      </div>
    </form>`, body => {
    body.querySelector("#sheet-cancel").addEventListener("click", () => { closeSheet(); renderWork(); });
    body.querySelectorAll("[data-day-shift]").forEach(r => r.addEventListener("click", () =>
      shiftForm(shifts.find(s => s.id === Number(r.dataset.dayShift)))));
    body.querySelector("#day-add").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        await api("/api/shifts", { method: "POST", body: {
          person_id: state.workPerson, date: day, start_time: f.start.value, end_time: f.end.value, label: f.label.value } });
        toast("Added");
        dayForm(day);
      });
    });
  });
}

// Type a week of shifts the way a paper schedule looks, preview, then save.
function typeShiftsForm() {
  const person = state.byId[state.workPerson];
  const sunday = addDays(state.today, -parseISO(state.today).getDay());
  openSheet(`
    <h2>Type ${esc(person?.name || "")}'s shifts</h2>
    <form id="type-form">
      <label>Week starting (Sunday)<input type="date" name="week" required value="${sunday}"></label>
      <textarea name="text" rows="9" required placeholder="Monday: 8:00am-11:00am - Office&#10;        5:30pm-7:30pm - Office&#10;Tue 8-10 Office, 10:05-2:05 Clinic, 6-8pm Office&#10;Sep 28 10-2 Clinic"></textarea>
      <p class="hint">One day per line, or several times on one line. Lines without a day belong to the day above. Times without am/pm: 7–11 is morning, 12–6 is afternoon/evening.</p>
      <div id="type-preview"></div>
      <div class="sheet-actions">
        <button type="button" class="btn secondary" id="sheet-cancel">Cancel</button>
        <button type="button" class="btn secondary" id="type-check">Preview</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`, body => {
    const form = body.querySelector("#type-form");
    const send = save => api("/api/shifts/parse", { method: "POST", body: {
      person_id: state.workPerson, week_start: form.week.value, text: form.text.value, save } });
    body.querySelector("#sheet-cancel").addEventListener("click", closeSheet);
    body.querySelector("#type-check").addEventListener("click", () => run(async () => {
      const r = await send(false);
      body.querySelector("#type-preview").innerHTML = `<div class="card list">${r.shifts.map(s => `
        <div class="row"><div class="row-main"><div class="row-title">${esc(relDay(s.date, state.today))} · ${esc(s.label)}</div>
          <div class="row-meta">${fmtTime(s.start_time)}–${fmtTime(s.end_time)}</div></div></div>`).join("")
        || `<div class="row"><div class="row-main"><div class="row-meta">No shifts found.</div></div></div>`}</div>
        ${r.skipped.length ? `<p class="hint danger">Couldn't read: ${r.skipped.map(esc).join(" · ")}</p>` : ""}`;
    }));
    form.addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        const r = await send(true);
        closeSheet();
        toast(`Added ${r.added} shift${r.added === 1 ? "" : "s"}${r.skipped.length ? ` · couldn't read ${r.skipped.length} line(s)` : ""}`);
        renderWork();
      });
    });
  });
}

function newShiftForm() {
  simpleForm({
    title: "New shift",
    fields: `
      <label>Name (who or where)<input name="label" required placeholder="Office" autocomplete="off"></label>
      <div class="two">
        <label>Starts<input type="time" name="start" required value="08:00"></label>
        <label>Ends<input type="time" name="end" required value="10:00"></label>
      </div>
      <p class="hint">Then tap the days it happens. It stays in the list to pick next time.</p>`,
    onSave: async f => {
      state.workPick = { label: f.label.value.trim(), start_time: f.start.value, end_time: f.end.value };
    },
  });
}

// ------------------------------------------------------------ bills

const REPEAT_LABELS = { none: "One time", weekly: "Every week", biweekly: "Every 2 weeks", monthly: "Every month", yearly: "Every year" };

async function renderBills() {
  const [upcoming, bills] = await Promise.all([api("/api/bills/upcoming?days=62"), api("/api/bills")]);
  const late = upcoming.filter(o => !o.paid && o.due_date < state.today);
  const soon = upcoming.filter(o => o.due_date >= state.today);
  const row = o => {
    const diff = daysBetween(state.today, o.due_date);
    const when = diff < 0 ? `${-diff} day${diff === -1 ? "" : "s"} late` : relDay(o.due_date, state.today);
    return `<div class="row bill ${o.paid ? "paid" : diff < 0 ? "late" : ""}">
      <button class="check ${o.paid ? "on" : ""}" data-pay="${o.bill_id}" data-due="${o.due_date}" aria-label="Paid">
        <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
      <div class="row-main" data-edit-bill="${o.bill_id}">
        <div class="row-title">${esc(o.name)}${o.amount ? ` · ${esc(o.amount)}` : ""}</div>
        <div class="row-meta">${esc(when)} · ${esc(REPEAT_LABELS[o.repeat] || "")}${o.paid ? " · paid ✓" : ""}</div>
      </div>
    </div>`;
  };
  $("#bill-list").innerHTML =
    (late.length ? `<h3 class="section-h danger">Not paid yet</h3><div class="card list">${late.map(row).join("")}</div>` : "") +
    `<h3 class="section-h">Next 2 months</h3>` +
    (soon.length ? `<div class="card list">${soon.map(row).join("")}</div>`
      : `<div class="empty small">No bills yet. Tap “+ Add bill”.</div>`) +
    `<p class="hint">Tick a bill when it's paid. Tap its name to change it. Bills never show on the kids' pages
      and stay off the wall screen unless you turn that on in Settings.</p>`;
  state.bills = Object.fromEntries(bills.map(b => [b.id, b]));
}

function billForm(b = null) {
  simpleForm({
    title: b ? "Change bill" : "Add bill",
    fields: `
      <label>What is it<input name="name" required value="${esc(b?.name || "")}" placeholder="Hydro" autocomplete="off"></label>
      <div class="two">
        <label>Amount (optional)<input name="amount" value="${esc(b?.amount || "")}" placeholder="$140" autocomplete="off"></label>
        <label>${b ? "First due date" : "Next due date"}<input type="date" name="due_date" required value="${esc(b?.due_date || state.today)}"></label>
      </div>
      <label>Repeats<select name="repeat">${Object.entries(REPEAT_LABELS).map(([k, v]) =>
        `<option value="${k}" ${(b?.repeat || "monthly") === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label>Notes (optional)<input name="notes" value="${esc(b?.notes || "")}" placeholder="Auto-pay from chequing" autocomplete="off"></label>`,
    onSave: f => {
      const body = { name: f.name.value, amount: f.amount.value, due_date: f.due_date.value, repeat: f.repeat.value, notes: f.notes.value };
      return b ? api(`/api/bills/${b.id}`, { method: "PUT", body }) : api("/api/bills", { method: "POST", body });
    },
    onDelete: b ? () => api(`/api/bills/${b.id}`, { method: "DELETE" }) : null,
  });
}

// ------------------------------------------------------------ settings

// Settings is split into tabs; /admin is the same page on its own, wider, with an Overview first.
const ADMIN = location.pathname === "/admin";
const SET_TABS = [["overview", "📋 Overview"], ["people", "👪 People & sign-in"], ["kids", "🧒 Kids"], ["meds", "💊 Medicine"], ["school", "🏫 School"],
  ["calendars", "📅 Calendars"], ["work", "💼 Work"], ["alerts", "🔔 Notifications"], ["backups", "💾 Backups"], ["general", "⚙️ General"]];

function showSetTab(tab) {
  if (!SET_TABS.some(([k]) => k === tab) || (!ADMIN && tab === "overview")) tab = ADMIN ? "overview" : "people";
  state.setTab = tab;
  store(ADMIN ? "admin-tab" : "set-tab", tab);
  document.querySelectorAll("[data-set-tab]").forEach(b => b.classList.toggle("on", b.dataset.setTab === tab));
  document.querySelectorAll(".set-tab").forEach(s => (s.hidden = s.dataset.tab !== tab));
  if (ADMIN) $("#page-title").textContent = SET_TABS.find(([k]) => k === tab)[1].replace(/^\S+\s/, "");
}

const ago = iso => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

// The parts that need more than /api/settings: Overview, Notifications, Rewards, teacher emails.
async function renderMedsAdmin() {
  const [data, log] = await Promise.all([api("/api/meds"), api("/api/meds/log?days=60")]);
  const reportPeople = data.people.filter(p => p.is_kid || data.meds.some(m => m.person_id === p.id));
  $("#meds-admin").innerHTML = `
    <p class="hint">The medicine cabinet: add a medicine once, then tick who takes it (each with their own dose if it's different). Daily medicine gets a reminder at its times (a kid's goes to the adults' phones); "as needed" medicine warns if it's too soon. Doses and spacing come from the package or your doctor.</p>
    <h3 class="section-h">💊 Medicine cabinet</h3>
    <div class="card list">${data.cabinet.map(c => `
      <div class="row" data-cab="${c.id}"><div class="row-main">
        <div class="row-title">${c.kind === "puffer" ? "🫁" : "💊"} ${esc(c.name)}${c.dose ? ` · ${esc(c.dose)}` : ""}</div>
        <div class="row-meta">${c.times.length ? `Reminders ${c.times.map(fmtTime).join(", ")}` : "As needed"}${c.min_hours ? ` · every ${c.min_hours}h` : ""}${c.max_per_day ? ` · max ${c.max_per_day}/day` : ""}</div>
        <div class="row-meta">${c.people.length ? c.people.map(t => `${esc(t.name)}${t.dose && t.dose !== c.dose ? ` (${esc(t.dose)})` : ""}${t.puffs_left != null ? ` · ${t.puffs_left} puffs left` : ""}`).join(" · ") : "Nobody takes it yet"}</div></div>
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></div>`).join("")
      || `<div class="row"><div class="row-main"><div class="row-meta">The cabinet is empty.</div></div></div>`}
      <button class="row add-row" id="med-new">+ Add a medicine</button></div>
    <h3 class="section-h">📄 Doctor reports</h3>
    <div class="card list"><div class="row"><div class="row-main" style="display:flex;gap:8px;flex-wrap:wrap">${reportPeople.map(p =>
      `<a class="btn secondary small" href="/report?person=${p.id}">${esc(nameOf(p))}</a>`).join("")}</div></div></div>
    <h3 class="section-h">History (60 days)</h3>
    <div class="card list">${log.map(l => `<div class="row"><div class="row-main">
      <div class="row-title">${esc(l.person)} · ${esc(l.med)}${l.dose ? ` · ${esc(l.dose)}` : ""}</div>
      <div class="row-meta">${esc(l.at.replace("T", " "))}${l.by_name ? ` · by ${esc(l.by_name)}` : ""}${l.slot ? ` · for ${fmtTime(l.slot)}` : ""}${l.note ? ` · ${esc(l.note)}` : ""}</div></div></div>`).join("")
      || `<div class="row"><div class="row-main"><div class="row-meta">Nothing logged yet.</div></div></div>`}</div>`;
  $("#meds-admin").querySelectorAll("[data-cab]").forEach(r => r.addEventListener("click", () =>
    cabinetForm(data, data.cabinet.find(c => c.id === Number(r.dataset.cab)), () => run(renderMedsAdmin))));
  $("#med-new").addEventListener("click", () => cabinetForm(data, null, () => run(renderMedsAdmin)));
  return data;
}

async function renderAdminExtras() {
  const [o, rw, medsData] = await Promise.all([api("/api/admin/overview"), api("/api/me/rewards"), renderMedsAdmin()]);
  const nowHM = new Date().toTimeString().slice(0, 5);
  const missed = medsData.meds.flatMap(m => m.slots.filter(s => !s.taken && s.time <= nowHM).map(s => ({ m, s })));
  const ok = (good, text) => `<span class="st ${good ? "good" : "warn"}">${good ? "✅" : "⚠️"}</span> ${text}`;
  const phones = o.people.filter(p => p.phones);
  const statusRow = (title, meta) => `<div class="row"><div class="row-main"><div class="row-title">${title}</div><div class="row-meta">${meta}</div></div></div>`;
  const ow = o.lunch.next_window;
  $("#overview").innerHTML = `
    <h3 class="section-h">Needs attention</h3>
    <div class="card list">
      ${statusRow(ok(!o.overdue, o.overdue ? `${o.overdue} overdue to-do${o.overdue === 1 ? "" : "s"}` : "No overdue to-dos"), `<a href="/#tasks">Tasks</a>`)}
      ${o.payments.length ? o.payments.map(r => statusRow(`💳 ${esc(r.title.replace(/^(?:💳|📝|📋|\s)+/u, ""))}`, `${r.name ? esc(r.name) + " · " : ""}${r.due_date ? `due ${esc(relDay(r.due_date, state.today))}` : "no date"}`)).join("")
        : statusRow(ok(true, "No school payments waiting"), "School payments and forms")}
      ${o.mail_waiting.length ? o.mail_waiting.map(m => statusRow(`📧 ${m.waiting} teacher email${m.waiting === 1 ? "" : "s"} to review for ${esc(m.name)}`, `<a href="/me">My page → Kids</a>`)).join("")
        : statusRow(ok(true, "Teacher emails all reviewed"), "")}
      ${missed.map(({ m, s }) => statusRow(`💊 ${esc(m.person)}: ${esc(m.name)} at ${fmtTime(s.time)} not marked yet`, `Mark it on ${m.is_kid ? "My page → Kids" : "their page → Meds"}`)).join("")}
      ${ow || o.lunch.synced ? statusRow(`🍽️ School lunch ordering`, ow ? `${ow[0] <= state.today ? "Open now" : `Opens ${esc(relDay(ow[0], state.today))}`} · until ${esc(relDay(ow[1], state.today))}` : "No ordering dates known yet") : ""}
    </div>
    <h3 class="section-h">Is everything working?</h3>
    <div class="card list">
      ${statusRow(ok(o.backups.last && Date.now() - new Date(o.backups.last) < 36 * 3600e3, "Backups"), `Last ${ago(o.backups.last)} · ${o.backups.count} kept`)}
      ${statusRow(ok(phones.length, "Notifications"), phones.length ? phones.map(p => `${esc(p.name)} (${p.phones})`).join(" · ") : "No phones yet: tap 🔔 on My page or their phone page")}
      ${o.calendars.map(c => statusRow(ok(!c.error, `Google calendar: ${esc(c.name)}`), c.error ? `<span class="danger">${esc(c.error.slice(0, 80))}</span>` : "Reading fine")).join("")}
      ${statusRow(ok(o.google.connected && !o.google.last_error, "Copying appointments to Google"), o.google.connected ? (o.google.last_error ? esc(o.google.last_error.slice(0, 80)) : `${o.google.waiting} waiting`) : "Not set up yet (Calendars tab)")}
      ${o.lunch.synced || o.lunch.error ? statusRow(ok(!o.lunch.error, "Lunch menu"), o.lunch.error ? esc(o.lunch.error) : `Updated ${ago(o.lunch.synced)}`) : ""}
      ${o.homelab.last_scan || o.homelab.proxmox || o.homelab.adguard ? `
      ${statusRow(ok(o.homelab.last_scan && Date.now() - new Date(o.homelab.last_scan) < 30 * 60e3, "Network scan"), `${o.homelab.online} online · ${ago(o.homelab.last_scan)}`)}
      ${statusRow(ok(!!o.homelab.speed, "Speed test"), o.homelab.speed ? `⬇ ${o.homelab.speed.down_mbps.toFixed(0)} · ⬆ ${o.homelab.speed.up_mbps.toFixed(0)} Mb/s · ${ago(o.homelab.speed.at)}` : "No results yet")}
      ${statusRow(ok(o.homelab.proxmox && o.homelab.adguard, "Homelab logins"), `Proxmox ${o.homelab.proxmox ? "✓" : "not set"} · AdGuard ${o.homelab.adguard ? "✓" : "not set"} · <a href="/me">My page → Homelab</a>`)}` : ""}
    </div>
    <h3 class="section-h">Recent notifications</h3>
    <div class="card list">${o.pushes.map(p => statusRow(esc(p.title), `${esc(p.name || "")} · ${esc(p.at.replace("T", " ").slice(0, 16))} · ${p.phones} phone${p.phones === 1 ? "" : "s"}`)).join("")
      || statusRow("None sent yet", "")}</div>`;

  $("#alerts-admin").innerHTML = `
    <p class="hint">Each phone turns notifications on itself (🔔 on My page, or on their phone page), after the planner is added to the Home Screen.</p>
    <div class="card list">${o.people.map(p => statusRow(`${esc(nameOf(p))}${p.phones ? ` · 📱 ${p.phones}` : ""}`,
      p.is_kid ? (p.phones ? "Morning summary at 7:00 and bedtime reminders" : "Reminders not turned on (their page → Turn on reminders)")
        : p.phones ? [p.topics.includes("evening") && "🌙 8 pm check", p.topics.includes("homelab") && "🖥️ Homelab alerts"].filter(Boolean).join(" · ") || "No topics chosen"
        : "No phone yet")).join("")}</div>
    <h3 class="section-h">Sent lately</h3>
    <div class="card list">${o.pushes.map(p => statusRow(esc(p.title), `${esc(p.name || "")} · ${esc(p.at.slice(0, 16))} · ${p.phones} phone${p.phones === 1 ? "" : "s"}`)).join("") || statusRow("None sent yet", "")}</div>`;

  const kids = state.people.filter(p => p.is_kid);
  $("#rewards-admin").innerHTML = `
    <div class="card list">
      ${kids.map(k => statusRow(`${esc(nameOf(k))}: ${rw.balances[k.id] ?? 0} saved`, rw.given.filter(g => g.person_id === k.id).slice(0, 2).map(g => `🎉 ${esc(g.title)}`).join(" · ") || "Nothing given yet")).join("")}
      ${rw.rewards.map(r => `<div class="row"><div class="row-main"><div class="row-title">${esc(r.title)}</div>
        <div class="row-meta">${r.cost} · ${r.person_id ? esc(state.byId[r.person_id]?.name || "") : "Any kid"}</div></div>
        <button class="icon-btn small" data-del-reward="${r.id}" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("")}
      <button class="row add-row" id="add-reward">+ Add a reward</button>
    </div>
    <p class="hint">Every ticked job, bit of homework and bedtime step saves one. Give rewards on My page → Kids.</p>`;
  $("#rewards-admin").querySelectorAll("[data-del-reward]").forEach(b => b.addEventListener("click", () => run(async () => {
    await api(`/api/me/rewards/${b.dataset.delReward}`, { method: "DELETE" }); renderAdminExtras();
  })));
  $("#add-reward").addEventListener("click", () => simpleForm({
    title: "New reward",
    fields: `<label>Reward<input name="title" required maxlength="80" placeholder="🎬 Pick Friday's movie" autocomplete="off"></label>
      <div class="two"><label>Costs<input name="cost" type="number" min="1" max="1000" value="20" required></label>
      <label>For<select name="who"><option value="">Any kid</option>${kids.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join("")}</select></label></div>`,
    onSave: f => api("/api/me/rewards", { method: "POST", body: { title: f.title.value, cost: Number(f.cost.value), person_id: f.who.value ? Number(f.who.value) : null } }),
  }));

  $("#mail-admin").innerHTML = `<h3 class="section-h">📧 Teacher emails</h3>
    <div class="card list">${statusRow(o.mail_waiting.length ? o.mail_waiting.map(m => `${m.waiting} to review for ${esc(m.name)}`).join(" · ") : "All reviewed",
      `Upload or paste them on <a href="/me">My page → Kids</a>`)}</div>`;
}

async function renderSettings() {
  const [settings, cals, keys, chores, google, countries, backups] = await Promise.all([api("/api/settings"), api("/api/calendars"),
    api("/api/passkeys"), api("/api/chores"), api("/api/google"), api("/api/setup/countries"), api("/api/backups")]);
  const country = countries.find(c => c.code === settings.holiday_country);
  const rotation = Number(settings.school_rotation || 0);
  state.templates = await api("/api/shift-templates");
  const origin = settings.public_url || location.origin;
  const feedBase = `${origin.replace(/\/$/, "")}/feed/${settings.feed_token}`;
  const webcal = u => u.replace(/^https?:\/\//, "webcal://");

  const tab = state.setTab || recall(ADMIN ? "admin-tab" : "set-tab") || (ADMIN ? "overview" : "people");
  $("#view-settings").innerHTML = `
    <nav class="set-tabs">${SET_TABS.filter(([k]) => ADMIN || k !== "overview").map(([k, label]) =>
      `<button type="button" data-set-tab="${k}" class="${k === tab ? "on" : ""}">${label}</button>`).join("")}</nav>
    <div class="set-body">
    <section class="set-tab" data-tab="overview"><div id="overview"><div class="empty">Loading…</div></div></section>
    <section class="set-tab" data-tab="alerts"><div id="alerts-admin"><div class="empty">Loading…</div></div></section>
    <section class="set-tab" data-tab="meds"><div id="meds-admin"><div class="empty">Loading…</div></div></section>
    <section class="set-tab" data-tab="people">
    <h3 class="section-h">People</h3>
    <div class="card list">${state.people.map(p => `
      <div class="row" data-edit-person="${p.id}">
        <span class="swatch" style="background:${esc(p.color)}"></span>
        <div class="row-main"><div class="row-title">${esc(nameOf(p))}</div><div class="row-meta">${p.is_kid ? "Kid" : "Adult"}</div></div>
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </div>`).join("")}
      <button class="row add-row" id="add-person">+ Add person</button>
    </div>
    </section>

    <section class="set-tab" data-tab="kids">
    <h3 class="section-h">Kids</h3>
    ${state.people.filter(p => p.is_kid).map(k => `
      <div class="card list">
        <div class="row"><div class="row-main"><div class="row-title">${esc(nameOf(k))}'s jobs</div>
          <div class="row-meta">Page: <a href="/kids/${encodeURIComponent(k.name.toLowerCase())}">/kids/${esc(k.name.toLowerCase())}</a> (home Wi-Fi)</div></div></div>
        ${chores.filter(c => c.person_id === k.id).map(c => `
          <div class="row"><div class="row-main"><div class="row-title">${esc(c.title)}</div>
            <div class="row-meta">${c.routine === "day" ? (c.school_days ? "School days" : "Every day")
              : `${c.routine === "bedtime" ? "🌙 Bedtime" : "📚 Homework & reading"}${c.at ? ` · reminder at ${fmtTime(c.at)}` : ""} · ${
                ["Every night", "School nights", "Weekends & nights before a day off"][c.school_days] || ""}`}</div></div>
            <button class="icon-btn small" data-del-chore="${c.id}" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          </div>`).join("")}
        <button class="row add-row" data-add-chore="${k.id}">+ Add a job for ${esc(k.name)}</button>
      </div>`).join("")}
    <h3 class="section-h">🎁 Rewards</h3>
    <div id="rewards-admin"><div class="empty small">Loading…</div></div>
    </section>

    <section class="set-tab" data-tab="school">
    <h3 class="section-h">School year</h3>
    <form class="card pad" id="school-form">
      <div class="two">
        <label>First day<input type="date" name="school_start" value="${esc(settings.school_start || "")}"></label>
        <label>Last day<input type="date" name="school_end" value="${esc(settings.school_end || "")}"></label>
      </div>
      <label>Rotating schedule<select name="school_rotation">
        <option value="0" ${!rotation ? "selected" : ""}>None</option>
        ${[2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `<option value="${n}" ${rotation === n ? "selected" : ""}>Day 1–${n}</option>`).join("")}
      </select></label>
      <p class="hint">Blank dates mean September 1 to June 30. Holidays, weekends and days marked “No school” on the Lunch tab are skipped. Storm day? Lunch tab → tap the day → No school.</p>
      <button class="btn" type="submit">Save</button>
    </form>
    ${rotation ? `<form class="card pad" id="rotation-form">
      <label>School day number today (Day 1–${rotation})<input name="day" type="number" min="1" max="${rotation}" value="${settings.school_day_today || ""}" placeholder="${settings.school_day_today ? "" : "No school today"}"></label>
      <p class="hint">Counted from the first day of school. If the school's number is different, put in today's number and it carries on from there.</p>
      <button class="btn" type="submit">Save</button>
    </form>` : ""}
    <div id="mail-admin"></div>
    </section>

    <section class="set-tab" data-tab="calendars">
    <h3 class="section-h">Google Calendars</h3>
    <p class="hint">In Google Calendar on a computer: Settings → pick the calendar → “Integrate calendar” → copy <b>Secret address in iCal format</b>.</p>
    <div class="card list">${cals.map(c => `
      <div class="row" data-edit-cal="${c.id}">
        <span class="swatch" style="background:${esc(c.color || state.byId[c.person_id]?.color || "#8a8f98")}"></span>
        <div class="row-main"><div class="row-title">${esc(c.name)}</div>
          <div class="row-meta">${c.person_id ? esc(state.byId[c.person_id]?.name || "") : "Family"}${c.error ? ` · <span class="danger">Can't load: ${esc(c.error.slice(0, 60))}</span>` : ""}</div></div>
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </div>`).join("")}
      <button class="row add-row" id="add-cal">+ Add calendar</button>
    </div>

    <h3 class="section-h">Copy appointments to Google</h3>
    <p class="hint">Appointments added here or on a phone-access person's page are also put in a Google calendar, so they show on everyone's phone. Homework and tasks stay in the planner.</p>
    <div class="card list">
      <div class="row" id="google-setup">
        <div class="row-main"><div class="row-title">${google.connected ? "✅ Copying to Google" : "Not set up yet"}</div>
          <div class="row-meta">${google.connected
            ? `${esc(google.calendar)}${google.waiting ? ` · ${google.waiting} waiting to copy` : ""}${google.last_error ? ` · <span class="danger">${esc(google.last_error.slice(0, 80))}</span>` : ""}`
            : "Tap to connect a Google calendar"}</div></div>
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </div>
    </div>
    </section>

    <section class="set-tab" data-tab="work">
    <h3 class="section-h">Shift types</h3>
    <div class="card list">${state.templates.map(t => `
      <div class="row" data-edit-tpl="${t.id}">
        <div class="row-main"><div class="row-title">${esc(t.name)}</div><div class="row-meta">${fmtTime(t.start_time)}–${fmtTime(t.end_time)}</div></div>
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </div>`).join("")}
      <button class="row add-row" id="add-tpl">+ Add shift type</button>
    </div>
    </section>

    <section class="set-tab" data-tab="calendars">
    <h3 class="section-h">Show on your iPhone calendar</h3>
    <p class="hint">Tap a link on each iPhone and choose Subscribe. Work shifts and task due dates then show up in the iPhone Calendar app, updating on their own.</p>
    <div class="card list">
      <a class="row link-row" href="${esc(webcal(feedBase + "/shifts.ics"))}"><div class="row-main"><div class="row-title">Subscribe: Work shifts</div><div class="row-meta mono">${esc(feedBase)}/shifts.ics</div></div></a>
      <a class="row link-row" href="${esc(webcal(feedBase + "/tasks.ics"))}"><div class="row-main"><div class="row-title">Subscribe: Task due dates</div><div class="row-meta mono">${esc(feedBase)}/tasks.ics</div></div></a>
      <a class="row link-row" href="${esc(webcal(feedBase + "/reminders.ics"))}"><div class="row-main"><div class="row-title">Subscribe: Bills &amp; reminders (adults)</div><div class="row-meta mono">${esc(feedBase)}/reminders.ics</div></div></a>
      <button class="row add-row danger" id="rotate-token">Reset these links (old subscriptions stop working)</button>
    </div>
    </section>

    <section class="set-tab" data-tab="backups">
    <h3 class="section-h">💾 Backups</h3>
    <div class="card list">
      <div class="row"><div class="row-main"><div class="row-title">Every night at 2:30 on the server</div>
        <div class="row-meta">${backups.last ? `Last: ${esc(backups.last.replace("T", " "))}` : "None yet"} · the last ${backups.keep} are kept</div></div></div>
      ${backups.files.slice(0, 3).map(b => `<a class="row link-row" href="/api/backups/${encodeURIComponent(b.name)}">
        <div class="row-main"><div class="row-title">⬇️ ${esc(b.name)}</div><div class="row-meta">${(b.size / 1024).toFixed(0)} KB</div></div></a>`).join("")}
      <div class="row"><div class="row-main"><div class="row-title">Copy off the server</div>
        <div class="row-meta">Not set up yet (to plan: Proxmox storage, a NAS or your PC). Until then, download one now and then.</div></div></div>
      <button class="row add-row" id="backup-now">Back up now</button>
    </div>
    </section>

    <section class="set-tab" data-tab="people">
    <h3 class="section-h">Phone sign-in</h3>
    <p class="hint">Use ${esc(settings.public_url || "the https:// address")} everywhere, at home too. Each phone signs in once with the family PIN or Face ID, then stays signed in. On home Wi-Fi, only the kids' pages and the wall screen open without signing in.</p>
    <form class="card pad" id="pin-form">
      ${settings.via_internet && settings.pin_set ? `<label>Current PIN<input type="password" name="current_pin" inputmode="numeric" autocomplete="current-password" required></label>` : ""}
      <div class="two">
        <label>${settings.pin_set ? "New PIN" : "Family PIN"}<input type="password" name="pin" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="10" autocomplete="new-password" required></label>
        <label>Again<input type="password" name="pin2" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" required></label>
      </div>
      <p class="hint">4 to 10 digits (avoid easy ones like 1234). Changing it signs out every phone; Face ID gets them back in.</p>
      <button class="btn" type="submit">${settings.pin_set ? "Change PIN" : "Set PIN"}</button>
    </form>
    <div class="card list">${keys.map(k => `
      <div class="row">
        <div class="row-main"><div class="row-title">Face ID · ${esc(k.name)}${k.role === "kid" ? " (kids' page only)" : ""}</div>
          <div class="row-meta">Added ${esc(k.created.slice(0, 10))}${k.last_used ? ` · last used ${esc(k.last_used.slice(0, 10))}` : ""}</div></div>
        <button class="icon-btn small" data-del-passkey="${esc(k.id)}" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>`).join("")}
      ${settings.via_internet && passkeysSupported()
        ? `<button class="row add-row" id="add-passkey">+ Use Face ID on this phone</button>`
        : `<div class="row"><div class="row-main"><div class="row-meta">To add Face ID, open the planner on the phone from ${esc(settings.public_url || "its https:// address")} (not home Wi-Fi's address) and come back here.</div></div></div>`}
    </div>
    </section>

    <section class="set-tab" data-tab="school">
    <h3 class="section-h">School lunch menu (optional)</h3>
    <form class="card pad" id="lunch-form">
      <p class="hint">Type or paste your school's menu on the Lunch tab. Schools served by the School Lunch Association in Newfoundland and Labrador can load it automatically:</p>
      <label>School (as named on schoollunch.ca)<input name="lunch_school" value="${esc(settings.lunch_school || "")}" placeholder="Leave blank if you're not with the SLA" autocomplete="off"></label>
      <label class="switch"><input type="checkbox" name="lunch_auto" ${settings.lunch_auto === "1" ? "checked" : ""}> Update the menu automatically</label>
      <p class="hint">${settings.lunch_sync_error ? `<span class="danger">Last update failed: ${esc(settings.lunch_sync_error)}</span>`
        : settings.lunch_synced_at ? `Last updated ${esc(settings.lunch_synced_at.replace("T", " "))}` : "Not updated yet"}</p>
      <div class="sheet-actions"><button class="btn secondary" type="button" id="lunch-sync">Update now</button><button class="btn" type="submit">Save</button></div>
    </form>
    </section>

    <section class="set-tab" data-tab="general">
    <h3 class="section-h">General</h3>
    <form class="card pad" id="settings-form">
      <label>Family name (shown on the wall screen)<input name="family_name" value="${esc(settings.family_name || "")}" placeholder="The Smith Family"></label>
      <label>Public web address<input name="public_url" value="${esc(settings.public_url || "")}" placeholder="https://family.example.com" inputmode="url"></label>
      <label>Home https address (optional, for kids' morning reminders)<input name="home_url" value="${esc(settings.home_url || "")}" placeholder="https://home.example.com" inputmode="url"></label>
      <div class="two">
        <label>Latitude<input name="latitude" value="${esc(settings.latitude || "")}" placeholder="43.65" inputmode="decimal"></label>
        <label>Longitude<input name="longitude" value="${esc(settings.longitude || "")}" placeholder="-79.38" inputmode="decimal"></label>
      </div>
      <label>Temperature<select name="temp_unit">
        <option value="celsius" ${settings.temp_unit !== "fahrenheit" ? "selected" : ""}>°C</option>
        <option value="fahrenheit" ${settings.temp_unit === "fahrenheit" ? "selected" : ""}>°F</option>
      </select></label>
      <p class="hint">Latitude/longitude turn on the weather. Right-click your house in Google Maps to copy them. Time zone: ${esc(settings.timezone)}</p>
      <div class="two">
        <label>Holidays for<select name="holiday_country"><option value="">None</option>${countries.map(c =>
          `<option value="${c.code}" ${c.code === settings.holiday_country ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
        <label>Province / state<select name="holiday_subdiv"><option value="">All of the country</option>${(country?.subdivs || []).map(s =>
          `<option value="${s.code}" ${s.code === settings.holiday_subdiv ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      </div>
      <label class="switch"><input type="checkbox" name="show_holidays" ${settings.show_holidays !== "0" ? "checked" : ""}> Show holidays on the calendar</label>
      <label class="switch"><input type="checkbox" name="bills_on_wall" ${settings.bills_on_wall === "1" ? "checked" : ""}> Show bills on the wall screen (everyone can see it)</label>
      <button class="btn" type="submit">Save</button>
    </form>

    <p class="hint center">${ADMIN ? "" : `<a href="/admin">🛠️ Admin (everything in tabs)</a> · `}<a href="/display" target="_blank">Open the wall display</a>${settings.via_internet ? ` · <a href="/logout">Log out</a>` : ""}</p>
    </section>
    </div>
  `;

  const v = $("#view-settings");
  showSetTab(tab);
  v.querySelectorAll("[data-set-tab]").forEach(b => b.addEventListener("click", () => showSetTab(b.dataset.setTab)));
  run(renderAdminExtras);
  v.querySelector("#settings-form").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    run(async () => {
      await api("/api/settings", { method: "PUT", body: {
        family_name: f.family_name.value, public_url: f.public_url.value, home_url: f.home_url.value, latitude: f.latitude.value,
        longitude: f.longitude.value, temp_unit: f.temp_unit.value, show_holidays: f.show_holidays.checked ? "1" : "0",
        bills_on_wall: f.bills_on_wall.checked ? "1" : "0", holiday_country: f.holiday_country.value,
        holiday_subdiv: countries.find(c => c.code === f.holiday_country.value)?.subdivs.some(s => s.code === f.holiday_subdiv.value) ? f.holiday_subdiv.value : "" } });
      toast("Saved"); renderSettings();
    });
  });
  // Changing the country swaps in its provinces/states.
  v.querySelector("[name=holiday_country]").addEventListener("change", e => {
    const c = countries.find(x => x.code === e.target.value);
    v.querySelector("[name=holiday_subdiv]").innerHTML = `<option value="">All of the country</option>` +
      (c?.subdivs || []).map(s => `<option value="${s.code}">${esc(s.name)}</option>`).join("");
  });
  v.querySelector("#school-form").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    run(async () => {
      await api("/api/settings", { method: "PUT", body: { school_start: f.school_start.value, school_end: f.school_end.value, school_rotation: f.school_rotation.value } });
      toast("Saved"); renderSettings();
    });
  });
  v.querySelector("#pin-form").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    if (f.pin.value !== f.pin2.value) return toast("The two PINs don't match", true);
    run(async () => {
      await api("/api/pin", { method: "PUT", body: { pin: f.pin.value, current_pin: f.current_pin ? f.current_pin.value : "" } });
      toast("PIN saved"); renderSettings();
    });
  });
  v.querySelectorAll("[data-add-chore]").forEach(b => b.addEventListener("click", () => simpleForm({
    title: `New job for ${state.byId[b.dataset.addChore].name}`,
    fields: `<label>Job<input name="title" required placeholder="🧸 Put toys away" maxlength="80" autocomplete="off"></label>
      <div class="two">
        <label>Where<select name="routine"><option value="day">Day jobs</option><option value="homework">Homework &amp; reading</option><option value="bedtime">Bedtime routine</option></select></label>
        <label>Which days<select name="school_days"><option value="1">School days / nights</option><option value="0">Every day / night</option><option value="2">Weekends &amp; nights before a day off</option></select></label>
      </div>
      <label>Reminder on their phone (bedtime, optional)<input type="time" name="at"></label>
      <p class="hint">Start with an emoji to make it fun. It resets every day. Homework shows from 3 pm, bedtime from 4 pm. For homework and bedtime, "school nights" means school tomorrow.</p>`,
    onSave: f => api("/api/chores", { method: "POST", body: {
      person_id: Number(b.dataset.addChore), title: f.title.value, school_days: Number(f.school_days.value),
      routine: f.routine.value, at: f.routine.value !== "day" ? f.at.value : "" } }),
  })));
  v.querySelectorAll("[data-del-chore]").forEach(b => b.addEventListener("click", () => run(async () => {
    await api(`/api/chores/${b.dataset.delChore}`, { method: "DELETE" });
    renderSettings();
  })));
  v.querySelector("#rotation-form")?.addEventListener("submit", e => {
    e.preventDefault();
    const n = Number(e.target.day.value);
    if (!(n >= 1 && n <= rotation)) return toast(`Put in a number from 1 to ${rotation}`, true);
    run(async () => {
      await api("/api/settings", { method: "PUT", body: { rotation_anchor: `${state.today}:${n}` } });
      toast(`Today is Day ${n}`); renderSettings();
    });
  });
  v.querySelector("#add-passkey")?.addEventListener("click", () => simpleForm({
    title: "Use Face ID on this phone",
    fields: `<label>Name this phone<input name="name" required value="${/iPhone/.test(navigator.userAgent) ? "iPhone" : "Phone"}" autocomplete="off"></label>
      <p class="hint">e.g. “Alex's iPhone”. Your phone will ask for Face ID next.</p>`,
    onSave: async f => {
      try { await registerPasskey(f.name.value); }
      catch (err) { if (err.name === "NotAllowedError") throw new Error("Face ID was cancelled"); throw err; }
      toast("Face ID is on for this phone");
    },
  }));
  v.querySelectorAll("[data-del-passkey]").forEach(b => b.addEventListener("click", () => run(async () => {
    if (!confirm("Remove Face ID for this phone? It can still sign in with the PIN.")) return;
    await api(`/api/passkeys/${encodeURIComponent(b.dataset.delPasskey)}`, { method: "DELETE" });
    renderSettings();
  })));
  v.querySelector("#lunch-form").addEventListener("submit", e => {
    e.preventDefault();
    const f = e.target;
    run(async () => {
      await api("/api/settings", { method: "PUT", body: { lunch_school: f.lunch_school.value, lunch_auto: f.lunch_auto.checked ? "1" : "0" } });
      const r = await api("/api/lunch/sync", { method: "POST" });
      toast(r.error ? `Couldn't update: ${r.error}` : `Saved · ${r.imported} lunch days`, !!r.error); renderSettings();
    });
  });
  v.querySelector("#lunch-sync").addEventListener("click", () => run(async () => {
    const r = await api("/api/lunch/sync", { method: "POST" });
    toast(r.error ? `Couldn't update: ${r.error}` : `Updated · ${r.imported} lunch days`, !!r.error); renderSettings();
  }));
  v.querySelector("#add-person").addEventListener("click", () => personForm());
  v.querySelectorAll("[data-edit-person]").forEach(r => r.addEventListener("click", () => personForm(state.byId[r.dataset.editPerson])));
  v.querySelector("#add-cal").addEventListener("click", () => calendarForm());
  v.querySelector("#backup-now").addEventListener("click", () => run(async () => {
    const r = await api("/api/backups", { method: "POST" });
    toast(`Backed up: ${r.name}`); renderSettings();
  }));
  v.querySelector("#google-setup").addEventListener("click", () => googleForm(google));
  v.querySelectorAll("[data-edit-cal]").forEach(r => r.addEventListener("click", () => calendarForm(cals.find(c => c.id === Number(r.dataset.editCal)))));
  v.querySelector("#add-tpl").addEventListener("click", () => templateForm());
  v.querySelectorAll("[data-edit-tpl]").forEach(r => r.addEventListener("click", () => templateForm(state.templates.find(t => t.id === Number(r.dataset.editTpl)))));
  v.querySelector("#rotate-token").addEventListener("click", () => run(async () => {
    if (!confirm("Reset the calendar links? You'll need to re-subscribe on each iPhone.")) return;
    await api("/api/settings/rotate-feed-token", { method: "POST" });
    renderSettings();
  }));
}

function simpleForm({ title, fields, onSave, onDelete }) {
  openSheet(`
    <h2>${esc(title)}</h2>
    <form id="simple-form">${fields}
      <div class="sheet-actions">
        ${onDelete ? `<button type="button" class="btn danger" id="simple-delete">Delete</button>` : ""}
        <button type="button" class="btn secondary" id="sheet-cancel">Cancel</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`, body => {
    const form = body.querySelector("#simple-form");
    body.querySelector("#sheet-cancel").addEventListener("click", closeSheet);
    body.querySelector("#simple-delete")?.addEventListener("click", () => run(async () => {
      if (!confirm("Delete this?")) return;
      await onDelete(); closeSheet(); await loadPeople(); render();
    }));
    form.addEventListener("submit", e => {
      e.preventDefault();
      run(async () => { await onSave(form); closeSheet(); await loadPeople(); render(); });
    });
  });
}

function googleForm(g) {
  simpleForm({
    title: "Copy appointments to Google",
    fields: `
      ${g.robot_email ? `<p class="hint">Robot's address (share the calendar with it, “Make changes to events”):<br><b class="mono">${esc(g.robot_email)}</b></p>` : ""}
      <label>Calendar ID<input name="calendar" required autocomplete="off" value="${esc(g.calendar || "")}" placeholder="…@group.calendar.google.com"></label>
      <p class="hint">Google Calendar on a computer → Settings → the calendar → “Integrate calendar” → Calendar ID.</p>
      <label>${g.robot_email ? "New key file (leave blank to keep the saved one)" : "Service account key (open the .json file and paste all of it)"}
        <textarea name="key_json" rows="5" ${g.robot_email ? "" : "required"} placeholder='{ "type": "service_account", … }'></textarea></label>`,
    onSave: async f => {
      const r = await api("/api/google", { method: "PUT", body: { calendar: f.calendar.value, key_json: f.key_json.value } });
      toast(r.waiting ? `Connected · copying ${r.waiting}` : "Connected: a test event worked");
      renderSettings();
    },
    onDelete: g.connected ? async () => { await api("/api/google", { method: "DELETE" }); toast("Stopped copying"); renderSettings(); } : null,
  });
}

function personForm(p = null) {
  simpleForm({
    title: p ? "Edit person" : "Add person",
    fields: `
      <label>Name<input name="name" required value="${esc(p?.name || "")}"></label>
      <label>Color<input type="color" name="color" value="${esc(p?.color || "#e08a2f")}"></label>
      <label>Icon (optional)<input name="icon" value="${esc(p?.icon || "")}" placeholder="💻" maxlength="8" autocomplete="off"></label>
      <p class="hint">Shown by the name. Tap the emoji key on the keyboard to pick one.</p>
      <label>Also called (optional)<input name="aliases" value="${esc(p?.aliases || "")}" placeholder="Dad" autocomplete="off"></label>
      <p class="hint">Google Calendar events starting with this name or one of these (comma-separated) get this person's color, e.g. “Dad - Dentist”.</p>
      <label>Birthday (optional)<input type="date" name="birthday" value="${esc(p?.birthday || "")}"></label>
      <label class="switch"><input type="checkbox" name="is_kid" ${p?.is_kid ? "checked" : ""}> Kid (shows on the lunch planner)</label>
      <label>Kids' page look<select name="theme">
        <option value="" ${!p?.theme ? "selected" : ""}>Plain</option>
        <option value="island" ${p?.theme === "island" ? "selected" : ""}>Island 🌺 (ocean blues)</option>
        <option value="power" ${p?.theme === "power" ? "selected" : ""}>Power-up 🍄 (red, blue and gold)</option>
      </select></label>
      ${p?.is_kid ? `<p class="hint">Their page: <a href="/kids/${encodeURIComponent(p.name.toLowerCase())}">/kids/${esc(p.name.toLowerCase())}</a> (home Wi-Fi only)</p>
        <h3 class="section-h">School</h3>
        <div class="two">
          <label>Teacher<input name="teacher" value="${esc(p.teacher || "")}" placeholder="Ms. Smith" autocomplete="off"></label>
          <label>Teacher's email<input name="teacher_email" type="email" value="${esc(p.teacher_email || "")}" autocomplete="off"></label>
        </div>
        <label>Class notes (codes, standing reminders)<textarea name="class_notes" rows="3">${esc(p.class_notes || "")}</textarea></label>
        <p class="hint">The teacher's name shows on their page; the email and notes only on My page → Kids.</p>` : ""}
      ${p && !p.is_kid ? `
        <h3 class="section-h">Their own PIN</h3>
        <div class="two">
          <label>${p.has_pin ? "New PIN (blank = keep)" : "PIN (4–10 digits)"}<input type="password" name="pin" inputmode="numeric" pattern="[0-9]*" minlength="4" maxlength="10" autocomplete="new-password"></label>
          <label>What they can do<select name="access" onchange="this.form.querySelectorAll('[data-tabs-for]').forEach(g => (g.hidden = g.dataset.tabsFor !== this.value))">
            <option value="full" ${p.access !== "phone" ? "selected" : ""}>Everything</option>
            <option value="phone" ${p.access === "phone" ? "selected" : ""}>Phone view + own shifts</option>
          </select></label>
        </div>
        ${p.has_pin ? `<label class="switch"><input type="checkbox" name="remove_pin"> Remove their PIN</label>` : ""}
        <p class="hint">"Phone view + own shifts" opens only ${esc(location.origin)}/mobile and a screen to add and change their own shifts. Changing a PIN signs every phone out (Face ID gets them back in).</p>
        <h3 class="section-h">Their page shows</h3>
        ${[["full", MY_PAGE_TABS, "My page (/me)"], ["phone", PHONE_PAGE_TABS, "their phone page"]].map(([access, tabs, where]) => {
          const on = pageTabsFor(p, tabs);
          return `<div data-tabs-for="${access}" ${(p.access === "phone" ? "phone" : "full") === access ? "" : "hidden"}>
            <p class="hint">The tabs at the bottom of ${where}:</p>
            <div class="tab-checks">${tabs.map(([k, label]) => `<label class="switch"><input type="checkbox" name="tab-${access}-${k}" ${on.includes(k) ? "checked" : ""}> ${label}</label>`).join("")}</div>
          </div>`;
        }).join("")}` : ""}`,
    onSave: async f => {
      const body = { name: f.name.value, color: f.color.value, is_kid: f.is_kid.checked, aliases: f.aliases.value, icon: f.icon.value,
        birthday: f.birthday.value, theme: f.theme.value };
      if (f.teacher) Object.assign(body, { teacher: f.teacher.value, teacher_email: f.teacher_email.value, class_notes: f.class_notes.value });
      if (f.access) {
        const access = f.access.value === "phone" ? "phone" : "full";
        const tabs = access === "phone" ? PHONE_PAGE_TABS : MY_PAGE_TABS;
        body.page_tabs = tabs.map(([k]) => k).filter(k => f[`tab-${access}-${k}`]?.checked);
        if (!body.page_tabs.length) throw new Error("Leave at least one tab on");
      }
      if (!p) return api("/api/people", { method: "POST", body });
      await api(`/api/people/${p.id}`, { method: "PUT", body });
      if (f.access && (f.pin.value || f.remove_pin?.checked || f.access.value !== (p.access || "full"))) {
        await api(`/api/people/${p.id}/pin`, { method: "PUT", body: {
          pin: f.pin.value || null, access: f.access.value, remove: !!f.remove_pin?.checked } });
      }
    },
    onDelete: p ? () => api(`/api/people/${p.id}`, { method: "DELETE" }) : null,
  });
}

function calendarForm(c = null) {
  simpleForm({
    title: c ? "Edit calendar" : "Add Google Calendar",
    fields: `
      <label>Name<input name="name" required value="${esc(c?.name || "")}" placeholder="Emma – School"></label>
      <label>Secret iCal address<input name="url" required value="${esc(c?.url || "")}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" inputmode="url" autocomplete="off"></label>
      <label>Whose calendar<select name="person_id">${personOptions(c?.person_id ?? "", true, "Family")}</select></label>
      <label class="switch"><input type="checkbox" name="own_color" ${c?.color ? "checked" : ""}> Use its own color instead of the person's</label>
      <label>Color<input type="color" name="color" value="${esc(c?.color || "#e08a2f")}"></label>`,
    onSave: async f => {
      const body = { name: f.name.value, url: f.url.value, person_id: f.person_id.value ? Number(f.person_id.value) : null,
        color: f.own_color.checked ? f.color.value : null };
      if (c) await api(`/api/calendars/${c.id}`, { method: "PUT", body });
      else await api("/api/calendars", { method: "POST", body });
      await api("/api/calendars/refresh", { method: "POST" });
    },
    onDelete: c ? () => api(`/api/calendars/${c.id}`, { method: "DELETE" }) : null,
  });
}

function templateForm(t = null) {
  simpleForm({
    title: t ? "Edit shift type" : "Add shift type",
    fields: `
      <label>Name<input name="name" required value="${esc(t?.name || "")}" placeholder="Day"></label>
      <div class="two">
        <label>Starts<input type="time" name="start_time" required value="${esc(t?.start_time || "07:00")}"></label>
        <label>Ends<input type="time" name="end_time" required value="${esc(t?.end_time || "15:00")}"></label>
      </div>
      <p class="hint">If it ends before it starts (e.g. 11pm–7am) it's treated as overnight.</p>`,
    onSave: f => {
      const body = { name: f.name.value, start_time: f.start_time.value, end_time: f.end_time.value };
      return t ? api(`/api/shift-templates/${t.id}`, { method: "PUT", body }) : api("/api/shift-templates", { method: "POST", body });
    },
    onDelete: t ? () => api(`/api/shift-templates/${t.id}`, { method: "DELETE" }) : null,
  });
}

// ------------------------------------------------------------ event wiring (delegated)

document.addEventListener("click", e => {
  const t = e.target;
  const tab = t.closest(".tabs button");
  if (tab) return show(tab.dataset.view);

  const go = t.closest("[data-go]");
  if (go) { e.preventDefault(); return show(go.dataset.go); }

  const toggle = t.closest("[data-toggle]");
  if (toggle) return run(() => toggleTask(Number(toggle.dataset.toggle)));

  const taskRow = t.closest("[data-task]");
  if (taskRow) return run(() => editTask(Number(taskRow.dataset.task)));

  if (t.closest("#add-appt-btn")) return apptForm();
  const apptRow = t.closest("[data-appt]");
  if (apptRow) return run(async () => {
    const d = apptRow.dataset.date;
    const list = await api(`/api/appointments?start=${d}&end=${addDays(d, 1)}`);
    apptForm(list.find(a => a.id === Number(apptRow.dataset.appt)));
  });

  const filter = t.closest("[data-filter]");
  if (filter) { state.taskFilter = filter.dataset.filter; return renderTasks(); }

  const menu = t.closest("[data-menu]");
  if (menu) return menuForm(menu.dataset.menu);

  const seg = t.closest(".seg[data-date]");
  if (seg && t.closest("button")) {
    const btn = t.closest("button");
    // Tapping the active choice again goes back to the weekly default.
    const choice = btn.classList.contains("on") ? null : btn.dataset.choice;
    return run(async () => {
      await api(`/api/lunch/${seg.dataset.date}/${seg.dataset.person}`, { method: "PUT", body: { choice } });
      renderLunch();
    });
  }

  const wp = t.closest("[data-work-person]");
  if (wp) { state.workPerson = Number(wp.dataset.workPerson); state.workPick = null; store("workPerson", state.workPerson); return run(renderWork); }

  const pick = t.closest("[data-pick]");
  if (pick) {
    if (pick.dataset.pick === "new") return newShiftForm();
    const p = pick.dataset.pick;
    state.workPick = p === "clear" || p === "open" ? p : state.workChoices[Number(p)];
    return run(renderWork);
  }

  const cell = t.closest("#month-grid [data-day]");
  if (cell) return run(() => tapDay(cell.dataset.day));

  const del = t.closest("[data-del-shift]");
  if (del) return run(async () => { await api(`/api/shifts/${del.dataset.delShift}`, { method: "DELETE" }); renderWork(); });

  const edit = t.closest("[data-edit-shift]");
  if (edit && state.workShifts?.[edit.dataset.editShift]) return shiftForm(state.workShifts[edit.dataset.editShift]);
});

$("#fab").addEventListener("click", () => taskForm());
$("#refresh-btn").addEventListener("click", async () => {
  await run(() => api("/api/calendars/refresh", { method: "POST" }));
  await render();
  toast("Up to date");
});
$("#lunch-import-btn").addEventListener("click", importForm);
$("#add-bill-btn").addEventListener("click", () => billForm());
$("#type-shifts-btn").addEventListener("click", typeShiftsForm);
$("#bill-list").addEventListener("click", e => {
  const pay = e.target.closest("[data-pay]");
  if (pay) return run(async () => {
    const r = await api(`/api/bills/${pay.dataset.pay}/paid`, { method: "POST", body: { due_date: pay.dataset.due } });
    if (r.paid) toast("Marked paid");
    renderBills();
  });
  const edit = e.target.closest("[data-edit-bill]");
  if (edit && state.bills?.[edit.dataset.editBill]) billForm(state.bills[edit.dataset.editBill]);
});
$("#lunch-defaults-btn").addEventListener("click", () => run(defaultsForm));
$("#month-prev").addEventListener("click", () => { state.workMonth = addDays(state.workMonth, -1).slice(0, 8) + "01"; run(renderWork); });
$("#month-next").addEventListener("click", () => { state.workMonth = addDays(state.workMonth, 32).slice(0, 8) + "01"; run(renderWork); });

// Coming back to the app from the home screen: refresh what's shown.
document.addEventListener("visibilitychange", () => { if (!document.hidden && $("#sheet").hidden) render(); });

(async function start() {
  await run(loadPeople);
  if (ADMIN) {  // /admin: only Settings, as tabs, without touching the phone app's remembered tab
    document.body.classList.add("admin");
    document.title = "Admin · Family Planner";
    state.view = "settings";
    document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== "view-settings"));
    $("#fab").hidden = true;
    $("#page-sub").innerHTML = `<a href="/">Planner</a> · <a href="/me">My page</a> · <a href="/display" target="_blank">Wall screen</a>`;
    return render();
  }
  const hash = location.hash.slice(1);
  const saved = TITLES[hash] ? hash : recall("view");
  show(TITLES[saved] ? saved : "home");
})();
