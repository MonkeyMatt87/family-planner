// My page (/me), for adults: Home (the family board), Calendar, Kids, Homelab (Proxmox, AdGuard, speed tests, network).

const $ = sel => document.querySelector(sel);
const today = toISO(new Date());
const state = { view: "home", lab: "pve", people: [], byId: {}, month: today.slice(0, 7), day: today, items: [], kids: [] };
const TITLES = { home: "Home", calendar: "Calendar", kids: "Kids", meds: "Medicine", lab: "Homelab" };

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

function store(key, value) { try { localStorage.setItem(`me-${key}`, value); } catch (_) {} }
function recall(key) { try { return localStorage.getItem(`me-${key}`); } catch (_) { return null; } }

// ------------------------------------------------------------ formatting

const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
function bytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}
function rate(n) {  // bytes per second -> Mbit/s
  const mbit = (n || 0) * 8 / 1e6;
  return mbit >= 10 ? `${mbit.toFixed(0)} Mb/s` : `${mbit.toFixed(1)} Mb/s`;
}
function uptime(s) {
  if (!s) return "";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}
function ago(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}
// For the 24-hour charts: the axis ends read "24 h ago" and "now"; the hover says the day and time.
function hourFmt(t, long) {
  const d = new Date(t);
  if (long) return `${relDay(toISO(d), today)} ${clock(d)}`;
  return Date.now() - t < 30 * 60000 ? "now" : `${Math.round((Date.now() - t) / 3600000)} h ago`;
}
function clock(d) { return fmtTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`); }

// A share-of-total bar. Warning colours only for capacity (disk, memory), never for plain counts.
function meter(label, used, total, text, capacity = true) {
  const f = total ? used / total : 0;
  if (!capacity) return meter(label, used, total, text, true).replace(/fill (crit|warn)/, "fill");
  return `<div class="meter"><div class="mrow"><span>${esc(label)}</span><span>${text ?? `${bytes(used)} of ${bytes(total)} · ${pct(f)}`}</span></div>
    <div class="track"><div class="fill ${f > .9 ? "crit" : f > .75 ? "warn" : ""}" style="width:${Math.min(100, f * 100).toFixed(1)}%"></div></div></div>`;
}

// ------------------------------------------------------------ charts (inline SVG, hover tooltips)
// One y-axis per chart. Lines are 2px; bars have rounded tops and a 2px gap.

function showTip(evt, html) {
  const tip = $("#tip");
  tip.innerHTML = html;
  tip.hidden = false;
  const p = evt.touches ? evt.touches[0] : evt;
  tip.style.left = `${Math.max(70, Math.min(innerWidth - 70, p.clientX))}px`;
  tip.style.top = `${p.clientY}px`;
}
function hideTip() { $("#tip").hidden = true; }

// series: [{name, color, points: [[x, y], ...]}] with x as a number (time in ms, or an index).
function lineChart(el, { series, height = 150, yFmt = v => v, xFmt = v => v, yMin = 0, labels = true, axis = true }) {
  const w = el.clientWidth || 340, h = height, padL = axis ? 40 : 2, padR = labels ? 62 : 4, padT = 8, padB = axis ? 18 : 4;
  const all = series.flatMap(s => s.points);
  if (all.length < 2) { el.innerHTML = `<div class="empty small">Not enough data yet.</div>`; return; }
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = yMin ?? Math.min(...ys), hiRaw = Math.max(...ys);
  let hi = hiRaw === lo ? lo + 1 : hiRaw + (hiRaw - lo) * .08;
  if (lo === 0 && hi > 0) {  // round the top to a tidy number (945 -> 1000) so the axis reads cleanly
    const step = 10 ** Math.floor(Math.log10(hi)) / 2;
    hi = Math.ceil(hi / step) * step;
  }
  const X = x => padL + (x - x0) / (x1 - x0 || 1) * (w - padL - padR);
  const Y = y => padT + (1 - (y - lo) / (hi - lo)) * (h - padT - padB);
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  let svg = `<svg viewBox="0 0 ${w} ${h}" height="${h}" role="img">`;
  if (axis) {
    svg += `<g class="grid">${ticks.map(t => `<line x1="${padL}" x2="${w - padR}" y1="${Y(t)}" y2="${Y(t)}"/>`).join("")}</g>`;
    svg += `<g class="axis">${ticks.map(t => `<text x="${padL - 4}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t, true))}</text>`).join("")}
      <text x="${padL}" y="${h - 3}">${esc(xFmt(x0))}</text><text x="${w - padR}" y="${h - 3}" text-anchor="end">${esc(xFmt(x1))}</text></g>`;
  }
  const ends = [];
  for (const s of series) {
    if (!s.points.length) continue;
    svg += `<path class="line" style="stroke:${s.color}" d="${s.points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("")}"/>`;
    const last = s.points[s.points.length - 1];
    ends.push({ x: X(last[0]) + 6, y: Y(last[1]) + 4, text: yFmt(last[1]) });
  }
  if (labels) {  // end-of-line labels, pushed apart when two lines finish close together
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
    svg += ends.map(e => `<text class="label" x="${e.x}" y="${e.y}">${esc(e.text)}</text>`).join("");
  }
  svg += `<g class="hover" visibility="hidden"><line class="hair" y1="${padT}" y2="${h - padB}"/>`;
  svg += series.map((s, i) => `<circle class="dot" data-i="${i}" r="4" style="fill:${s.color}"/>`).join("") + "</g>";
  svg += `<rect x="0" y="0" width="${w}" height="${h}" fill="transparent"/></svg>`;
  el.innerHTML = svg;
  const hover = el.querySelector(".hover"), hair = el.querySelector(".hair"), dots = el.querySelectorAll(".dot");
  const move = evt => {
    const p = evt.touches ? evt.touches[0] : evt;
    const r = el.getBoundingClientRect();
    const xv = x0 + (p.clientX - r.left - padL) / (w - padL - padR) * (x1 - x0);
    const near = series.map(s => s.points.reduce((a, b) => Math.abs(b[0] - xv) < Math.abs(a[0] - xv) ? b : a, s.points[0]));
    const at = near[0][0];
    hover.setAttribute("visibility", "visible");
    hair.setAttribute("x1", X(at)); hair.setAttribute("x2", X(at));
    near.forEach((pt, i) => { dots[i].setAttribute("cx", X(pt[0])); dots[i].setAttribute("cy", Y(pt[1])); });
    showTip(evt, `<b>${esc(xFmt(at, true))}</b>${near.map((pt, i) => `<br>${series.length > 1 ? `${esc(series[i].name)}: ` : ""}${esc(yFmt(pt[1]))}`).join("")}`);
  };
  const leave = () => { hover.setAttribute("visibility", "hidden"); hideTip(); };
  el.onmousemove = move; el.ontouchmove = move; el.ontouchstart = move;
  el.onmouseleave = leave; el.ontouchend = leave;
}

// bars: [{label, value, tip}]
function barChart(el, bars, { height = 110, yFmt = v => v } = {}) {
  const w = el.clientWidth || 340, h = height, padL = 34, padB = 18, padT = 6;
  const max = Math.max(1, ...bars.map(b => b.value));
  const bw = (w - padL) / bars.length;
  const Y = v => padT + (1 - v / max) * (h - padT - padB);
  let svg = `<svg viewBox="0 0 ${w} ${h}" height="${h}" role="img">
    <g class="grid"><line x1="${padL}" x2="${w}" y1="${Y(0)}" y2="${Y(0)}"/><line x1="${padL}" x2="${w}" y1="${Y(max)}" y2="${Y(max)}"/></g>
    <g class="axis"><text x="${padL - 4}" y="${Y(max) + 4}" text-anchor="end">${esc(yFmt(max))}</text><text x="${padL - 4}" y="${Y(0) + 4}" text-anchor="end">0</text>
    <text x="${padL}" y="${h - 3}">${esc(bars[0]?.label || "")}</text><text x="${w}" y="${h - 3}" text-anchor="end">${esc(bars[bars.length - 1]?.label || "")}</text></g>`;
  bars.forEach((b, i) => {
    const bh = Math.max(0, Y(0) - Y(b.value)), x = padL + i * bw + 1, width = Math.max(1, bw - 2);
    const r = Math.min(4, width / 2, bh);
    svg += `<path class="bar" data-i="${i}" d="M${x},${Y(0)}V${Y(0) - bh + r}q0,-${r} ${r},-${r}h${width - 2 * r}q${r},0 ${r},${r}V${Y(0)}Z"/>`;
    svg += `<rect data-i="${i}" x="${padL + i * bw}" y="0" width="${bw}" height="${h}" fill="transparent"/>`;
  });
  el.innerHTML = svg + "</svg>";
  el.onmousemove = el.ontouchstart = evt => {
    const i = evt.target.dataset?.i;
    if (i === undefined) return hideTip();
    showTip(evt, bars[i].tip);
  };
  el.onmouseleave = el.ontouchend = hideTip;
}

// ------------------------------------------------------------ Home (the same page phone-access people open: /mobile)
// Shown in a frame so the two always match. It refreshes itself every minute; the frame grows to fit it.

function renderHome() {
  const v = $("#view-home");
  if (v.querySelector("iframe")) return;  // already showing (and refreshing itself)
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

// ------------------------------------------------------------ Calendar (the whole family, a month at a time)

async function renderCalendar() {
  const v = $("#view-calendar");
  const first = `${state.month}-01`;
  const gridStart = addDays(first, -parseISO(first).getDay());
  const monthEnd = toISO(new Date(parseISO(first).getFullYear(), parseISO(first).getMonth() + 1, 0));
  const gridEnd = addDays(monthEnd, 7 - parseISO(monthEnd).getDay());
  state.items = await api(`/api/agenda?start=${gridStart}&end=${gridEnd}`);
  const byDay = {};
  for (const it of state.items) (byDay[it.date] ||= []).push(it);
  const m = parseISO(first);
  let cells = "";
  for (let d = gridStart; d < gridEnd; d = addDays(d, 1)) {
    const colors = [...new Set((byDay[d] || []).filter(i => i.source !== "holiday" || i.kind === "holiday").map(i => itemColor(i, state.byId)))].slice(0, 6);
    cells += `<button class="cell ${d.slice(0, 7) !== state.month ? "out" : ""} ${d === today ? "today" : ""} ${d === state.day ? "sel" : ""}" data-cal-day="${d}">
      <span class="num">${parseISO(d).getDate()}</span>
      <span class="cal-dots">${colors.map(c => `<i style="background:${esc(c)}"></i>`).join("")}</span></button>`;
  }
  const list = byDay[state.day] || [];
  v.innerHTML = `
    <div class="month-nav">
      <button class="icon-btn" data-month="-1" aria-label="Previous month"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
      <h2>${MONTH_NAMES[m.getMonth()]} ${m.getFullYear()}</h2>
      <button class="icon-btn" data-month="1" aria-label="Next month"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <div class="month">${["S", "M", "T", "W", "T", "F", "S"].map(d => `<div class="wd">${d}</div>`).join("")}${cells}</div>
    <div class="legend" style="flex-wrap:wrap;margin-top:10px">${state.people.map(p => `<span><i style="background:${esc(p.color)};height:8px;width:8px;border-radius:50%"></i>${esc(p.name)}</span>`).join("")}</div>
    <h3 class="section-h">${esc(relDay(state.day, today))}${state.day !== today ? "" : ` · ${MONTH_NAMES[parseISO(today).getMonth()].slice(0, 3)} ${parseISO(today).getDate()}`}</h3>
    <div class="card list">${list.map(dayRow).join("") || `<div class="row"><div class="row-main"><div class="row-meta">Nothing on this day.</div></div></div>`}
      <button class="row add-row" id="cal-add">+ Add an appointment</button></div>`;
}

function dayRow(it) {
  const who = state.byId[it.person_id];
  let meta = it.all_day ? "All day" : fmtRange(it);
  if (it.source === "task") meta = `Due · ${CATEGORY_LABELS[it.category] || "Task"}`;
  if (it.source === "holiday") meta = it.kind === "holiday" ? "Holiday" : "";
  if (it.location) meta += ` · ${esc(it.location)}`;
  const title = it.source === "shift" && who ? `${nameOf(who)} – ${it.title}` : it.title;
  return `<div class="row" ${it.source === "appt" ? `data-appt="${it.id}"` : ""}>
    <span class="bar" style="background:${esc(itemColor(it, state.byId))}"></span>
    <div class="row-main"><div class="row-title">${esc(title)}</div>
      <div class="row-meta">${meta}${who && it.source !== "shift" && !it.who_in_title ? ` · ${esc(nameOf(who))}` : ""}</div></div>
  </div>`;
}

async function editAppt(id, date) {
  const list = await api(`/api/appointments?start=${date}&end=${addDays(date, 1)}`);
  const a = list.find(x => x.id === id);
  if (a) appointmentSheet({ appt: a, people: state.people, day: date, base: "/api/appointments", onSaved: render });
}

// ------------------------------------------------------------ Kids

async function renderKids() {
  const v = $("#view-kids");
  state.kids = await api("/api/me/kids");
  const [mail, rw, medsData, sick, money] = await Promise.all([Promise.all(state.kids.map(k => api(`/api/me/mail?kid=${k.kid.id}`))),
    api("/api/me/rewards"), api("/api/meds"), api("/api/meds/symptoms?days=3"), api("/api/me/money")]);
  state.rewards = rw;
  state.meds = medsData;
  state.money = Object.fromEntries(money.map(m => [m.kid.id, m]));
  v.innerHTML = state.kids.map((k, ki) => {
    const s = k.summary;
    const school = s.school
      ? `${s.rotation ? `Day ${s.rotation}` : "School"}${s.special ? ` · ${esc(s.special)}` : ""}${s.event ? ` · ${esc(s.event)}` : ""}`
      : esc(s.reason || "No school");
    const lunch = s.lunch ? `${LUNCH_SHORT[s.lunch.choice] || "Lunch not set"}${s.lunch.menu && s.lunch.choice === "buy" ? `: ${esc(s.lunch.menu)}` : ""}` : "";
    const coming = k.days.flatMap(d => d.items.filter(i => i.source === "appt" || i.source === "google").map(i => ({ ...i })));
    const todos = k.tasks.filter(t => !t.done);
    const bday = k.birthdays.find(b => b.mine);
    const p = state.byId[k.kid.id] || {};  // teacher details come from /api/people (adults only)
    const bedDone = k.bedtime.filter(c => c.done).length;
    return `<div class="card kid-card">
      <div class="kid-head"><span class="swatch" style="background:${esc(k.kid.color)}"></span><h3>${esc(nameOf(k.kid))}</h3>
        <button class="btn secondary small" data-kid-appt="${k.kid.id}">+ Appointment</button></div>
      <div class="kid-sec"><div class="sec-h">School ${esc(s.when)}</div>
        <div class="kid-line">${school}</div>${lunch ? `<div class="kid-line">${lunch}</div>` : ""}
        ${s.weather ? `<div class="kid-line">${weatherInfo(s.weather.code).icon} ${s.weather.hi}° / ${s.weather.lo}°${s.weather.hints.length ? ` · ${s.weather.hints.map(esc).join(" · ")}` : ""}</div>` : ""}
        ${p.teacher ? `<div class="kid-line">👩‍🏫 ${esc(p.teacher)}${p.teacher_email ? ` · <a href="mailto:${esc(p.teacher_email)}">${esc(p.teacher_email)}</a>` : ""}</div>` : ""}
        ${p.class_notes ? `<div class="kid-line muted small">${esc(p.class_notes).replace(/\n/g, "<br>")}</div>` : ""}</div>
      <div class="kid-sec kid-meds"><div class="sec-h">💊 Medicine &amp; sick</div>
        ${medsTools(k.kid.id)}
        ${(() => { const s = sick.find(x => x.person_id === k.kid.id); return s ? `<div class="kid-line">🌡️ ${esc(medDay(s.at))}: ${[s.temp != null ? `<b class="${s.temp >= 38 ? "danger" : ""}">${s.temp} °C</b>` : "", esc(s.kinds), esc(s.severity), esc(s.note)].filter(Boolean).join(" · ")}</div>` : ""; })()}
        ${medsHTML(medsData, k.kid.id)}
        <div class="mail-actions"><button class="btn secondary small" data-med-add="${k.kid.id}">+ Set up a medicine</button></div></div>
      ${k.homework.length ? `<div class="kid-sec"><div class="sec-h">📚 Homework &amp; reading tonight · ${k.homework.filter(c => c.done).length} of ${k.homework.length} done</div>
        ${k.homework.map(c => `<div class="kid-line">${c.done ? "✅" : "☐"} ${esc(c.title)}</div>`).join("")}</div>` : ""}
      <div class="kid-sec"><div class="sec-h">🎁 Rewards · ${k.balance} saved</div>
        ${k.rewards.map(r => `<div class="kid-line reward-line">
          <span>${esc(r.title)} <span class="muted">· ${r.cost}</span></span>
          <span class="reward-bar"><i style="width:${Math.min(100, k.balance / r.cost * 100).toFixed(0)}%"></i></span>
          <button class="btn secondary small" data-give="${r.id}" data-kid="${k.kid.id}" ${k.balance >= r.cost ? "" : "disabled"}>Give</button></div>`).join("")
          || `<div class="kid-line muted">No rewards yet. You choose them: every ticked job is one saved.</div>`}
        <div class="mail-actions"><button class="btn secondary small" data-add-reward="${k.kid.id}">+ Add a reward</button>
          ${k.rewards.length ? `<button class="btn secondary small" data-edit-rewards>Change rewards</button>` : ""}</div>
        ${(state.rewards.given || []).filter(g => g.person_id === k.kid.id).slice(0, 3).map(g =>
          `<div class="kid-line muted small">🎉 ${esc(g.title)} · ${esc(relDay(g.at.slice(0, 10), today))}</div>`).join("")}</div>
      ${moneyHTML(state.money[k.kid.id])}
      ${k.bedtime.length ? `<div class="kid-sec"><div class="sec-h">🌙 Bedtime tonight · ${bedDone} of ${k.bedtime.length} done</div>
        ${k.bedtime.map(c => `<div class="kid-line">${c.done ? "✅" : "☐"} ${c.at ? `<b>${fmtTime(c.at)}</b> · ` : ""}${esc(c.title)}</div>`).join("")}</div>` : ""}
      <div class="kid-sec"><div class="sec-h">Next 7 days</div>
        ${coming.map(i => `<div class="kid-line ${i.source === "appt" ? "tap" : ""}" ${i.source === "appt" ? `data-appt="${i.id}" data-date="${i.date}"` : ""}>
          <b>${esc(relDay(i.date, today))}</b> · ${esc(i.title)}${i.all_day ? "" : ` · ${fmtRange(i)}`}${i.person_id ? "" : ` <span class="muted">(family)</span>`}</div>`).join("")
          || `<div class="kid-line muted">No appointments.</div>`}</div>
      <div class="kid-sec"><div class="sec-h">To-dos</div>
        ${todos.map(t => `<div class="kid-line">☐ ${esc(t.title)}${t.due_date ? ` <span class="muted">· ${esc(relDay(t.due_date, today))}</span>` : ""}</div>`).join("")
          || `<div class="kid-line muted">All done.</div>`}</div>
      <div class="kid-sec"><div class="sec-h">📧 Teacher emails</div>
        ${mail[ki].slice(0, 5).map(m => `<div class="kid-line tap" data-mail="${m.id}">
          ${m.applied ? "✅" : "🆕"} <b>${esc(m.subject || "(no subject)")}</b>
          <span class="muted">· ${esc(m.sender || "pasted")}${m.sent || m.created ? ` · ${esc(relDay((m.sent || m.created).slice(0, 10), today))}` : ""}</span></div>`).join("")
          || `<div class="kid-line muted">None yet. Upload one and the planner picks out the dates.</div>`}
        <div class="mail-actions">
          <button class="btn secondary small" data-mail-upload="${k.kid.id}">⬆️ Upload an email</button>
          <button class="btn secondary small" data-mail-paste="${k.kid.id}">📋 Paste the text</button>
        </div></div>
      <div class="kid-sec small muted">
        ${bday ? `🎂 Turns ${bday.age} in ${bday.days} day${bday.days === 1 ? "" : "s"}` : ""}
        ${k.next_day_off ? `${bday ? " · " : ""}Next day off: ${esc(k.next_day_off.name)} (${esc(relDay(k.next_day_off.date, today))})` : ""}
        · ⭐ ${k.stars} chore star${k.stars === 1 ? "" : "s"} this week</div>
    </div>`;
  }).join("") || `<div class="empty">No kids set up.</div>`;
}

// ------------------------------------------------------------ medicine: everyone's, in one place

async function renderMeds() {
  const [data, log] = await Promise.all([api("/api/meds"), api("/api/meds/log?days=7")]);
  state.meds = data;
  const people = data.people.filter(p => p.is_kid || data.meds.some(m => m.person_id === p.id));
  $("#view-meds").innerHTML = people.map(p => `
    <div class="card kid-card">
      <div class="kid-head"><span class="swatch" style="background:${esc(p.color || "#8a8f98")}"></span><h3>${esc(nameOf(p))}</h3>
        <button class="btn secondary small" data-med-add="${p.id}">+ Medicine</button></div>
      <div class="kid-sec kid-meds">${medsHTML(data, p.id) || `<div class="kid-line muted">No medicine set up.</div>`}${medsTools(p.id)}</div>
    </div>`).join("") + `
    <h3 class="section-h">Last 7 days</h3>
    <div class="card list">${log.slice(0, 20).map(l => `<div class="rank">
      <span>${esc(l.person)} · ${esc(l.med)}${l.dose ? ` · ${esc(l.dose)}` : ""}${l.note ? ` <span class="muted">· ${esc(l.note)}</span>` : ""}</span>
      <span class="rnum">${esc(medDay(l.at))}${l.by_name ? ` · ${esc(l.by_name)}` : ""}</span></div>`).join("")
      || `<div class="rank muted">Nothing given in the last week.</div>`}</div>
    <p class="hint center"><a href="/admin">Admin → Medicine</a> has the full history and every setting.</p>`;
}

// ------------------------------------------------------------ money: allowance, stars cashed in, spending

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dollars = c => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;

function moneyHTML(m) {
  if (!m) return "";
  const st = m.settings, id = m.kid.id;
  const plan = [st.weekly ? `${dollars(st.weekly)} every ${WEEKDAYS[st.payday]}${st.need_stars ? ` if they get ${st.need_stars} stars (${m.week_stars} so far)` : ""}` : "No weekly allowance",
    st.star_cents ? `a star is ${dollars(st.star_cents)}` : ""].filter(Boolean).join(" · ");
  return `<div class="kid-sec"><div class="sec-h">💰 Money · ${dollars(m.balance)}</div>
    <div class="kid-line muted small">${esc(plan)}</div>
    ${m.log.slice(0, 3).map(l => `<div class="kid-line small">${l.cents > 0 ? "➕" : l.cents < 0 ? "➖" : "•"} ${esc(l.note || l.kind)}${l.cents ? ` · <b>${dollars(l.cents)}</b>` : ""} <span class="muted">· ${esc(relDay(l.at.slice(0, 10), today))}</span></div>`).join("")}
    <div class="mail-actions">
      <button class="btn secondary small" data-money="${id}" data-kind="gift">+ Add</button>
      <button class="btn secondary small" data-money="${id}" data-kind="spent">− Spent</button>
      ${st.star_cents ? `<button class="btn secondary small" data-cash-in="${id}" ${m.stars ? "" : "disabled"}>⭐ Cash in stars</button>` : ""}
      <button class="btn secondary small" data-allowance="${id}">⚙️ Allowance</button>
      ${m.log.length ? `<button class="btn secondary small" data-money-log="${id}">History</button>` : ""}
    </div></div>`;
}

function moneyForm(kidId, kind) {
  const kid = state.byId[kidId];
  const spent = kind === "spent";
  openSheet(`
    <h2>${spent ? `➖ ${esc(kid.name)} spent` : `➕ Money for ${esc(kid.name)}`}</h2>
    <form id="money-form">
      <div class="two">
        <label>Amount<input name="amount" type="number" min="0.01" max="1000" step="0.01" inputmode="decimal" required placeholder="$"></label>
        ${spent ? "<span></span>" : `<label>What<select name="kind"><option value="gift">🎁 A gift</option><option value="allowance">📅 Allowance</option><option value="other">Other</option></select></label>`}
      </div>
      <label>Note<input name="note" maxlength="80" autocomplete="off" placeholder="${spent ? "Pokémon cards" : "Birthday money from Nan"}"></label>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="m-cancel">Cancel</button><button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelector("#m-cancel").addEventListener("click", closeSheet);
    body.querySelector("#money-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        await api(`/api/me/money/${kidId}`, { method: "POST", body: { amount: Number(f.amount.value), kind: spent ? "spent" : f.kind.value,
          note: f.note.value || (spent ? "Spent" : ""), by_person: state.owner?.id || null } });
        closeSheet(); toast("Saved"); renderKids();
      });
    });
  });
}

