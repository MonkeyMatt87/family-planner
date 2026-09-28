// House: car and house upkeep, the family's contacts, and a printable sheet for a babysitter.

const $ = sel => document.querySelector(sel);
const today = toISO(new Date());
const TITLES = { upkeep: "Upkeep", contacts: "Contacts", sitter: "Sitter sheet" };
const AREAS = [["car", "🚗 Car"], ["house", "🏠 House"], ["yard", "🌳 Yard"], ["other", "🔧 Other"]];
const GROUPS = [["emergency", "🚨 Emergency"], ["family", "👪 Family"], ["health", "🩺 Health"], ["school", "🏫 School"],
  ["sitters", "🧑‍🍼 Sitters"], ["other", "📇 Other"]];
const NIGHTS = ["Every night", "School nights", "Other nights"];
const state = { view: "upkeep", upkeep: null, contacts: null, people: [], who: null };

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
function store(k, v) { try { localStorage.setItem(`house-${k}`, v); } catch (_) {} }
function recall(k) { try { return localStorage.getItem(`house-${k}`); } catch (_) { return null; } }
const shortDate = iso => { const d = parseISO(iso); return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? `, ${d.getFullYear()}` : ""}`; };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const telHref = n => `tel:${n.replace(/[^\d+]/g, "")}`;
const cancelBtn = id => `<button type="button" class="btn secondary" id="${id}">Cancel</button>`;

// ------------------------------------------------------------ upkeep

function dueLabel(j) {
  if (j.days == null) return "No date yet";
  if (j.days < 0) return `${plural(-j.days, "day")} overdue`;
  if (j.days === 0) return "Due today";
  if (j.days === 1) return "Due tomorrow";
  if (j.days <= 14) return `Due in ${j.days} days`;
  return `Due ${shortDate(j.due)}`;
}

function jobRow(j) {
  const every = j.every_months ? (j.every_months === 12 ? "every year" : j.every_months === 1 ? "every month" : `every ${j.every_months} months`) : "once";
  return `<div class="job ${j.state}">
    <div class="job-main" data-job="${j.id}">
      <div class="job-title">${esc(j.title)}${j.what ? ` <span class="muted">· ${esc(j.what)}</span>` : ""}</div>
      <div class="job-meta"><b class="due">${dueLabel(j)}</b> · ${every}${j.fixed ? " (same date)" : ""}${j.last_done ? ` · last done ${esc(shortDate(j.last_done))}` : ""}</div>
      ${j.notes ? `<div class="job-meta">${esc(j.notes)}</div>` : ""}
    </div>
    <button class="btn ${j.state === "ok" || j.state === "unknown" ? "secondary" : ""} small" data-done="${j.id}">✓ Done</button>
  </div>`;
}

async function renderUpkeep() {
  const d = state.upkeep = await api("/api/house/upkeep");
  const need = d.jobs.filter(j => j.state === "overdue" || j.state === "soon");
  const later = d.jobs.filter(j => j.state === "ok");
  const undated = d.jobs.filter(j => j.state === "unknown");
  const section = (title, list, hint = "") => list.length ? `<h3 class="section-h">${title}</h3>${hint}<div class="card list">${list.map(jobRow).join("")}</div>` : "";
  $("#view-upkeep").innerHTML = `
    ${need.length ? "" : `<div class="card pad all-good">✅ Nothing needs doing right now.</div>`}
    ${section("Needs doing", need)}
    ${section("Coming up", later)}
    ${section("No date yet", undated, `<p class="hint">Tap ✓ Done and pick the day it was last done, and the planner works out the next one.</p>`)}
    <button class="btn secondary wide" id="job-add">+ Add a job</button>
    <p class="hint">A job shows in the 8 pm check a few days before it's due (you choose how many), on the day, and on Mondays while it's overdue.</p>
    <h3 class="section-h">Done lately</h3>
    <div class="card list">${d.log.slice(0, 15).map(l => `<div class="row"><div class="row-main">
      <div class="row-title">${esc(l.title)}</div>
      <div class="row-meta">${esc(shortDate(l.done))}${l.by_name ? ` · ${esc(l.by_name)}` : ""}${l.cost != null ? ` · $${(l.cost / 100).toFixed(2)}` : ""}${l.km ? ` · ${l.km.toLocaleString()} km` : ""}${l.note ? ` · ${esc(l.note)}` : ""}</div></div>
      <button class="icon-btn small" data-del-log="${l.id}" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("")
      || `<div class="row"><div class="row-main"><div class="row-meta">Nothing logged yet.</div></div></div>`}</div>`;
}

function jobForm(j) {
  openSheet(`
    <h2>${j ? "Change job" : "New job"}</h2>
    <form id="job-form">
      <label>What<input name="title" required maxlength="80" value="${esc(j?.title || "")}" placeholder="🛢️ Oil change" autocomplete="off"></label>
      <div class="two">
        <label>Area<select name="area">${AREAS.map(([k, l]) => `<option value="${k}" ${(j?.area || "house") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Which (optional)<input name="what" maxlength="40" value="${esc(j?.what || "")}" placeholder="Honda, basement" autocomplete="off"></label>
      </div>
      <div class="two">
        <label>Every (months)<input name="every" type="number" min="1" max="120" value="${j?.every_months ?? ""}" placeholder="Just once"></label>
        <label>Next due<input name="due" type="date" value="${esc(j?.due || "")}"></label>
      </div>
      <label class="switch"><input type="checkbox" name="fixed" ${j?.fixed ? "checked" : ""}> The same date each time (like tire swaps), not counted from when it was done</label>
      <label>Remind me (days before)<input name="remind" type="number" min="0" max="60" value="${j?.remind_days ?? 7}"></label>
      <label>Notes<input name="notes" maxlength="300" value="${esc(j?.notes || "")}" placeholder="Or every 8,000 km" autocomplete="off"></label>
      <div class="sheet-actions">${j ? `<button type="button" class="btn secondary danger-text" id="job-del">Remove</button>` : ""}${cancelBtn("job-cancel")}<button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelector("#job-cancel").addEventListener("click", closeSheet);
    body.querySelector("#job-del")?.addEventListener("click", () => run(async () => {
      await api(`/api/house/upkeep/${j.id}`, { method: "DELETE" }); closeSheet(); toast("Removed"); renderUpkeep();
    }));
    body.querySelector("#job-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        const data = { title: f.title.value, area: f.area.value, what: f.what.value, every_months: f.every.value ? Number(f.every.value) : null,
          fixed: f.fixed.checked, due: f.due.value || null, remind_days: Number(f.remind.value || 7), notes: f.notes.value };
        await api(j ? `/api/house/upkeep/${j.id}` : "/api/house/upkeep", { method: j ? "PUT" : "POST", body: data });
        closeSheet(); toast("Saved"); renderUpkeep();
      });
    });
  });
}

