// Shared helpers for the phone app and the wall display.

async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body !== undefined && typeof opts.body !== "string") {
    opts.body = JSON.stringify(opts.body);
    opts.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);  // signed out or PIN changed
    throw new Error("Please log in");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw Object.assign(new Error(typeof msg === "string" ? msg : JSON.stringify(msg)), { status: res.status });
  }
  return res.json();
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

function daysBetween(fromISO, toISOStr) {
  return Math.round((parseISO(toISOStr) - parseISO(fromISO)) / 86400000);
}

// "07:00" -> "7am", "15:30" -> "3:30pm"
function fmtTime(t) {
  if (!t) return "";
  let [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
}

function fmtRange(item) {
  if (item.all_day) return "";
  if (!item.end_time || item.end_time === item.start_time) return fmtTime(item.start_time);
  return `${fmtTime(item.start_time)}–${fmtTime(item.end_time)}`;
}

// Relative label for a date compared to today.
function relDay(iso, todayISO) {
  const diff = daysBetween(todayISO, iso);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = parseISO(iso);
  if (diff > 1 && diff < 7) return DAY_NAMES[d.getDay()];
  return `${DAY_NAMES[d.getDay()].slice(0, 3)} ${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function personMap(people) {
  return Object.fromEntries(people.map(p => [p.id, p]));
}

// "💻 Alex": the person's icon (if any) and name.
function nameOf(p) {
  return p ? (p.icon ? `${p.icon} ${p.name}` : p.name) : "";
}

function itemColor(item, people) {
  if (item.color) return item.color;
  const p = people[item.person_id];
  return p ? p.color : "#8a8f98";
}

const CATEGORY_LABELS = { school: "School", project: "Project", chore: "Chore", errand: "Errand", other: "Other" };
const LUNCH_LABELS = { buy: "🍽️ School lunch", pack: "🥪 Packed lunch", none: "No lunch" };
const LUNCH_SHORT = { buy: "🍽️ School", pack: "🥪 Packed", none: "No lunch" };

// Add or change an appointment for anyone in the family. Used by the phone app ("/api/appointments") and
// a phone-access person's page ("/api/my/appointments"); each page has its own openSheet, closeSheet, run and toast.
function appointmentSheet({ appt = null, people, day, base, onSaved, person = null }) {
  const who = String((appt ? appt.person_id : person) ?? "");
  const allDay = appt ? !appt.start_time : false;
  const whoChips = [...people.map(p => [String(p.id), nameOf(p)]), ["", "👪 Family"]]
    .map(([v, label]) => `<button type="button" class="chip ${v === who ? "on" : ""}" data-who="${v}">${esc(label)}</button>`).join("");
  openSheet(`
    <h2>${appt ? "Change appointment" : "Add an appointment"}</h2>
    <form id="appt-form">
      <label>Who's it for</label>
      <div class="chips wrap" id="appt-who">${whoChips}</div>
      <label>What<input name="title" required autocomplete="off" value="${esc(appt?.title || "")}" placeholder="Dentist"></label>
      <label>Day<input type="date" name="date" required value="${esc(appt?.date || day)}"></label>
      <label class="switch"><input type="checkbox" name="all_day" ${allDay ? "checked" : ""}> All day (no set time)</label>
      <div class="two" id="appt-times" ${allDay ? "hidden" : ""}>
        <label>Starts<input type="time" name="start" value="${esc(appt?.start_time || "09:00")}"></label>
        <label>Ends (optional)<input type="time" name="end" value="${esc(appt?.end_time || "")}"></label>
      </div>
      <label>Where (optional)<input name="location" autocomplete="off" value="${esc(appt?.location || "")}" placeholder="Main Street Dental"></label>
      <label>Notes (optional)<textarea name="notes" rows="2">${esc(appt?.notes || "")}</textarea></label>
      <div class="sheet-actions">
        ${appt ? `<button type="button" class="btn danger" id="appt-del">Delete</button>` : ""}
        <button type="button" class="btn secondary" id="appt-cancel">Cancel</button>
        <button type="submit" class="btn">Save</button>
      </div>
    </form>`, body => {
    const f = body.querySelector("#appt-form");
    let person = who;
    body.querySelectorAll("[data-who]").forEach(b => b.addEventListener("click", () => {
      person = b.dataset.who;
      body.querySelectorAll("[data-who]").forEach(x => x.classList.toggle("on", x === b));
    }));
    f.all_day.addEventListener("change", () => (body.querySelector("#appt-times").hidden = f.all_day.checked));
    body.querySelector("#appt-cancel").addEventListener("click", closeSheet);
    body.querySelector("#appt-del")?.addEventListener("click", () => run(async () => {
      await api(`${base}/${appt.id}`, { method: "DELETE" });
      closeSheet(); toast("Deleted"); onSaved();
    }));
    f.addEventListener("submit", e => {
      e.preventDefault();
      const timed = !f.all_day.checked;
      const payload = {
        title: f.title.value, person_id: person === "" ? null : Number(person), date: f.date.value,
        start_time: timed ? f.start.value || null : null, end_time: timed ? f.end.value || null : null,
        location: f.location.value, notes: f.notes.value,
      };
      run(async () => {
        await api(appt ? `${base}/${appt.id}` : base, { method: appt ? "PUT" : "POST", body: payload });
        closeSheet(); toast("Saved"); onSaved();
      });
    });
  });
}

// ------------------------------------------------------------ what each person's own page shows
// Admin → People → a person → "Their page shows". Full access: My page (/me). Phone-only: their page (/my-shifts).
const MY_PAGE_TABS = [["home", "🏠 Home (family board)"], ["calendar", "📅 Calendar"], ["kids", "🧒 Kids"], ["meds", "💊 Medicine"],
  ["meals", "🍽️ Meals & groceries"], ["lab", "🖥️ Homelab"], ["admin", "🛠️ Admin"]];
const PHONE_PAGE_TABS = [["home", "🏠 Home (family board)"], ["shifts", "💼 Their shifts"], ["appts", "📅 Appointments"],
  ["meds", "💊 Medicine"], ["meals", "🍽️ Meals & groceries"]];

function pageTabsFor(person, all) {
  let chosen = [];
  try { chosen = JSON.parse(person?.page_tabs || "[]"); } catch (_) {}
  const keys = all.map(([k]) => k);
  const on = chosen.filter(k => keys.includes(k));
  return on.length ? on : keys;  // nothing chosen yet = everything
}

// Hide the bottom-tab buttons this person's page doesn't show. Buttons carry data-view or data-go="/meals".
function applyPageTabs(person, all) {
  const on = pageTabsFor(person, all);
  document.querySelectorAll(".tabs button").forEach(b => {
    const key = b.dataset.view || (b.dataset.go || "").replace("/", "");
    b.hidden = !on.includes(key);
  });
  return on;
}

// ------------------------------------------------------------ medicine (the phone page, My page → Kids, Admin)
// Each page has its own openSheet, closeSheet, run and toast. data = GET /api/meds.

function medTime(iso) { return iso ? fmtTime(iso.slice(11, 16)) : ""; }
function medDay(iso) {
  const d = iso.slice(0, 10), t = toISO(new Date());
  return d === t ? `today ${medTime(iso)}` : `${relDay(d, t)} ${medTime(iso)}`;
}

// One person's medicine: scheduled doses with Take buttons, and as-needed ones with the last dose and Give.
function medsHTML(data, personId) {
  const list = data.meds.filter(m => m.person_id === personId);
  if (!list.length) return "";
  return list.map(m => {
    const slots = m.slots.map(s => s.taken
      ? `<span class="med-slot done">✅ ${fmtTime(s.time)} · ${medTime(s.taken.at)}${s.taken.by_name ? ` · ${esc(s.taken.by_name)}` : ""}</span>`
      : `<button type="button" class="med-slot" data-med-take="${m.id}" data-slot="${s.time}">💊 ${fmtTime(s.time)} · Take</button>`).join("");
    const last = m.last ? `Last: ${esc(medDay(m.last.at))}${m.last.dose ? ` · ${esc(m.last.dose)}` : ""}${m.last.by_name ? ` · by ${esc(m.last.by_name)}` : ""}` : "Not given yet";
    const rule = [m.min_hours && `every ${m.min_hours}h`, m.max_per_day && `max ${m.max_per_day}/day`].filter(Boolean).join(", ");
    const icon = m.kind === "puffer" ? "🫁" : "💊";
    return `<div class="med">
      <div class="med-head"><b>${icon} ${esc(m.name)}</b>${m.dose ? ` <span class="muted">${esc(m.dose)}</span>` : ""}</div>
      ${m.puffs_left != null ? `<div class="med-meta ${m.low ? "danger" : ""}">${m.low ? "⚠️ " : ""}About ${m.puffs_left} puffs left${m.low ? ": time to refill" : ""}</div>` : ""}
      ${slots ? `<div class="med-slots">${slots}</div>` : ""}
      ${!m.times.length ? `<div class="med-meta">${last}${m.today ? ` · ${m.today} today` : ""}${rule ? ` · ${rule}` : ""}
        ${m.next_ok ? `<br><b>Next dose not before ${esc(medTime(m.next_ok))}</b>` : m.limit_reached ? "<br><b>Today's limit reached</b>" : ""}</div>
        <button type="button" class="btn secondary small" data-med-take="${m.id}">${icon} Give now</button>` : ""}
      ${m.notes ? `<div class="med-meta">${esc(m.notes)}</div>` : ""}
    </div>`;
  }).join("");
}

// The buttons under each person's medicine: give medicine, temperature / sick, the doctor report.
function medsTools(personId) {
  return `<div class="mail-actions med-tools">
    <button type="button" class="btn small" data-give-med="${personId}">💊 Give medicine</button>
    <button type="button" class="btn secondary small" data-symptom="${personId}">🌡️ Temp / sick</button>
    <a class="btn secondary small" href="/report?person=${personId}">📄 Report</a></div>`;
}

function localISO(d) { return `${toISO(d)}T${d.toTimeString().slice(0, 5)}`; }

// Give medicine: who, what (from the cabinet), how much, when (now, or earlier if it's being logged late).
function giveSheet(data, personId, onDone) {
  let who = Number(personId) || data.people.find(p => p.is_kid)?.id;
  let catId = null, puffs = 2, when = 0;  // minutes ago; -1 = pick a time
  let me = null;
  try { me = Number(localStorage.getItem("med-by")) || null; } catch (_) {}
  const adults = data.people.filter(p => !p.is_kid);
  const row = () => data.meds.find(m => m.person_id === who && m.catalog_id === catId);
  const draw = body => {
    const theirs = data.cabinet.filter(c => c.people.some(t => t.person_id === who));
    const rest = data.cabinet.filter(c => !theirs.includes(c));
    if (!data.cabinet.some(c => c.id === catId)) catId = (theirs[0] || rest[0])?.id ?? null;
    const c = data.cabinet.find(x => x.id === catId);
    const r = row();
    const taker = c?.people.find(t => t.person_id === who);
    const puffer = c?.kind === "puffer";
    if (puffer) puffs = parseInt(taker?.dose || c.dose, 10) || puffs;
    const chip = x => `<button type="button" class="chip small ${x.id === catId ? "on" : ""}" data-cat="${x.id}">${x.kind === "puffer" ? "🫁" : "💊"} ${esc(x.name)}</button>`;
    body.querySelector("#give-body").innerHTML = `
      <label>Who</label>
      <div class="watch-chips">${data.people.map(p => `<button type="button" class="chip small ${p.id === who ? "on" : ""}" data-who="${p.id}">${esc(nameOf(p))}</button>`).join("")}</div>
      <label style="margin-top:10px">What</label>
      ${theirs.length ? `<div class="watch-chips">${theirs.map(chip).join("")}</div>` : ""}
      ${rest.length ? `<div class="hint" style="margin:6px 0 2px">Also in the cabinet</div><div class="watch-chips">${rest.map(chip).join("")}</div>` : ""}
      ${!data.cabinet.length ? `<p class="hint">The cabinet is empty.</p>` : ""}
      <button type="button" class="linkish" id="g-new" style="margin:6px 0 8px">+ New medicine</button>
      ${c ? `
        ${r?.last ? `<p class="hint">Last: ${esc(medDay(r.last.at))}${r.last.dose ? ` · ${esc(r.last.dose)}` : ""}${r.last.by_name ? ` · by ${esc(r.last.by_name)}` : ""}${r.next_ok ? ` · <b class="danger">next not before ${esc(medTime(r.next_ok))}</b>` : ""}</p>` : ""}
        ${puffer ? `<label>Puffs</label><div class="seg puff-seg">${[1, 2, 3, 4, 6, 8].map(n => `<button type="button" data-puffs="${n}" class="${n === puffs ? "on" : ""}">${n}</button>`).join("")}</div>
          <label class="switch"><input type="checkbox" name="spacer" checked> With the spacer (chamber)</label>`
          : `<label>How much<input name="dose" value="${esc(taker?.dose || c.dose || "")}" placeholder="e.g. 7.5 mL" autocomplete="off"></label>`}
        <label>When</label>
        <div class="watch-chips">${[[0, "Just now"], [15, "15 min ago"], [30, "30 min ago"], [60, "1 hour ago"], [120, "2 hours ago"], [-1, "Earlier…"]].map(([m, l]) =>
          `<button type="button" class="chip small ${m === when ? "on" : ""}" data-when="${m}">${l}</button>`).join("")}</div>
        <input type="datetime-local" name="at" ${when === -1 ? "" : "hidden"} value="${localISO(new Date(Date.now() - Math.max(when, 0) * 60000))}" max="${localISO(new Date())}" style="margin-top:6px">
        <div class="two" style="margin-top:10px"><label>Given by<select name="by">${adults.map(a => `<option value="${a.id}" ${a.id === me ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
          <label>Note (optional)<input name="note" placeholder="fever 38.5" autocomplete="off"></label></div>
        <p class="hint">Follow the package or your doctor for the dose.</p>` : ""}`;
  };
  openSheet(`
    <h2>💊 Give medicine</h2>
    <form id="give-form"><div id="give-body"></div>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="g-cancel">Cancel</button><button class="btn">Save</button></div>
    </form>`, body => {
    draw(body);
    const f = body.querySelector("#give-form");
    body.querySelector("#g-cancel").addEventListener("click", closeSheet);
    f.addEventListener("click", e => {
      const t = e.target;
      if (t.closest("[data-who]")) { who = Number(t.closest("[data-who]").dataset.who); catId = null; return draw(body); }
      if (t.closest("[data-cat]")) { catId = Number(t.closest("[data-cat]").dataset.cat); return draw(body); }
      if (t.closest("[data-puffs]")) {
        puffs = Number(t.closest("[data-puffs]").dataset.puffs);
        return body.querySelectorAll("[data-puffs]").forEach(x => x.classList.toggle("on", Number(x.dataset.puffs) === puffs));
      }
      if (t.closest("[data-when]")) {
        when = Number(t.closest("[data-when]").dataset.when);
        body.querySelectorAll("[data-when]").forEach(x => x.classList.toggle("on", Number(x.dataset.when) === when));
        f.at.hidden = when !== -1;
        if (when >= 0) f.at.value = localISO(new Date(Date.now() - when * 60000));
        return;
      }
      if (t.closest("#g-new")) return cabinetForm(data, null, onDone, who);
    });
    f.addEventListener("submit", e => {
      e.preventDefault();
      if (!catId) return toast("Pick the medicine", true);
      const c = data.cabinet.find(x => x.id === catId);
      const puffer = c.kind === "puffer";
      const note = [puffer && f.spacer?.checked ? "with spacer" : "", f.note.value.trim()].filter(Boolean).join(" · ");
      const at = when === 0 ? "" : f.at.value;
      const payload = { person_id: who, catalog_id: catId, dose: puffer ? "" : f.dose.value, puffs: puffer ? puffs : null,
        note, by_person: Number(f.by.value), at };
      try { localStorage.setItem("med-by", f.by.value); } catch (_) {}
      run(async () => {
        try { await api("/api/meds/give", { method: "POST", body: { ...payload, anyway: false } }); }
        catch (err) {
          if (err.status !== 409 || !confirm(`${err.message}\n\nLog it anyway?`)) throw err;
          await api("/api/meds/give", { method: "POST", body: { ...payload, anyway: true } });
        }
        const p = data.people.find(x => x.id === who);
        closeSheet(); toast(`💊 Logged ${c.name} for ${p?.name || ""}`); onDone();
      });
    });
  });
}

// Log a dose. Too soon or over the limit: the server says so, and it can be logged anyway after a confirm.
function medTake(data, medId, slot, onDone) {
  const m = data.meds.find(x => x.id === Number(medId));
  const adults = data.people.filter(p => !p.is_kid);
  let me = null;
  try { me = Number(localStorage.getItem("med-by")) || null; } catch (_) {}
  const puffer = m.kind === "puffer";
  const usual = parseInt(m.dose, 10) || 2;
  openSheet(`
    <h2>${puffer ? "🫁" : "💊"} ${esc(m.name)}${m.is_kid ? ` · ${esc(m.person)}` : ""}</h2>
    <form id="take-form">
      ${puffer ? `<label>Puffs</label><div class="seg puff-seg">${[1, 2, 3, 4, 6, 8].map(n =>
        `<button type="button" data-puffs="${n}" class="${n === usual ? "on" : ""}">${n}</button>`).join("")}</div>
        <label class="switch"><input type="checkbox" name="spacer" ${m.is_kid ? "checked" : ""}> With the spacer (chamber)</label>` : ""}
      <div class="two">
        ${puffer ? `<input type="hidden" name="dose" value="">` : `<label>Dose<input name="dose" value="${esc(m.dose)}" placeholder="e.g. 7.5 mL" autocomplete="off"></label>`}
        ${m.is_kid || !slot ? `<label>Given by<select name="by">${adults.map(a => `<option value="${a.id}" ${a.id === me ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>` : "<span></span>"}
      </div>
      <label>Note (optional)<input name="note" placeholder="fever 38.5, headache…" autocomplete="off"></label>
      ${m.next_ok ? `<p class="hint danger">⚠️ The next dose isn't due until ${esc(medTime(m.next_ok))}.</p>` : ""}
      ${m.limit_reached ? `<p class="hint danger">⚠️ Already ${m.today} today (limit ${m.max_per_day}).</p>` : ""}
      <p class="hint">Follow the package or your doctor for the dose.</p>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="t-cancel">Cancel</button><button class="btn">${slot ? "Taken" : "Log it"}</button></div>
    </form>`, body => {
    body.querySelector("#t-cancel").addEventListener("click", closeSheet);
    let puffs = usual;
    body.querySelectorAll("[data-puffs]").forEach(b => b.addEventListener("click", () => {
      puffs = Number(b.dataset.puffs);
      body.querySelectorAll("[data-puffs]").forEach(x => x.classList.toggle("on", x === b));
    }));
    body.querySelector("#take-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      const note = [puffer && f.spacer.checked ? "with spacer" : "", f.note.value.trim()].filter(Boolean).join(" · ");
      const payload = { slot: slot || "", dose: f.dose.value, note, by_person: f.by ? Number(f.by.value) : null,
        puffs: puffer ? puffs : null };
      if (f.by) try { localStorage.setItem("med-by", f.by.value); } catch (_) {}
      const send = anyway => api(`/api/meds/${m.id}/take`, { method: "POST", body: { ...payload, anyway } });
      run(async () => {
        try { await send(false); }
        catch (err) {
          if (err.status !== 409 || !confirm(`${err.message}\n\nLog it anyway?`)) throw err;
          await send(true);
        }
        closeSheet(); toast(`💊 Logged ${m.name}`); onDone();
      });
    });
  });
}

// "+ Medicine" under a person, or changing one: everything goes through the medicine cabinet.
// med = one of the person's rows (change its cabinet entry); personId = add something for that person.
function medForm(data, med, onDone, personId = null) {
  if (med) return cabinetForm(data, data.cabinet.find(c => c.id === med.catalog_id) || null, onDone);
  const p = data.people.find(x => x.id === personId);
  const others = data.cabinet.filter(c => !c.people.some(t => t.person_id === personId));
  if (!others.length) return cabinetForm(data, null, onDone, personId);
  openSheet(`
    <h2>💊 Add for ${esc(p ? p.name : "")}</h2>
    <p class="hint">From the medicine cabinet. Their own dose can be different (kids' doses go by weight).</p>
    <div class="card list">${others.map(c => `<div class="row">
      <div class="row-main"><div class="row-title">${c.kind === "puffer" ? "🫁" : "💊"} ${esc(c.name)}</div>
        <div class="row-meta">${c.dose ? `${esc(c.dose)} · ` : ""}${c.people.length ? `also ${c.people.map(t => esc(t.name)).join(", ")}` : "nobody yet"}</div></div>
      <button type="button" class="btn secondary small" data-assign="${c.id}">Add</button></div>`).join("")}</div>
    <div class="sheet-actions"><button type="button" class="btn secondary" id="a-cancel">Cancel</button>
      <button type="button" class="btn" id="a-new">+ New medicine</button></div>`, body => {
    body.querySelector("#a-cancel").addEventListener("click", closeSheet);
    body.querySelector("#a-new").addEventListener("click", () => cabinetForm(data, null, onDone, personId));
    body.querySelectorAll("[data-assign]").forEach(b => b.addEventListener("click", () =>
      cabinetForm(data, data.cabinet.find(c => c.id === Number(b.dataset.assign)), onDone, personId)));
  });
}

// A medicine in the cabinet: entered once, then ticked for whoever takes it, each with their own dose.
function cabinetForm(data, item, onDone, addPerson = null) {
  const takers = new Map((item?.people || []).map(t => [t.person_id, t]));
  if (addPerson && !takers.has(addPerson)) takers.set(addPerson, { person_id: addPerson, dose: "", puffs_left: null, isNew: true });
  const kind = item?.kind || "med";
  const personRow = p => {
    const t = takers.get(p.id);
    return `<div class="taker" data-taker="${p.id}">
      <label class="switch"><input type="checkbox" name="take-${p.id}" ${t ? "checked" : ""}> ${esc(nameOf(p))}</label>
      <input name="dose-${p.id}" value="${esc(t?.dose && t.dose !== item?.dose ? t.dose : "")}" placeholder="their dose" autocomplete="off">
      <input name="puffs-${p.id}" class="puffs-only" type="number" min="0" max="400" value="${t?.puffs_left ?? ""}" placeholder="puffs left">
    </div>`;
  };
  openSheet(`
    <h2>${item ? `${kind === "puffer" ? "🫁" : "💊"} ${esc(item.name)}` : "New medicine"}</h2>
    <form id="cab-form" class="${kind === "puffer" ? "is-puffer" : ""}">
      <label>Medicine<input name="name" required value="${esc(item?.name || "")}" list="med-presets" autocomplete="off" placeholder="Children's Motrin (ibuprofen)"></label>
      <datalist id="med-presets">${data.presets.map(p => `<option value="${esc(p.name)}">`).join("")}</datalist>
      <div class="two"><label>Type<select name="kind"><option value="med">💊 Medicine</option><option value="puffer" ${kind === "puffer" ? "selected" : ""}>🫁 Puffer (inhaler)</option></select></label>
        <label>Usual amount<input name="dose" value="${esc(item?.dose || "")}" placeholder="5 mL, 1 tablet, 2 puffs" autocomplete="off"></label></div>
      <label>Reminder times (daily medicine; blank = only when needed)<input name="times" value="${esc((item?.times || []).join(", "))}" placeholder="08:00, 20:00" autocomplete="off"></label>
      <div class="two"><label>At least … hours apart<input name="min_hours" type="number" step="0.5" min="0" value="${item?.min_hours ?? ""}"></label>
        <label>At most … a day<input name="max_per_day" type="number" min="0" value="${item?.max_per_day ?? ""}"></label></div>
      <label>Notes<input name="notes" value="${esc(item?.notes || "")}" placeholder="with food, shake well" autocomplete="off"></label>
      <h3 class="section-h">Who takes it</h3>
      <div class="takers">${data.people.map(personRow).join("")}</div>
      <p class="hint">Leave "their dose" blank to use the usual amount. For puffers, each person's own puffer keeps its own count (200 when new). Use the package or your doctor's numbers.</p>
      <div class="sheet-actions">${item ? `<button type="button" class="btn danger" id="c-stop">Stop for everyone</button>` : ""}
        <button type="button" class="btn secondary" id="c-cancel">Cancel</button><button class="btn">Save</button></div>
    </form>`, body => {
    const f = body.querySelector("#cab-form");
    f.kind.addEventListener("change", () => f.classList.toggle("is-puffer", f.kind.value === "puffer"));
    f.name.addEventListener("change", () => {
      const p = data.presets.find(x => x.name === f.name.value);
      if (!p) return;
      if (!f.min_hours.value && p.min_hours) f.min_hours.value = p.min_hours;
      if (!f.max_per_day.value && p.max_per_day) f.max_per_day.value = p.max_per_day;
      if (p.kind) { f.kind.value = p.kind; f.classList.toggle("is-puffer", p.kind === "puffer"); }
      if (p.dose && !f.dose.value) f.dose.value = p.dose;
      if (p.times && !f.times.value) f.times.value = p.times.join(", ");
    });
    body.querySelector("#c-cancel").addEventListener("click", closeSheet);
    body.querySelector("#c-stop")?.addEventListener("click", () => run(async () => {
      if (!confirm(`Stop ${item.name} for everyone? Its history stays.`)) return;
      await api(`/api/meds/cabinet/${item.id}`, { method: "DELETE" }); closeSheet(); toast("Stopped"); onDone();
    }));
    f.addEventListener("submit", e => {
      e.preventDefault();
      const times = f.times.value.split(/[,\s]+/).map(t => t.trim()).filter(Boolean).map(t => t.length === 4 ? "0" + t : t);
      const puffer = f.kind.value === "puffer";
      const people = data.people.filter(p => f[`take-${p.id}`].checked).map(p => {
        const n = f[`puffs-${p.id}`].value;
        return { person_id: p.id, dose: f[`dose-${p.id}`].value, puffs_left: puffer ? (n !== "" ? Number(n) : (takers.get(p.id)?.isNew || !takers.has(p.id) ? 200 : null)) : null };
      });
      const b = { name: f.name.value, kind: f.kind.value, dose: f.dose.value, times, notes: f.notes.value, people,
        min_hours: f.min_hours.value ? Number(f.min_hours.value) : null, max_per_day: f.max_per_day.value ? Number(f.max_per_day.value) : null };
      run(async () => {
        await api(item ? `/api/meds/cabinet/${item.id}` : "/api/meds/cabinet", { method: item ? "PUT" : "POST", body: b });
        closeSheet(); toast("Saved"); onDone();
      });
    });
  });
}

// Note symptoms (for the doctor): tap what's going on, how bad, a temperature, a note.
async function symptomSheet(personId, people, onDone) {
  const kinds = await api("/api/meds/symptom-kinds");
  const p = people.find(x => x.id === Number(personId));
  const picked = new Set();
  let severity = "";
  openSheet(`
    <h2>🤒 ${esc(p ? p.name : "")}: how are they?</h2>
    <div class="watch-chips">${kinds.map(k => `<button type="button" class="chip small" data-kind="${esc(k)}">${esc(k)}</button>`).join("")}</div>
    <form id="sym-form">
      <label style="margin-top:10px">How bad</label>
      <div class="seg puff-seg">${[["mild", "Mild"], ["moderate", "Medium"], ["bad", "Bad"]].map(([v, l]) => `<button type="button" data-sev="${v}">${l}</button>`).join("")}</div>
      <div class="two"><label>Temperature °C (optional)<input name="temp" type="number" step="0.1" min="30" max="45" placeholder="38.5" inputmode="decimal"></label>
        <label>When<input name="at" type="datetime-local" value="${toISO(new Date())}T${new Date().toTimeString().slice(0, 5)}"></label></div>
      <label>Note<input name="note" placeholder="coughing at night, woke up twice…" autocomplete="off"></label>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="s-cancel">Cancel</button><button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelectorAll("[data-kind]").forEach(b => b.addEventListener("click", () => {
      picked.has(b.dataset.kind) ? picked.delete(b.dataset.kind) : picked.add(b.dataset.kind);
      b.classList.toggle("on", picked.has(b.dataset.kind));
    }));
    body.querySelectorAll("[data-sev]").forEach(b => b.addEventListener("click", () => {
      severity = severity === b.dataset.sev ? "" : b.dataset.sev;
      body.querySelectorAll("[data-sev]").forEach(x => x.classList.toggle("on", x.dataset.sev === severity));
    }));
    body.querySelector("#s-cancel").addEventListener("click", closeSheet);
    body.querySelector("#sym-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        await api("/api/meds/symptoms", { method: "POST", body: { person_id: Number(personId), kinds: [...picked], severity,
          temp: f.temp.value ? Number(f.temp.value) : null, note: f.note.value, at: f.at.value } });
        closeSheet(); toast("Noted"); onDone();
      });
    });
  });
}