function cashInForm(kidId) {
  const m = state.money[kidId], kid = state.byId[kidId], each = m.settings.star_cents;
  openSheet(`
    <h2>⭐ Cash in ${esc(kid.name)}'s stars</h2>
    <form id="cash-form">
      <label>Stars (${m.stars} saved)<input name="stars" type="number" min="1" max="${m.stars}" value="${m.stars}" required></label>
      <p class="hint" id="cash-hint">= ${dollars(m.stars * each)} at ${dollars(each)} a star. They come off the stars saved for rewards.</p>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="c-cancel">Cancel</button><button class="btn">Cash in</button></div>
    </form>`, body => {
    body.querySelector("#c-cancel").addEventListener("click", closeSheet);
    const f = body.querySelector("#cash-form");
    f.stars.addEventListener("input", () => { body.querySelector("#cash-hint").textContent = `= ${dollars((Number(f.stars.value) || 0) * each)} at ${dollars(each)} a star. They come off the stars saved for rewards.`; });
    f.addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        await api(`/api/me/money/${kidId}/cash-in`, { method: "POST", body: { stars: Number(f.stars.value), by_person: state.owner?.id || null } });
        closeSheet(); toast("💰 Cashed in"); renderKids();
      });
    });
  });
}

function allowanceForm(kidId) {
  const st = state.money[kidId].settings, kid = state.byId[kidId];
  openSheet(`
    <h2>⚙️ ${esc(kid.name)}'s allowance</h2>
    <form id="allow-form">
      <div class="two">
        <label>Every week<input name="weekly" type="number" min="0" max="200" step="0.25" inputmode="decimal" value="${(st.weekly / 100).toFixed(2)}"></label>
        <label>On<select name="payday">${WEEKDAYS.map((d, i) => `<option value="${i}" ${st.payday === i ? "selected" : ""}>${d}</option>`).join("")}</select></label>
      </div>
      <label>Only if they get this many stars that week (0 = always)<input name="need" type="number" min="0" max="500" value="${st.need_stars}"></label>
      <label>A saved star is worth (cents, 0 = can't cash in)<input name="star" type="number" min="0" max="500" value="${st.star_cents}"></label>
      <p class="hint">The allowance goes in at 8 am on the day, and ${esc(kid.name)}'s phone gets a note if reminders are on. $0 turns it off.</p>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="a-cancel">Cancel</button><button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelector("#a-cancel").addEventListener("click", closeSheet);
    body.querySelector("#allow-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        await api(`/api/me/money/${kidId}/settings`, { method: "PUT", body: { weekly: Number(f.weekly.value || 0), payday: Number(f.payday.value),
          need_stars: Number(f.need.value || 0), star_cents: Number(f.star.value || 0) } });
        closeSheet(); toast("Saved"); renderKids();
      });
    });
  });
}

function moneyLog(kidId) {
  const m = state.money[kidId];
  openSheet(`
    <h2>💰 ${esc(state.byId[kidId].name)} · ${dollars(m.balance)}</h2>
    <div class="card list">${m.log.map(l => `<div class="row"><div class="row-main">
      <div class="row-title">${esc(l.note || l.kind)}${l.cents ? ` · ${dollars(l.cents)}` : ""}</div>
      <div class="row-meta">${esc(l.at.replace("T", " "))}${l.by_name ? ` · ${esc(l.by_name)}` : ""}</div></div>
      <button class="icon-btn small" data-undo-money="${l.id}" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("")}</div>
    <p class="hint">✕ undoes an entry (cashed-in stars go back).</p>
    <div class="sheet-actions"><button type="button" class="btn secondary" id="ml-close">Done</button></div>`, body => {
    body.querySelector("#ml-close").addEventListener("click", () => { closeSheet(); renderKids(); });
    body.querySelectorAll("[data-undo-money]").forEach(b => b.addEventListener("click", () => run(async () => {
      await api(`/api/me/money/entry/${b.dataset.undoMoney}`, { method: "DELETE" });
      b.closest(".row").remove();
    })));
  });
}

// ------------------------------------------------------------ rewards (the adults choose them)

function rewardForm(kidId) {
  const kid = state.byId[kidId];
  openSheet(`
    <h2>🎁 New reward</h2>
    <form id="reward-form">
      <label>Reward<input name="title" required maxlength="80" autocomplete="off" placeholder="🎬 Pick Friday's movie"></label>
      <div class="two">
        <label>Costs<input name="cost" type="number" min="1" max="1000" required value="20"></label>
        <label>For<select name="who"><option value="${kidId}">${esc(kid.name)} only</option><option value="">Any kid</option></select></label>
      </div>
      <p class="hint">Every job, bedtime step and bit of homework they tick saves one. Giving a reward takes its cost off.</p>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="r-cancel">Cancel</button><button class="btn">Add</button></div>
    </form>`, body => {
    body.querySelector("#r-cancel").addEventListener("click", closeSheet);
    body.querySelector("#reward-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      run(async () => {
        await api("/api/me/rewards", { method: "POST", body: { title: f.title.value, cost: Number(f.cost.value), person_id: f.who.value ? Number(f.who.value) : null } });
        closeSheet(); toast("Reward added"); renderKids();
      });
    });
  });
}