function doneForm(j) {
  openSheet(`
    <h2>✓ ${esc(j.title)}</h2>
    <form id="done-form">
      <label>Done on<input name="done" type="date" value="${today}" max="${today}" required></label>
      <div class="two">
        <label>Cost (optional)<input name="cost" type="number" min="0" step="0.01" inputmode="decimal" placeholder="$"></label>
        ${j.area === "car" ? `<label>Odometer (optional)<input name="km" type="number" min="0" inputmode="numeric" placeholder="km"></label>` : "<span></span>"}
      </div>
      <label>Note (optional)<input name="note" maxlength="200" placeholder="${j.area === "car" ? "Jiffy Lube, synthetic" : "Bought 2 spares"}" autocomplete="off"></label>
      ${state.who ? "" : `<label>Who did it<select name="by"><option value="">—</option>${state.people.filter(p => !p.is_kid).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></label>`}
      <p class="hint">${j.every_months ? (j.fixed ? "The next one stays on the same date next time round." : `The next one is ${j.every_months === 12 ? "a year" : plural(j.every_months, "month")} after this.`) : "It's a one-off, so it won't come back."}</p>
      <div class="sheet-actions">${cancelBtn("done-cancel")}<button class="btn">Done</button></div>
    </form>`, body => {
    body.querySelector("#done-cancel").addEventListener("click", closeSheet);
    body.querySelector("#done-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        const r = await api(`/api/house/upkeep/${j.id}/done`, { method: "POST", body: {
          done: f.done.value, note: f.note.value, cost: f.cost.value ? Number(f.cost.value) : null,
          km: f.km?.value ? Number(f.km.value) : null, by_person: f.by?.value ? Number(f.by.value) : null } });
        closeSheet(); toast(r.due ? `Next: ${shortDate(r.due)}` : "Done"); renderUpkeep();
      });
    });
  });
}

