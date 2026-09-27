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
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
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