function rewardsList() {
  const list = state.rewards.rewards;
  openSheet(`
    <h2>🎁 Rewards</h2>
    <div class="card list">${list.map(r => `<div class="row"><div class="row-main"><div class="row-title">${esc(r.title)}</div>
      <div class="row-meta">${r.cost} · ${r.person_id ? esc(state.byId[r.person_id]?.name || "") : "Any kid"}</div></div>
      <button class="icon-btn small" data-del-reward="${r.id}" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`).join("")}</div>
    <div class="sheet-actions"><button type="button" class="btn secondary" id="rl-close">Done</button></div>`, body => {
    body.querySelector("#rl-close").addEventListener("click", () => { closeSheet(); renderKids(); });
    body.querySelectorAll("[data-del-reward]").forEach(b => b.addEventListener("click", () => run(async () => {
      await api(`/api/me/rewards/${b.dataset.delReward}`, { method: "DELETE" });
      b.closest(".row").remove();
    })));
  });
}

// ------------------------------------------------------------ teachers' emails
// Upload (.msg/.eml/PDF/photo) or paste, then review what the planner found and tick what to add.

function uploadMail(kidId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".msg,.eml,.pdf,.txt,image/*";
  input.addEventListener("change", () => run(async () => {
    const file = input.files[0];
    if (!file) return;
    toast("Reading it…");
    const res = await fetch(`/api/me/mail?kid=${kidId}&name=${encodeURIComponent(file.name)}`, {
      method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    reviewMail(await res.json());
    renderKids();
  }));
  input.click();
}

function pasteMail(kidId) {
  const kid = state.byId[kidId];
  openSheet(`
    <h2>Paste ${esc(kid?.name || "")}'s teacher email</h2>
    <form id="paste-form">
      <label>Subject (optional)<input name="subject" autocomplete="off" placeholder="October reminders"></label>
      <label>The email<textarea name="text" rows="10" required placeholder="Paste the whole email here. On an iPhone: open it in Mail, press and hold the text → Select All → Copy."></textarea></label>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="p-cancel">Cancel</button><button class="btn">Read it</button></div>
    </form>`, body => {
    body.querySelector("#p-cancel").addEventListener("click", closeSheet);
    body.querySelector("#paste-form").addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        const d = await api("/api/me/mail/text", { method: "POST", body: { kid: kidId, text: e.target.text.value, subject: e.target.subject.value } });
        reviewMail(d);
        renderKids();
      });
    });
  });
}

