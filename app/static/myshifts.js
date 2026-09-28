// "My planner" for a phone sign-in (phone view + own shifts): their own shifts, and appointments for anyone in the family.

const $ = sel => document.querySelector(sel);
const today = toISO(new Date());
let from = addDays(today, -parseISO(today).getDay());  // this week's Sunday
let shifts = [];
let recent = [];
let people = [];
let appts = [];

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 4000 : 1800);
}

async function run(fn) {
  try { await fn(); } catch (e) { toast(e.message, true); }
}

function openSheet(html, onMount) {
  $("#sheet-body").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheet-backdrop").hidden = false;
  requestAnimationFrame(() => $("#sheet").classList.add("open"));
  onMount($("#sheet-body"));
}

function closeSheet() {
  $("#sheet").classList.remove("open");
  $("#sheet").hidden = true;
  $("#sheet-backdrop").hidden = true;
}

async function load() {
  const to = addDays(today, 28);
  [shifts, recent] = await Promise.all([api(`/api/my/shifts?start=${from}&end=${to}`), api("/api/my/shifts/recent")]);
  const byDay = {};
  for (const s of shifts) (byDay[s.date] ||= []).push(s);
  let html = "";
  for (let d = from; d < to; d = addDays(d, 1)) {
    if (parseISO(d).getDay() === 0) html += `<h3 class="section-h">Week of ${MONTH_NAMES[parseISO(d).getMonth()].slice(0, 3)} ${parseISO(d).getDate()}</h3>`;
    const list = byDay[d] || [];
    html += `<div class="card list day-card ${d === today ? "is-today" : ""} ${d < today ? "past" : ""}">
      <div class="row day-head" data-add="${d}">
        <div class="row-main"><div class="row-title">${esc(relDay(d, today))}</div></div>
        <span class="add-plus">+</span>
      </div>
      ${list.map(s => `<div class="row" data-edit="${s.id}">
        <span class="bar" style="background:var(--accent)"></span>
        <div class="row-main"><div class="row-title">${esc(s.label)}</div>
          <div class="row-meta">${fmtTime(s.start_time)}–${fmtTime(s.end_time)}${s.notes ? ` · ${esc(s.notes)}` : ""}</div></div>
      </div>`).join("")}
    </div>`;
  }
  $("#list").innerHTML = html;
}

function shiftSheet(s = null, day = today) {
  const labels = [...new Set(recent.map(r => r.label))];
  openSheet(`
    <h2>${s ? "Change shift" : "Add a shift"}</h2>
    <form id="shift-form">
      ${!s && recent.length ? `<div class="chips quick">${recent.slice(0, 8).map((r, i) =>
        `<button type="button" class="chip tpl" data-quick="${i}"><b>${esc(r.label)}</b> <span>${fmtTime(r.start_time)}–${fmtTime(r.end_time)}</span></button>`).join("")}</div>
        <p class="hint">Tap a recent one to fill it in.</p>` : ""}
      <label>Name (who or where)<input name="label" required list="labels" autocomplete="off" value="${esc(s?.label || "")}" placeholder="Office"></label>
      <datalist id="labels">${labels.map(l => `<option value="${esc(l)}">`).join("")}</datalist>
      <label>Day<input type="date" name="date" required value="${esc(s?.date || day)}"></label>
      <div class="two">
        <label>Starts<input type="time" name="start" required value="${esc(s?.start_time || "08:00")}"></label>
        <label>Ends<input type="time" name="end" required value="${esc(s?.end_time || "10:00")}"></label>
      </div>
      <label>Notes (optional)<input name="notes" autocomplete="off" value="${esc(s?.notes || "")}"></label>
      <div class="sheet-actions">
        ${s ? `<button type="button" class="btn danger" id="del">Delete</button>` : ""}
        <button type="button" class="btn secondary" id="cancel">Cancel</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`, body => {
    const f = body.querySelector("#shift-form");
    body.querySelector("#cancel").addEventListener("click", closeSheet);
    body.querySelectorAll("[data-quick]").forEach(b => b.addEventListener("click", () => {
      const r = recent[Number(b.dataset.quick)];
      f.label.value = r.label; f.start.value = r.start_time; f.end.value = r.end_time;
    }));
    body.querySelector("#del")?.addEventListener("click", () => run(async () => {
      await api(`/api/my/shifts/${s.id}`, { method: "DELETE" });
      closeSheet(); toast("Deleted"); load();
    }));
    f.addEventListener("submit", e => {
      e.preventDefault();
      const payload = { date: f.date.value, start_time: f.start.value, end_time: f.end.value, label: f.label.value, notes: f.notes.value };
      run(async () => {
        await api(s ? `/api/my/shifts/${s.id}` : "/api/my/shifts", { method: s ? "PUT" : "POST", body: payload });
        closeSheet(); toast("Saved"); load();
      });
    });
  });
}

