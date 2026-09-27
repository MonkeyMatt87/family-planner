// My page (/me), for adults: Home (the family board), Calendar, Kids, Homelab (Proxmox, AdGuard, speed tests, network).

const $ = sel => document.querySelector(sel);
const today = toISO(new Date());
const state = { view: "home", lab: "pve", people: [], byId: {}, month: today.slice(0, 7), day: today, items: [], kids: [] };
const TITLES = { home: "Home", calendar: "Calendar", kids: "Kids", lab: "Homelab" };

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
  v.innerHTML = state.kids.map(k => {
    const s = k.summary;
    const school = s.school
      ? `Day ${s.rotation ?? "?"}${s.special ? ` · ${esc(s.special)}` : ""}${s.event ? ` · ${esc(s.event)}` : ""}`
      : esc(s.reason || "No school");
    const lunch = s.lunch ? `${LUNCH_SHORT[s.lunch.choice] || "Lunch not set"}${s.lunch.menu && s.lunch.choice === "buy" ? `: ${esc(s.lunch.menu)}` : ""}` : "";
    const coming = k.days.flatMap(d => d.items.filter(i => i.source === "appt" || i.source === "google").map(i => ({ ...i })));
    const todos = k.tasks.filter(t => !t.done);
    const bday = k.birthdays.find(b => b.mine);
    return `<div class="card kid-card">
      <div class="kid-head"><span class="swatch" style="background:${esc(k.kid.color)}"></span><h3>${esc(nameOf(k.kid))}</h3>
        <button class="btn secondary small" data-kid-appt="${k.kid.id}">+ Appointment</button></div>
      <div class="kid-sec"><div class="sec-h">School ${esc(s.when)}</div>
        <div class="kid-line">${school}</div>${lunch ? `<div class="kid-line">${lunch}</div>` : ""}</div>
      <div class="kid-sec"><div class="sec-h">Next 7 days</div>
        ${coming.map(i => `<div class="kid-line ${i.source === "appt" ? "tap" : ""}" ${i.source === "appt" ? `data-appt="${i.id}" data-date="${i.date}"` : ""}>
          <b>${esc(relDay(i.date, today))}</b> · ${esc(i.title)}${i.all_day ? "" : ` · ${fmtRange(i)}`}${i.person_id ? "" : ` <span class="muted">(family)</span>`}</div>`).join("")
          || `<div class="kid-line muted">No appointments.</div>`}</div>
      <div class="kid-sec"><div class="sec-h">To-dos</div>
        ${todos.map(t => `<div class="kid-line">☐ ${esc(t.title)}${t.due_date ? ` <span class="muted">· ${esc(relDay(t.due_date, today))}</span>` : ""}</div>`).join("")
          || `<div class="kid-line muted">All done.</div>`}</div>
      <div class="kid-sec small muted">
        ${bday ? `🎂 Turns ${bday.age} in ${bday.days} day${bday.days === 1 ? "" : "s"}` : ""}
        ${k.next_day_off ? `${bday ? " · " : ""}Next day off: ${esc(k.next_day_off.name)} (${esc(relDay(k.next_day_off.date, today))})` : ""}
        · ⭐ ${k.stars} chore star${k.stars === 1 ? "" : "s"} this week</div>
    </div>`;
  }).join("") || `<div class="empty">No kids set up.</div>`;
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
  await run(({ home: renderHome, calendar: renderCalendar, kids: renderKids, lab: renderLab })[state.view]);
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
  const kidAppt = t.closest("[data-kid-appt]");
  if (kidAppt) return appointmentSheet({ people: state.people, day: today, base: "/api/appointments", onSaved: render, person: Number(kidAppt.dataset.kidAppt) });
  const appt = t.closest("[data-appt]");
  if (appt) return run(() => editAppt(Number(appt.dataset.appt), appt.dataset.date || state.day));
});
$("#sheet-backdrop").addEventListener("click", closeSheet);
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
  await render();
});
// Keep the homelab numbers fresh while the page is open.
setInterval(() => { if (state.view === "lab" && !document.hidden && $("#sheet").hidden) run(renderLab); }, 60000);