const MAIL_GROUPS = [
  ["teacher", "👩‍🏫 Teacher"], ["closed", "🎉 No school"], ["event", "📅 Special days"], ["task", "📝 To-dos"],
  ["day", "🔢 Day numbers"], ["specials", "👟 Gym, music and library days"],
];

function reviewMail(d) {
  const items = d.items.map(it => ({ ...it }));
  const days = items.filter(i => i.kind === "day");
  const dayRange = days.length ? `${relDay(days[0].date, today)} – ${relDay(days[days.length - 1].date, today)}` : "";
  const row = (it, i) => {
    const tag = it.already ? ` <span class="badge grey">already in</span>`
      : it.ocr ? ` <span class="badge grey" title="Read from a photo or scan: check the date">📷 check</span>` : "";
    if (it.kind === "teacher") return `<label class="mail-item"><input type="checkbox" data-i="${i}" ${it.checked ? "checked" : ""}>
      <input class="mi-title" data-t="${i}" value="${esc(it.title)}"><span class="muted small">${esc(it.email || "")}</span>${tag}</label>`;
    if (it.kind === "specials") return `<label class="mail-item"><input type="checkbox" data-i="${i}" ${it.checked ? "checked" : ""}>
      <span>${Object.entries(it.specials).map(([n, s]) => `Day ${n} ${esc(s)}`).join(" · ")}</span>${tag}</label>`;
    return `<label class="mail-item"><input type="checkbox" data-i="${i}" ${it.checked ? "checked" : ""}>
      <input type="date" class="mi-date" data-d="${i}" value="${esc(it.date || "")}">
      <input class="mi-title" data-t="${i}" value="${esc(it.title)}">${tag}</label>`;
  };
  const groups = MAIL_GROUPS.map(([kind, label]) => {
    const list = items.map((it, i) => [it, i]).filter(([it]) => it.kind === kind)
      .sort(([a], [b]) => (a.date || "").localeCompare(b.date || ""));
    if (!list.length) return "";
    if (kind === "day") {
      const on = list.some(([it]) => it.checked);
      const fresh = list.filter(([it]) => !it.already).length;
      return `<h3 class="section-h">${label}</h3>
        <label class="mail-item"><input type="checkbox" data-days ${on ? "checked" : ""}>
          <span>${list.length} school days, ${esc(dayRange)}${fresh ? ` · ${fresh} new` : ` <span class="badge grey">already in</span>`}</span></label>
        <p class="hint">${list.map(([it]) => `${parseISO(it.date).getDate()}: Day ${it.day_number}`).join(" · ")}</p>`;
    }
    return `<h3 class="section-h">${label}</h3>${list.map(([it, i]) => row(it, i)).join("")}`;
  }).join("");
  openSheet(`
    <h2>📧 ${esc(d.subject || "Teacher email")}</h2>
    <p class="hint">${d.sender ? `From ${esc(d.sender)}${d.sender_email ? ` (${esc(d.sender_email)})` : ""} · ` : ""}for ${esc(d.kid)}${d.sent ? ` · ${esc(relDay(d.sent.slice(0, 10), today))}` : ""}${d.applied ? ` · <b>added ${esc(d.applied.slice(0, 10))}</b>` : ""}</p>
    ${d.files.length ? `<div class="mail-files">${d.files.map(f => f.photo
      ? `<a href="/api/me/mail/${d.id}/files/${f.n}" target="_blank"><img src="/api/me/mail/${d.id}/files/${f.n}" alt="${esc(f.name)}"></a>`
      : `<a class="btn secondary small" href="/api/me/mail/${d.id}/files/${f.n}" target="_blank">📄 ${esc(f.name)}</a>`).join("")}</div>` : ""}
    ${d.files.some(f => f.photo) ? `<p class="hint">${d.ocr_ready
      ? "Dates from photos and scans are read by OCR (marked 📷): tap the photo to check them. A PDF you've OCR'd in Foxit reads best."
      : "Photos can't be read here. Tap one to read it, then add its dates below."}</p>` : ""}
    ${d.body.trim() ? `<details class="mail-body"><summary>Email text</summary><pre>${esc(d.body.trim())}</pre></details>` : ""}
    <form id="mail-form">
      ${groups || `<p class="hint">Nothing with a date was found. Add anything by hand below.</p>`}
      <h3 class="section-h">➕ Add one by hand</h3>
      <div class="mail-item manual">
        <select name="kind"><option value="event">Special day</option><option value="closed">No school</option><option value="task">To-do</option></select>
        <input type="date" name="date"><input name="title" placeholder="Wear orange" autocomplete="off">
      </div>
      <div class="sheet-actions">
        <button type="button" class="btn danger" id="m-del">Delete email</button>
        <button type="button" class="btn secondary" id="m-close">Close</button>
        <button class="btn" type="submit">Add ticked</button>
      </div>
    </form>`, body => {
    body.querySelector("#m-close").addEventListener("click", closeSheet);
    body.querySelector("#m-del").addEventListener("click", () => run(async () => {
      if (!confirm("Delete this email and its files? Anything already added stays in the planner.")) return;
      await api(`/api/me/mail/${d.id}`, { method: "DELETE" });
      closeSheet(); toast("Deleted"); renderKids();
    }));
    body.querySelector("#mail-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      const daysOn = body.querySelector("[data-days]")?.checked;
      const chosen = items.map((it, i) => {
        if (it.kind === "day") return daysOn && !it.already ? it : null;
        if (!body.querySelector(`[data-i="${i}"]`)?.checked) return null;
        const t = body.querySelector(`[data-t="${i}"]`), dt = body.querySelector(`[data-d="${i}"]`);
        return { ...it, title: t ? t.value : it.title, date: dt ? dt.value || null : it.date };
      }).filter(Boolean);
      if (f.title.value.trim()) chosen.push({ kind: f.kind.value, date: f.date.value || null, title: f.title.value });
      if (chosen.some(c => ["closed", "event"].includes(c.kind) && !c.date)) return toast("Give each special day a date", true);
      if (!chosen.length) return toast("Nothing is ticked", true);
      run(async () => {
        const r = await api(`/api/me/mail/${d.id}/apply`, { method: "POST", body: { items: chosen } });
        const n = Object.values(r.added).reduce((a, b) => a + b, 0);
        closeSheet();
        toast(`Added ${n} thing${n === 1 ? "" : "s"} to the planner`);
        state.people = await api("/api/people");
        state.byId = personMap(state.people);
        renderKids();
      });
    });
  });
}