// ------------------------------------------------------------ notifications on an adult's phone
// Used by My page and the phone-only page; each has its own openSheet, closeSheet, run and toast.
// iPhones only allow web notifications for a planner added to the Home Screen and opened from its icon.

function b64uBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function notificationsSheet() {
  const info = await api("/api/alerts/info");
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  let who = Number(localStorage.getItem("alerts-person")) || info.member || info.adults[0]?.id;
  const person = () => info.adults.find(a => a.id === who) || info.adults[0];
  const reg = supported && window.isSecureContext ? await navigator.serviceWorker.register("/sw.js") : null;
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  const on = sub && Notification.permission === "granted";
  openSheet(`
    <h2>🔔 Notifications on this phone</h2>
    ${!window.isSecureContext ? `<p class="hint">Open the planner from its https:// address to use notifications.</p>`
      : !supported ? `<p class="hint">${ios && !standalone
        ? "On an iPhone: tap Share → <b>Add to Home Screen</b>, open the planner from that icon, then come back here."
        : "This browser can't show notifications from the planner."}</p>` : ""}
    <form id="alerts-form">
      ${info.adults.length > 1 ? `<label>Whose phone is this?<select name="who">${info.adults.map(a =>
        `<option value="${a.id}" ${a.id === who ? "selected" : ""}>${esc(nameOf(a))}</option>`).join("")}</select></label>` : ""}
      <label class="switch"><input type="checkbox" name="evening"> 🌙 8 pm check: what tomorrow needs (Day number, gym, lunches, forms, school payments, lunch ordering)</label>
      <label class="switch"><input type="checkbox" name="meds"> 💊 Medicine: pill reminders, and when someone gives the kids medicine</label>
      ${info.homelab ? `<label class="switch"><input type="checkbox" name="homelab"> 🖥️ Homelab alerts: a container stops, a new device joins, slow internet</label>` : ""}
      <p class="hint">${on ? "✅ This phone gets notifications." : "This phone doesn't get notifications yet."}</p>
      <div class="sheet-actions">
        <button type="button" class="btn secondary" id="al-close">Close</button>
        ${on ? `<button type="button" class="btn secondary" id="al-test">Send a test</button>` : ""}
        <button class="btn" ${reg ? "" : "disabled"}>${on ? "Save" : "Turn on"}</button>
      </div>
    </form>`, body => {
    const f = body.querySelector("#alerts-form");
    const fill = () => {
      const p = person();
      f.evening.checked = p.topics.includes("evening");
      f.meds.checked = p.topics.includes("meds");
      if (f.homelab) f.homelab.checked = p.topics.includes("homelab");
    };
    fill();
    f.who?.addEventListener("change", () => { who = Number(f.who.value); fill(); });
    body.querySelector("#al-close").addEventListener("click", closeSheet);
    body.querySelector("#al-test")?.addEventListener("click", () => run(async () => {
      const r = await api("/api/alerts/test", { method: "POST", body: { person_id: who } });
      toast(r.sent ? "Sent. Check your notifications" : "Couldn't send it", !r.sent);
    }));
    f.addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        if (!on) {
          if (await Notification.requestPermission() !== "granted") throw new Error("Notifications were not allowed");
          const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(info.key) });
          await api("/api/alerts/subscribe", { method: "POST", body: { person_id: who, subscription: s.toJSON() } });
        } else {
          await api("/api/alerts/subscribe", { method: "POST", body: { person_id: who, subscription: sub.toJSON() } });
        }
        const topics = [f.evening.checked && "evening", f.meds.checked && "meds", f.homelab?.checked && "homelab"].filter(Boolean);
        await api("/api/alerts/topics", { method: "PUT", body: { person_id: who, topics } });
        try { localStorage.setItem("alerts-person", String(who)); } catch (_) {}
        closeSheet(); toast(on ? "Saved" : "Notifications are on 🔔");
      });
    });
  });
}

// Open-Meteo weather codes -> emoji + words
function weatherInfo(code) {
  const table = [
    [[0], "☀️", "Clear"], [[1], "🌤️", "Mostly clear"], [[2], "⛅", "Partly cloudy"], [[3], "☁️", "Cloudy"],
    [[45, 48], "🌫️", "Fog"], [[51, 53, 55, 56, 57], "🌦️", "Drizzle"], [[61, 63, 65, 66, 67, 80, 81, 82], "🌧️", "Rain"],
    [[71, 73, 75, 77, 85, 86], "🌨️", "Snow"], [[95, 96, 99], "⛈️", "Storms"],
  ];
  for (const [codes, icon, label] of table) if (codes.includes(code)) return { icon, label };
  return { icon: "🌡️", label: "" };
}