// ------------------------------------------------------------ contacts

function contactRow(c) {
  const bits = [c.role, c.person && !c.auto ? `for ${c.person}` : ""].filter(Boolean).join(" · ");
  return `<div class="contact">
    <div class="contact-main ${c.auto ? "" : "tap"}" ${c.auto ? "" : `data-contact="${c.id}"`}>
      <div class="c-name">${esc(c.name)}${c.sitter ? ` <span class="tag">sitter</span>` : ""}</div>
      ${bits ? `<div class="c-meta">${esc(bits)}</div>` : ""}
      ${c.address ? `<div class="c-meta"><a href="https://maps.google.com/?q=${encodeURIComponent(c.address)}" target="_blank" rel="noopener">📍 ${esc(c.address)}</a></div>` : ""}
      ${c.notes ? `<div class="c-meta">${esc(c.notes)}</div>` : ""}
      ${c.auto ? `<div class="c-meta muted">From Admin → People</div>` : ""}
    </div>
    <div class="c-actions">
      ${c.phone ? `<a class="btn small" href="${telHref(c.phone)}">📞 ${esc(c.phone)}</a>` : ""}
      ${c.phone2 ? `<a class="btn secondary small" href="${telHref(c.phone2)}">📞 ${esc(c.phone2)}</a>` : ""}
      ${c.email ? `<a class="btn secondary small" href="mailto:${esc(c.email)}">✉️ Email</a>` : ""}
    </div>
  </div>`;
}

async function renderContacts() {
  const d = state.contacts = await api("/api/house/contacts");
  const q = (recall("q") || "").toLowerCase();
  const match = c => !q || [c.name, c.role, c.phone, c.email, c.notes, c.person].join(" ").toLowerCase().includes(q);
  const list = d.contacts.filter(match);
  $("#view-contacts").innerHTML = `
    <div class="add-bar"><input id="c-search" type="search" placeholder="Search" value="${esc(recall("q") || "")}" autocomplete="off">
      <button class="btn" id="contact-add">+ Add</button></div>
    ${GROUPS.map(([g, label]) => {
      const rows = list.filter(c => c.grp === g);
      return rows.length ? `<h3 class="section-h">${label}</h3><div class="card list">${rows.map(contactRow).join("")}</div>` : "";
    }).join("") || `<div class="empty">No contacts${q ? " match" : " yet"}.</div>`}
    <p class="hint">Tap a name to change it. Ones marked <span class="tag">sitter</span> go on the sitter sheet.</p>`;
}