// ------------------------------------------------------------ Homelab

function setupNote(what) {
  return `<div class="card setup-note">${esc(what)} isn't connected yet.<br><button class="btn" data-setup>Set up the homelab</button></div>`;
}

async function renderLab() {
  document.querySelectorAll("[data-lab]").forEach(b => b.classList.toggle("on", b.dataset.lab === state.lab));
  const body = $("#lab-body");
  await ({ pve: labProxmox, dns: labAdguard, speed: labSpeed, net: labNetwork })[state.lab](body);
  if (!body.querySelector("[data-setup]")) body.insertAdjacentHTML("beforeend", `<p class="hint center"><button class="linkish" data-setup>Homelab addresses and logins</button></p>`);
}

async function labProxmox(body) {
  const p = await api("/api/me/proxmox");
  if (!p.configured) return (body.innerHTML = setupNote("Proxmox"));
  if (p.error) return (body.innerHTML = `<div class="card setup-note">Proxmox: ${esc(p.error)}.<br><button class="btn" data-setup>Check the settings</button></div>`);
  let html = "";
  for (const n of p.nodes) {
    const cpuNow = n.cpu || 0;
    html += `<div class="card pad">
      <div class="card-title"><h3>🖥️ ${esc(n.name)} <span class="badge ${n.online ? "" : "grey"}">${n.online ? "online" : "offline"}</span></h3>
        <span class="meta">up ${uptime(n.uptime)}</span></div>
      <div class="tiles">
        <div class="tile"><div class="v">${(cpuNow * 100).toFixed(0)}<small>%</small></div><div class="k">CPU · ${n.cpus} cores</div></div>
        <div class="tile"><div class="v">${n.mem_total ? (n.mem / n.mem_total * 100).toFixed(0) : 0}<small>%</small></div><div class="k">Memory</div></div>
        <div class="tile"><div class="v">${n.load?.[0] ?? "–"}</div><div class="k">Load (1 min)</div></div>
      </div>
      ${meter("Memory", n.mem, n.mem_total)}
      ${n.root?.total ? meter("Root disk", n.root.used, n.root.total) : ""}
      ${n.swap?.total ? meter("Swap", n.swap.used, n.swap.total) : ""}
      ${n.history?.length ? `<h4 class="sec-mini">CPU, last 24 hours</h4><div class="chart" data-pve-cpu="${esc(n.name)}"></div>
        <h4 class="sec-mini">Network traffic, last 24 hours</h4>
        <div class="legend"><span><i style="background:var(--series-1)"></i>In</span><span><i style="background:var(--series-2)"></i>Out</span><span>Mb/s</span></div>
        <div class="chart" data-pve-net="${esc(n.name)}"></div>` : ""}
      <p class="hint">${esc(n.version)}${n.cpu_model ? ` · ${esc(n.cpu_model)}` : ""}</p>
    </div>`;
  }
  if (p.storage.length) html += `<h3 class="section-h">Storage</h3><div class="card pad">${p.storage.map(s =>
    meter(`${s.name}${p.nodes.length > 1 ? ` (${s.node})` : ""}`, s.used, s.total)).join("")}</div>`;
  const running = p.guests.filter(g => g.status === "running").length;
  html += `<h3 class="section-h">Containers &amp; VMs · ${running} of ${p.guests.length} running</h3>
    <div class="card list">${p.guests.map(g => `
      <div class="guest">
        <span class="status-dot ${g.status === "running" ? "on" : ""}" title="${esc(g.status)}"></span>
        <span class="gname">${esc(g.id)} · ${esc(g.name)} <span class="muted small">${g.type === "lxc" ? "LXC" : "VM"}</span></span>
        <span class="gnum mono">${g.ips?.length ? g.ips.map(a => esc(a.ip)).join("<br>") : g.status === "running" ? "no IP" : esc(g.status)}</span>
        <span class="gmeta">${g.ips?.length ? `${esc([...new Set(g.ips.map(a => a.how))].join(", "))} · ` : ""}${g.status === "running"
          ? `${(g.cpu * 100).toFixed(0)}% CPU · RAM ${bytes(g.mem)} of ${bytes(g.mem_total)} · up ${uptime(g.uptime)} · ` : `${esc(g.status)} · `}disk ${bytes(g.disk_total)}</span>
      </div>`).join("")}</div>`;
  body.innerHTML = html;
  for (const n of p.nodes) {
    if (!n.history?.length) continue;
    const pts = key => n.history.filter(h => h[key] != null).map(h => [h.t * 1000, h[key]]);
    lineChart(body.querySelector(`[data-pve-cpu="${CSS.escape(n.name)}"]`), {
      series: [{ name: "CPU", color: "var(--series-1)", points: pts("cpu") }], yFmt: v => pct(v), xFmt: hourFmt, height: 110 });
    lineChart(body.querySelector(`[data-pve-net="${CSS.escape(n.name)}"]`), {
      series: [{ name: "In", color: "var(--series-1)", points: pts("netin") }, { name: "Out", color: "var(--series-2)", points: pts("netout") }],
      yFmt: (v, axis) => axis ? rate(v).replace(" Mb/s", "") : rate(v), xFmt: hourFmt, height: 130 });
  }
}