function typeSheet() {
  const sunday = addDays(today, -parseISO(today).getDay());
  openSheet(`
    <h2>Type your shifts</h2>
    <form id="type-form">
      <label>Week starting (Sunday)<input type="date" name="week" required value="${sunday}"></label>
      <textarea name="text" rows="9" required placeholder="Monday: 8:00am-11:00am - Office&#10;        5:30pm-7:30pm - Office&#10;Tue 8-10 Office, 10:05-2:05 Clinic&#10;Sep 28 10-2 Clinic"></textarea>
      <p class="hint">Write it like your schedule: one day per line, or several times on one line. Lines without a day belong to the day above.</p>
      <div id="preview"></div>
      <div class="sheet-actions">
        <button type="button" class="btn secondary" id="cancel">Cancel</button>
        <button type="button" class="btn secondary" id="check">Preview</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`, body => {
    const f = body.querySelector("#type-form");
    const send = save => api("/api/my/shifts/parse", { method: "POST", body: { week_start: f.week.value, text: f.text.value, save } });
    body.querySelector("#cancel").addEventListener("click", closeSheet);
    body.querySelector("#check").addEventListener("click", () => run(async () => {
      const r = await send(false);
      body.querySelector("#preview").innerHTML = `<div class="card list">${r.shifts.map(s => `
        <div class="row"><div class="row-main"><div class="row-title">${esc(relDay(s.date, today))} · ${esc(s.label)}</div>
          <div class="row-meta">${fmtTime(s.start_time)}–${fmtTime(s.end_time)}</div></div></div>`).join("")
        || `<div class="row"><div class="row-main"><div class="row-meta">No shifts found.</div></div></div>`}</div>
        ${r.skipped.length ? `<p class="hint danger">Couldn't read: ${r.skipped.map(esc).join(" · ")}</p>` : ""}`;
    }));
    f.addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        const r = await send(true);
        closeSheet();
        toast(`Added ${r.added} shift${r.added === 1 ? "" : "s"}`);
        load();
      });
    });
  });
}

// ------------------------------------------------------------ appointments

async function loadAppts() {
  appts = await api(`/api/my/appointments?start=${today}&end=${addDays(today, 180)}`);
  const byId = personMap(people);
  const byDay = {};
  for (const a of appts) (byDay[a.date] ||= []).push(a);
  $("#appt-list").innerHTML = Object.entries(byDay).map(([d, list]) => `
    <div class="card list day-card ${d === today ? "is-today" : ""}">
      <div class="row day-head" data-add-appt="${d}">
        <div class="row-main"><div class="row-title">${esc(relDay(d, today))}</div></div>
        <span class="add-plus">+</span>
      </div>
      ${list.map(a => {
        const who = byId[a.person_id];
        const when = a.start_time ? fmtRange({ ...a, all_day: false }) : "All day";
        return `<div class="row" data-edit-appt="${a.id}">
          <span class="bar" style="background:${esc(who ? who.color : "#8a8f98")}"></span>
          <div class="row-main"><div class="row-title">${esc(a.title)}</div>
            <div class="row-meta">${esc(who ? nameOf(who) : "👪 Family")} · ${when}${a.location ? ` · ${esc(a.location)}` : ""}</div></div>
        </div>`;
      }).join("")}
    </div>`).join("") || `<div class="empty">No appointments coming up.<br>Tap “+ Add an appointment” to add one.</div>`;
}

const PAGE_TITLES = { home: "Home", shifts: "My shifts", appts: "Appointments", meds: "Medicine" };

function showPage(page) {
  document.querySelectorAll("[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  for (const p of Object.keys(PAGE_TITLES)) $(`#page-${p}`).hidden = page !== p;
  $("#title").textContent = PAGE_TITLES[page];
  try { localStorage.setItem("my-page", page); } catch (_) {}
  if (page === "home") showHome();
  if (page === "shifts") goToToday();
  if (page === "meds") run(loadMeds);
}

// Home: the family board (the same one on the wall and on /mobile), sized to fit.
function showHome() {
  const v = $("#page-home");
  if (v.querySelector("iframe")) return;
  v.innerHTML = `<iframe class="home-frame" src="/mobile?embed=1" title="Family board" scrolling="no"></iframe>`;
  const frame = v.querySelector("iframe");
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    const fit = () => (frame.style.height = `${doc.documentElement.scrollHeight}px`);
    new ResizeObserver(fit).observe(doc.body);
    fit();
  });
}

// ------------------------------------------------------------ medicine: her pills, and the kids'

let medsData = null;