function contactForm(c) {
  const people = state.contacts.people;
  openSheet(`
    <h2>${c ? "Change contact" : "New contact"}</h2>
    <form id="contact-form">
      <label>Name<input name="name" required maxlength="60" value="${esc(c?.name || "")}" placeholder="Dr. Patel" autocomplete="off"></label>
      <div class="two">
        <label>Who they are<input name="role" maxlength="60" value="${esc(c?.role || "")}" placeholder="Family doctor" autocomplete="off"></label>
        <label>Group<select name="grp">${GROUPS.map(([g, l]) => `<option value="${g}" ${(c?.grp || "other") === g ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div class="two">
        <label>Phone<input name="phone" type="tel" maxlength="30" value="${esc(c?.phone || "")}" autocomplete="off"></label>
        <label>Other phone<input name="phone2" type="tel" maxlength="30" value="${esc(c?.phone2 || "")}" placeholder="Cell, after hours" autocomplete="off"></label>
      </div>
      <label>Email<input name="email" type="email" maxlength="80" value="${esc(c?.email || "")}" autocomplete="off"></label>
      <label>Address<input name="address" maxlength="160" value="${esc(c?.address || "")}" autocomplete="off"></label>
      <div class="two">
        <label>For<select name="person"><option value="">Everyone</option>${people.map(p => `<option value="${p.id}" ${c?.person_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
        <label class="switch" style="align-self:end"><input type="checkbox" name="sitter" ${c?.sitter ? "checked" : ""}> On the sitter sheet</label>
      </div>
      <label>Notes<input name="notes" maxlength="300" value="${esc(c?.notes || "")}" placeholder="Walk-in clinic Sat 9–12" autocomplete="off"></label>
      <div class="sheet-actions">${c ? `<button type="button" class="btn secondary danger-text" id="c-del">Remove</button>` : ""}${cancelBtn("c-cancel")}<button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelector("#c-cancel").addEventListener("click", closeSheet);
    body.querySelector("#c-del")?.addEventListener("click", () => run(async () => {
      await api(`/api/house/contacts/${c.id}`, { method: "DELETE" }); closeSheet(); toast("Removed"); renderContacts();
    }));
    body.querySelector("#contact-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        const data = { name: f.name.value, role: f.role.value, grp: f.grp.value, phone: f.phone.value, phone2: f.phone2.value,
          email: f.email.value, address: f.address.value, notes: f.notes.value, person_id: f.person.value ? Number(f.person.value) : null,
          sitter: f.sitter.checked };
        await api(c ? `/api/house/contacts/${c.id}` : "/api/house/contacts", { method: c ? "PUT" : "POST", body: data });
        closeSheet(); toast("Saved"); renderContacts();
      });
    });
  });
}

// ------------------------------------------------------------ the sitter sheet (prints on one page)

async function renderSitter() {
  const d = await api("/api/house/sitter");
  state.sitter = d;
  const kidBlock = k => {
    const groups = [0, 1, 2].map(n => [n, k.bedtime.filter(b => b.school_days === n)]).filter(([, l]) => l.length);
    return `<div class="s-kid">
      <h3>${esc(k.name)}${k.age != null ? ` <span class="muted">· ${k.age}</span>` : ""}</h3>
      ${groups.map(([n, l]) => `<div class="s-line"><b>🌙 ${NIGHTS[n]}:</b> ${l.map(b => `${b.at ? `${fmtTime(b.at)} ` : ""}${esc(b.title)}`).join(" → ")}</div>`).join("")}
      ${k.meds.length ? k.meds.map(m => `<div class="s-line"><b>💊 ${esc(m.name)}</b>${m.dose ? ` · ${esc(m.dose)}` : ""}${
        m.times.length ? ` · at ${m.times.map(fmtTime).join(", ")}` : ""}${m.min_hours ? ` · at least ${m.min_hours} h apart` : ""}${
        m.max_per_day ? ` · no more than ${m.max_per_day} a day` : ""}${m.notes ? ` · ${esc(m.notes)}` : ""}</div>`).join("")
        : `<div class="s-line muted">No medicine.</div>`}
      ${k.last_med ? `<div class="s-line">Last medicine: ${esc(k.last_med.name)} at ${esc(k.last_med.at.replace("T", " "))}</div>` : ""}
    </div>`;
  };
  $("#view-sitter").innerHTML = `
    <div class="no-print row-actions">
      <button class="btn" id="print">🖨️ Print</button>
      <button class="btn secondary" id="sitter-edit">✏️ Address &amp; notes</button>
    </div>
    <div class="sitter card pad">
      <h2>${esc(d.family || "Our family")}</h2>
      ${d.address ? `<div class="s-big">🏠 ${esc(d.address)}</div>` : `<div class="s-line muted no-print">Add your address (✏️) so it's there to read out in an emergency.</div>`}
      <h3 class="s-h">📞 Phone numbers</h3>
      ${d.contacts.map(c => `<div class="s-contact"><span>${esc(c.name)}${c.role ? ` <span class="muted">(${esc(c.role)})</span>` : ""}</span>
        <span class="s-num">${[c.phone, c.phone2].filter(Boolean).map(n => `<a href="${telHref(n)}">${esc(n)}</a>`).join(" · ")}</span></div>`).join("")
        || `<div class="s-line muted">Mark contacts "On the sitter sheet" on the Contacts tab.</div>`}
      <h3 class="s-h">🧒 The kids</h3>
      ${d.kids.map(kidBlock).join("")}
      ${d.notes ? `<h3 class="s-h">📝 Good to know</h3><div class="s-notes">${esc(d.notes).replace(/\n/g, "<br>")}</div>` : ""}
      <div class="s-foot muted">Printed ${esc(shortDate(d.today))}</div>
    </div>`;
}

function sitterForm() {
  const d = state.sitter;
  openSheet(`
    <h2>Sitter sheet</h2>
    <form id="sitter-form">
      <label>Home address<input name="address" maxlength="200" value="${esc(d.address || "")}" autocomplete="street-address"></label>
      <label>Good to know<textarea name="notes" rows="7" maxlength="2000" placeholder="Wi-Fi: …&#10;First-aid kit: bathroom cupboard&#10;No screens after 7&#10;Allergies: …">${esc(d.notes || "")}</textarea></label>
      <p class="hint">Anyone who can open this page sees it (the adults and phone sign-ins), and so will anyone holding the printout.</p>
      <div class="sheet-actions">${cancelBtn("s-cancel")}<button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelector("#s-cancel").addEventListener("click", closeSheet);
    body.querySelector("#sitter-form").addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        await api("/api/house/sitter", { method: "PUT", body: { address: e.target.address.value, notes: e.target.notes.value } });
        closeSheet(); toast("Saved"); renderSitter();
      });
    });
  });
}