async function labAdguard(body) {
  const a = await api("/api/me/adguard");
  if (!a.configured) return (body.innerHTML = setupNote("AdGuard"));
  if (a.error) return (body.innerHTML = `<div class="card setup-note">AdGuard: ${esc(a.error)}.<br><button class="btn" data-setup>Check the settings</button></div>`);
  const unit = a.hours ? "hour" : "day";
  const n = a.per_unit.length;
  body.innerHTML = `
    <div class="card pad">
      <div class="card-title"><h3>🛡️ AdGuard Home</h3><span class="meta">${esc(a.version)}</span></div>
      <label class="switch"><input type="checkbox" id="protect" ${a.protection ? "checked" : ""}> Ad blocking is ${a.protection ? "<b>on</b>" : "<b>off</b>"}</label>
    </div>
    <div class="tiles">
      <div class="tile"><div class="v">${a.queries.toLocaleString()}</div><div class="k">DNS lookups (${a.hours ? "24 h" : `${n} days`})</div></div>
      <div class="tile"><div class="v">${a.blocked_pct.toFixed(1)}<small>%</small></div><div class="k">${a.blocked.toLocaleString()} blocked</div></div>
      <div class="tile"><div class="v">${a.avg_ms}<small>ms</small></div><div class="k">Average answer</div></div>
    </div>
    <div class="card pad"><div class="card-title"><h3>Lookups per ${unit}</h3></div><div class="chart" id="dns-bars"></div></div>
    <h3 class="section-h">Busiest devices</h3>
    <div class="card list">${a.top_clients.map(c => `<div class="rank"><span class="rname">${esc(a.names[c.name] || c.name)}${a.names[c.name] ? ` <span class="muted small">${esc(c.name)}</span>` : ""}</span><span class="rnum">${c.count.toLocaleString()}</span></div>`).join("")}</div>
    <h3 class="section-h">Most blocked</h3>
    <div class="card list">${a.top_blocked.map(c => `<div class="rank"><span class="rname mono small">${esc(c.name)}</span><span class="rnum">${c.count.toLocaleString()}</span></div>`).join("") || `<div class="rank muted">Nothing blocked yet.</div>`}</div>
    <h3 class="section-h">Most looked up</h3>
    <div class="card list">${a.top_domains.map(c => `<div class="rank"><span class="rname mono small">${esc(c.name)}</span><span class="rnum">${c.count.toLocaleString()}</span></div>`).join("")}</div>`;
  const label = i => a.hours ? (i === n - 1 ? "now" : `${n - 1 - i} h ago`) : (i === n - 1 ? "today" : `${n - 1 - i} d ago`);
  barChart(body.querySelector("#dns-bars"), a.per_unit.map((v, i) => ({
    label: label(i), value: v, tip: `<b>${label(i)}</b><br>${v.toLocaleString()} lookups<br>${(a.blocked_per_unit[i] || 0).toLocaleString()} blocked` })),
    { yFmt: v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v) });
  body.querySelector("#protect").addEventListener("change", e => run(async () => {
    await api("/api/me/adguard/protection", { method: "POST", body: { enabled: e.target.checked } });
    toast(e.target.checked ? "Ad blocking on" : "Ad blocking off"); renderLab();
  }));
}