async function loadMeds() {
  const [data, log] = await Promise.all([api("/api/meds"), api("/api/meds/log?days=7")]);
  medsData = data;
  const me = await api("/api/me");
  const mine = me.person ? medsHTML(data, me.person.id) : "";
  $("#meds-mine").innerHTML = mine || `<div class="row"><div class="row-main"><div class="row-meta">No pills set up. An adult can add them in Admin → Medicine.</div></div></div>`;
  $("#meds-kids").innerHTML = data.people.filter(p => p.is_kid).map(k => `
    <div class="card list"><div class="row"><div class="row-main"><div class="row-title">${esc(nameOf(k))}</div></div>
      <button class="btn secondary small" data-med-add="${k.id}">+ Medicine</button></div>
      ${medsHTML(data, k.id) || `<div class="med"><div class="med-meta">No medicine set up. Tap + Medicine to add one (e.g. Children's Tylenol or a puffer).</div></div>`}
      <div class="med">${medsTools(k.id)}</div>
    </div>`).join("");
  $("#meds-recent").innerHTML = log.slice(0, 12).map(l => `<div class="row"><div class="row-main">
    <div class="row-title">💊 ${esc(l.person)} · ${esc(l.med)}${l.dose ? ` · ${esc(l.dose)}` : ""}</div>
    <div class="row-meta">${esc(medDay(l.at))}${l.by_name ? ` · by ${esc(l.by_name)}` : ""}${l.note ? ` · ${esc(l.note)}` : ""}</div></div>
    <button class="icon-btn small" data-med-undo="${l.id}" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("")
    || `<div class="row"><div class="row-main"><div class="row-meta">Nothing in the last week.</div></div></div>`;
}

$("#page-meds").addEventListener("click", e => {
  const take = e.target.closest("[data-med-take]");
  if (take) return medTake(medsData, take.dataset.medTake, take.dataset.slot || "", () => run(loadMeds));
  const giveMed = e.target.closest("[data-give-med]");
  if (giveMed) return giveSheet(medsData, giveMed.dataset.giveMed, () => run(loadMeds));
  const sym = e.target.closest("[data-symptom]");
  if (sym) return run(() => symptomSheet(sym.dataset.symptom, medsData.people, () => run(loadMeds)));
  const add = e.target.closest("[data-med-add]");
  if (add) return medForm(medsData, null, () => run(loadMeds), Number(add.dataset.medAdd));
  const undo = e.target.closest("[data-med-undo]");
  if (undo) return run(async () => {
    if (!confirm("Remove this dose from the log?")) return;
    await api(`/api/meds/log/${undo.dataset.medUndo}`, { method: "DELETE" }); loadMeds();
  });
});

// Opening the shifts goes straight to today (the list starts on this week's Sunday).
function goToToday() {
  if ($("#page-shifts").hidden) return;
  $("#list .day-card.is-today")?.scrollIntoView({ block: "start" });
}

function apptSheet(a = null, day = today) {
  appointmentSheet({ appt: a, people, day, base: "/api/my/appointments", onSaved: () => run(loadAppts) });
}

document.querySelectorAll("[data-page]").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page)));
document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => (location.href = b.dataset.go)));
$("#add-appt-btn").addEventListener("click", () => apptSheet());
$("#appt-list").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit-appt]");
  if (edit) return apptSheet(appts.find(a => a.id === Number(edit.dataset.editAppt)));
  const add = e.target.closest("[data-add-appt]");
  if (add) return apptSheet(null, add.dataset.addAppt);
});

// ------------------------------------------------------------ shifts

$("#list").addEventListener("click", e => {
  const edit = e.target.closest("[data-edit]");
  if (edit) return shiftSheet(shifts.find(s => s.id === Number(edit.dataset.edit)));
  const add = e.target.closest("[data-add]");
  if (add) return shiftSheet(null, add.dataset.add);
});
$("#add-btn").addEventListener("click", () => shiftSheet());
$("#bell-btn").addEventListener("click", () => run(notificationsSheet));
$("#type-btn").addEventListener("click", typeSheet);
$("#sheet-backdrop").addEventListener("click", closeSheet);
$("#earlier").addEventListener("click", () => { from = addDays(from, -14); run(load); });
$("#faceid").addEventListener("click", () => run(async () => {
  await registerPasskey(/iPhone/.test(navigator.userAgent) ? "iPhone" : "Phone");
  toast("Face ID is on for this phone");
  $("#faceid-wrap").hidden = true;
}));

let startPage = new URLSearchParams(location.search).get("page");
if (!startPage) try { startPage = localStorage.getItem("my-page"); } catch (_) {}
showPage(PAGE_TITLES[startPage] ? startPage : "shifts");

run(async () => {
  const me = await api("/api/me");
  if (me.person) {
    $("#who").textContent = nameOf(me.person);
    document.title = `${me.person.name}'s planner`;
    // Only the tabs chosen for them in Admin → People; if the open one is off, go to the first that's on.
    const on = applyPageTabs(me.person, PHONE_PAGE_TABS);
    const current = document.querySelector("[data-page].active")?.dataset.page;
    if (!on.includes(current)) showPage(on.find(k => PAGE_TITLES[k]) || "shifts");
  }
  $("#faceid-wrap").hidden = !(passkeysSupported() && window.isSecureContext && me.role === "member");
  people = await api("/api/my/people");
  await Promise.all([load(), loadAppts()]);
  goToToday();
});