// ------------------------------------------------------------ page

async function render() {
  $("#page-title").textContent = TITLES[state.view];
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== `view-${state.view}`));
  const el = $(`#view-${state.view}`);
  if (!el.innerHTML.trim()) el.innerHTML = `<div class="empty">Loading…</div>`;
  await run(({ upkeep: renderUpkeep, contacts: renderContacts, sitter: renderSitter })[state.view]);
}

function show(view) { state.view = view; store("view", view); scrollTo(0, 0); render(); }

document.addEventListener("click", e => {
  const t = e.target;
  const tab = t.closest(".tabs [data-view]");
  if (tab) return show(tab.dataset.view);
  const done = t.closest("[data-done]");
  if (done) return doneForm(state.upkeep.jobs.find(j => j.id === Number(done.dataset.done)));
  const job = t.closest("[data-job]");
  if (job) return jobForm(state.upkeep.jobs.find(j => j.id === Number(job.dataset.job)));
  if (t.closest("#job-add")) return jobForm(null);
  const delLog = t.closest("[data-del-log]");
  if (delLog) return run(async () => { await api(`/api/house/upkeep/log/${delLog.dataset.delLog}`, { method: "DELETE" }); renderUpkeep(); });
  const contact = t.closest("[data-contact]");
  if (contact) return contactForm(state.contacts.contacts.find(c => c.id === Number(contact.dataset.contact)));
  if (t.closest("#contact-add")) return contactForm(null);
  if (t.closest("#print")) return print();
  if (t.closest("#sitter-edit")) return sitterForm();
});
document.addEventListener("input", e => {
  if (e.target.id !== "c-search") return;
  store("q", e.target.value);
  clearTimeout(renderContacts.t);
  renderContacts.t = setTimeout(async () => {
    await run(renderContacts);
    const box = $("#c-search");
    box.focus(); box.setSelectionRange(box.value.length, box.value.length);
  }, 250);
});

$("#sheet-backdrop").addEventListener("click", closeSheet);
$("#refresh-btn").addEventListener("click", render);

// The back link returns to the page House was opened from (My page, the phone page, the planner).
const BACK = { "/me": "← My page", "/my-shifts": "← My planner", "/mobile": "← Family board", "/": "← Planner", "/admin": "← Admin" };
function setBack(role) {
  let from = "";
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && ref.origin === location.origin && BACK[ref.pathname]) sessionStorage.setItem("house-back", ref.pathname);
    from = sessionStorage.getItem("house-back") || "";
  } catch (_) {}
  if (!BACK[from]) from = role === "member" ? "/my-shifts" : "/";
  $("#back-link").href = from;
  $("#back-link").textContent = BACK[from];
}

run(async () => {
  const me = await api("/api/me").catch(() => ({}));
  setBack(me.role);
  state.who = me.person?.id || null;
  state.people = await api(me.role === "member" ? "/api/my/people" : "/api/people").catch(() => []);
  state.view = TITLES[recall("view")] ? recall("view") : "upkeep";
  const hash = location.hash.slice(1);
  if (TITLES[hash]) state.view = hash;
  await render();
});