async function labSpeed(body) {
  const s = await api("/api/me/speedtest");
  const ok = s.tests.filter(t => !t.error);
  const last = ok[ok.length - 1];
  const lastAny = s.tests[s.tests.length - 1];
  body.innerHTML = `
    ${last ? `<div class="tiles">
      <div class="tile"><div class="v">${last.down_mbps.toFixed(0)}<small>Mb/s</small></div><div class="k">⬇ Download</div></div>
      <div class="tile"><div class="v">${last.up_mbps.toFixed(0)}<small>Mb/s</small></div><div class="k">⬆ Upload</div></div>
      <div class="tile"><div class="v">${last.ping_ms}<small>ms</small></div><div class="k">Ping · jitter ${last.jitter_ms} ms</div></div>
    </div>
    <p class="hint center">${esc(last.isp)} · ${esc(last.server)} · ${ago(last.at)}</p>` : ""}
    ${lastAny?.error ? `<p class="hint center danger">Last test failed: ${esc(lastAny.error.slice(0, 120))}</p>` : ""}
    <button class="btn big-btn" id="speed-now" ${s.running || !s.helper ? "disabled" : ""}>${s.running ? "Testing… (about 30 seconds)" : "Run a speed test now"}</button>
    ${ok.length > 1 ? `<div class="card pad"><div class="card-title"><h3>Last 7 days</h3><span class="meta">every hour</span></div>
      <div class="legend"><span><i style="background:var(--series-1)"></i>Download</span><span><i style="background:var(--series-2)"></i>Upload</span><span>Mb/s</span></div>
      <div class="chart" id="speed-chart"></div></div>` : ""}
    ${!s.helper ? `<div class="card setup-note">The netmon helper isn't running on the server.</div>` : !s.tests.length ? `<div class="card setup-note">The first test runs within the hour.</div>` : ""}
    ${ok.length ? `<h3 class="section-h">Recent tests</h3><div class="card list">${ok.slice(-8).reverse().map(t => `
      <div class="rank"><span>${esc(relDay(toISO(new Date(t.at)), today))} ${clock(new Date(t.at))}</span>
        <span class="rnum">⬇ ${t.down_mbps.toFixed(0)} · ⬆ ${t.up_mbps.toFixed(0)} Mb/s · ${t.ping_ms} ms</span></div>`).join("")}</div>` : ""}`;
  if (ok.length > 1) lineChart(body.querySelector("#speed-chart"), {
    series: [{ name: "Download", color: "var(--series-1)", points: ok.map(t => [Date.parse(t.at), t.down_mbps]) },
             { name: "Upload", color: "var(--series-2)", points: ok.map(t => [Date.parse(t.at), t.up_mbps]) }],
    yFmt: (v, axis) => axis ? v.toFixed(0) : `${v.toFixed(0)} Mb/s`, height: 160,
    xFmt: (t, long) => { const d = new Date(t); return long ? `${relDay(toISO(d), today)} ${clock(d)}` : `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`; } });
  body.querySelector("#speed-now").addEventListener("click", () => run(async () => {
    await api("/api/me/speedtest", { method: "POST" });
    toast("Speed test started");
    labSpeed(body);
    const started = Date.now();
    const poll = setInterval(async () => {
      const again = await api("/api/me/speedtest").catch(() => null);
      if (state.view !== "lab" || state.lab !== "speed" || Date.now() - started > 150000) return clearInterval(poll);
      if (again && !again.running) { clearInterval(poll); labSpeed(body); }
    }, 5000);
  }));
}

async function labNetwork(body) {
  const [d, a, p] = await Promise.all([api("/api/me/devices"), api("/api/me/adguard"), api("/api/me/proxmox")]);
  const online = d.devices.filter(x => x.online);
  const isNew = x => x.first_seen && Date.now() - new Date(x.first_seen) < 86400000 && d.devices.some(o => o.first_seen < x.first_seen);
  const usage = a.configured && !a.error ? a.top_clients.slice(0, 8) : [];
  const node = p.nodes?.find(n => n.history?.length);
  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><div class="v">${online.length}</div><div class="k">Online now</div></div>
      <div class="tile"><div class="v">${d.devices.length}</div><div class="k">Seen on the network</div></div>
      <div class="tile"><div class="v">${d.devices.filter(isNew).length}</div><div class="k">New today</div></div>
    </div>
    <p class="hint center">${d.helper ? `Scanned ${ago(d.last_scan)} · every 5 minutes` : "The netmon helper isn't running on the server."}</p>
    ${node ? `<div class="card pad"><div class="card-title"><h3>Homelab traffic</h3><span class="meta">${esc(node.name)}, last 24 hours</span></div>
      <div class="legend"><span><i style="background:var(--series-1)"></i>In</span><span><i style="background:var(--series-2)"></i>Out</span><span>Mb/s</span></div>
      <div class="chart" id="net-traffic"></div></div>` : ""}
    ${usage.length ? `<h3 class="section-h">Busiest devices (DNS lookups, 24 h)</h3>
      <div class="card pad">${usage.map(c => meter(a.names[c.name] || nameForIp(d, c.name) || c.name, c.count, usage[0].count, c.count.toLocaleString(), false)).join("")}</div>` : ""}
    <h3 class="section-h">Devices · tap one to name it</h3>
    <div class="card list">${d.devices.map(x => `
      <div class="guest" data-device="${esc(x.mac)}">
        <span class="status-dot ${x.online ? "on" : ""}" title="${x.online ? "online" : "offline"}"></span>
        <span class="gname">${esc(x.name || x.vendor || x.guess || "Unknown device")}${isNew(x) ? `<span class="badge">new</span>` : ""}</span>
        <span class="gnum mono">${esc(x.ip)}</span>
        <span class="gmeta">${x.online ? "online" : `last seen ${ago(x.last_seen)}`} · <span class="mono">${esc(x.mac)}</span>${x.name && x.vendor ? ` · ${esc(x.vendor)}` : ""}</span>
      </div>`).join("") || `<div class="rank muted">No scans yet.</div>`}</div>`;
  if (node) {
    const pts = key => node.history.filter(h => h[key] != null).map(h => [h.t * 1000, h[key]]);
    lineChart(body.querySelector("#net-traffic"), {
      series: [{ name: "In", color: "var(--series-1)", points: pts("netin") }, { name: "Out", color: "var(--series-2)", points: pts("netout") }],
      yFmt: (v, axis) => axis ? rate(v).replace(" Mb/s", "") : rate(v), height: 130, xFmt: hourFmt });
  }
  body.querySelectorAll("[data-device]").forEach(r => r.addEventListener("click", () => deviceForm(d.devices.find(x => x.mac === r.dataset.device))));
}

function nameForIp(d, ip) {
  const x = d.devices.find(x => x.ip === ip);
  return x ? x.name || x.vendor || x.guess : "";
}

function deviceForm(x) {
  openSheet(`
    <h2>Name this device</h2>
    <p class="hint mono">${esc(x.ip)} · ${esc(x.mac)}${x.vendor ? `<br>${esc(x.vendor)}` : ""}<br>First seen ${ago(x.first_seen)}</p>
    <form id="dev-form">
      <label>Name<input name="name" autocomplete="off" value="${esc(x.named_here ? x.name : "")}" placeholder="${esc(x.name || "Emma's phone")}"></label>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="d-cancel">Cancel</button><button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelector("#d-cancel").addEventListener("click", closeSheet);
    body.querySelector("#dev-form").addEventListener("submit", e => {
      e.preventDefault();
      run(async () => {
        await api(`/api/me/devices/${encodeURIComponent(x.mac)}`, { method: "PUT", body: { name: e.target.name.value } });
        closeSheet(); toast("Saved"); renderLab();
      });
    });
  });
}

async function setupForm() {
  const s = await api("/api/me/setup");
  openSheet(`
    <h2>Homelab setup</h2>
    <form id="setup-form">
      <h3 class="section-h">Proxmox</h3>
      <label>Address<input name="pve_host" value="${esc(s.pve_host)}" autocomplete="off"></label>
      <label>API token ID<input name="pve_token_id" value="${esc(s.pve_token_id)}" placeholder="planner@pve!planner" autocomplete="off"></label>
      <label>Token secret${s.pve_token_secret_set ? " (saved · leave blank to keep)" : ""}<input name="pve_token_secret" type="password" autocomplete="off"></label>
      <p class="hint">Datacenter → Permissions → API Tokens. Give it the <b>PVEAuditor</b> role on “/” (read-only).</p>
      <h3 class="section-h">AdGuard Home</h3>
      <label>Address<input name="adguard_host" value="${esc(s.adguard_host)}" autocomplete="off"></label>
      <div class="two">
        <label>Username<input name="adguard_user" value="${esc(s.adguard_user)}" autocomplete="off"></label>
        <label>Password${s.adguard_password_set ? " (saved)" : ""}<input name="adguard_password" type="password" autocomplete="off"></label>
      </div>
      <p class="hint">Saved on the planner server only. They're never sent back to a phone.</p>
      <div class="sheet-actions"><button type="button" class="btn secondary" id="s-cancel">Cancel</button><button class="btn">Save</button></div>
    </form>`, body => {
    body.querySelector("#s-cancel").addEventListener("click", closeSheet);
    body.querySelector("#setup-form").addEventListener("submit", e => {
      e.preventDefault();
      const f = e.target;
      const values = Object.fromEntries(["pve_host", "pve_token_id", "pve_token_secret", "adguard_host", "adguard_user", "adguard_password"].map(k => [k, f[k].value]));
      run(async () => {
        await api("/api/me/setup", { method: "PUT", body: values });
        closeSheet(); toast("Saved"); renderLab();
      });
    });
  });
}

// ------------------------------------------------------------ navigation

async function render() {
  hideTip();
  $("#page-title").textContent = TITLES[state.view];
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === state.view));
  document.querySelectorAll(".view").forEach(v => (v.hidden = v.id !== `view-${state.view}`));
  const target = state.view === "lab" ? $("#lab-body") : $(`#view-${state.view}`);
  if (!target.innerHTML.trim()) target.innerHTML = `<div class="empty">Loading…</div>`;
  await run(({ home: renderHome, calendar: renderCalendar, kids: renderKids, meds: renderMeds, lab: renderLab })[state.view]);
}

function show(view) {
  state.view = view;
  store("view", view);
  scrollTo(0, 0);
  render();
}

document.addEventListener("click", e => {
  const t = e.target;
  const tab = t.closest(".tabs button");
  if (tab?.dataset.go) return (location.href = tab.dataset.go);  // Meals and Admin are their own pages
  if (tab) return show(tab.dataset.view);
  const lab = t.closest("[data-lab]");
  if (lab) { state.lab = lab.dataset.lab; store("lab", state.lab); return run(renderLab); }
  if (t.closest("[data-setup]")) return run(setupForm);
  const mon = t.closest("[data-month]");
  if (mon) {
    const d = parseISO(`${state.month}-01`);
    d.setMonth(d.getMonth() + Number(mon.dataset.month));
    state.month = toISO(d).slice(0, 7);
    state.day = state.month === today.slice(0, 7) ? today : `${state.month}-01`;
    return run(renderCalendar);
  }
  const cell = t.closest("[data-cal-day]");
  if (cell) { state.day = cell.dataset.calDay; if (state.day.slice(0, 7) !== state.month) state.month = state.day.slice(0, 7); return run(renderCalendar); }
  if (t.closest("#cal-add")) return appointmentSheet({ people: state.people, day: state.day, base: "/api/appointments", onSaved: render });
  const medTakeBtn = t.closest("[data-med-take]");
  if (medTakeBtn) return medTake(state.meds, medTakeBtn.dataset.medTake, medTakeBtn.dataset.slot || "", () => render());
  const giveMed = t.closest("[data-give-med]");
  if (giveMed) return run(async () => { if (!state.meds) state.meds = await api("/api/meds"); giveSheet(state.meds, giveMed.dataset.giveMed, () => render()); });
  const sym = t.closest("[data-symptom]");
  if (sym) return run(() => symptomSheet(sym.dataset.symptom, state.meds.people, () => render()));
  const medAdd = t.closest("[data-med-add]");
  if (medAdd) return medForm(state.meds, null, () => render(), Number(medAdd.dataset.medAdd));
  const give = t.closest("[data-give]");
  if (give) return run(async () => {
    const r = state.rewards.rewards.find(x => x.id === Number(give.dataset.give));
    const kid = state.byId[give.dataset.kid];
    if (!confirm(`Give ${kid.name} "${r.title}"? ${r.cost} come off what they've saved.`)) return;
    await api(`/api/me/rewards/${r.id}/give`, { method: "POST", body: { person_id: kid.id } });
    toast(`🎉 ${kid.name}: ${r.title}`); renderKids();
  });
  const moneyBtn = t.closest("[data-money]");
  if (moneyBtn) return moneyForm(Number(moneyBtn.dataset.money), moneyBtn.dataset.kind);
  const cashIn = t.closest("[data-cash-in]");
  if (cashIn) return cashInForm(Number(cashIn.dataset.cashIn));
  const allowance = t.closest("[data-allowance]");
  if (allowance) return allowanceForm(Number(allowance.dataset.allowance));
  const mLog = t.closest("[data-money-log]");
  if (mLog) return moneyLog(Number(mLog.dataset.moneyLog));
  const addReward = t.closest("[data-add-reward]");
  if (addReward) return rewardForm(Number(addReward.dataset.addReward));
  if (t.closest("[data-edit-rewards]")) return rewardsList();
  const up = t.closest("[data-mail-upload]");
  if (up) return uploadMail(Number(up.dataset.mailUpload));
  const paste = t.closest("[data-mail-paste]");
  if (paste) return pasteMail(Number(paste.dataset.mailPaste));
  const mailRow = t.closest("[data-mail]");
  if (mailRow) return run(async () => reviewMail(await api(`/api/me/mail/${mailRow.dataset.mail}`)));
  const kidAppt = t.closest("[data-kid-appt]");
  if (kidAppt) return appointmentSheet({ people: state.people, day: today, base: "/api/appointments", onSaved: render, person: Number(kidAppt.dataset.kidAppt) });
  const appt = t.closest("[data-appt]");
  if (appt) return run(() => editAppt(Number(appt.dataset.appt), appt.dataset.date || state.day));
});
$("#sheet-backdrop").addEventListener("click", closeSheet);
$("#bell-btn").addEventListener("click", () => run(notificationsSheet));
$("#refresh-btn").addEventListener("click", () => {
  const frame = $("#view-home iframe");
  if (state.view === "home" && frame) frame.contentWindow.location.reload();
  else render();
});
addEventListener("scroll", hideTip, { passive: true });

run(async () => {
  state.people = await api("/api/people");
  state.byId = personMap(state.people);
  state.view = TITLES[recall("view")] ? recall("view") : "home";
  state.lab = ["pve", "dns", "speed", "net"].includes(recall("lab")) ? recall("lab") : "pve";
  // The tabs chosen in Admin → People for the adult this page belongs to (the first with full access).
  const owner = state.owner = state.people.find(p => !p.is_kid && p.access !== "phone");
  const on = applyPageTabs(owner, MY_PAGE_TABS);
  if (!on.includes(state.view)) state.view = on.find(k => TITLES[k]) || "home";
  await render();
});
// Keep the homelab numbers fresh while the page is open.
setInterval(() => { if (state.view === "lab" && !document.hidden && $("#sheet").hidden) run(renderLab); }, 60000);
