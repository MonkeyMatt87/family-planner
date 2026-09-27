// Wall display for the Raspberry Pi. Refreshes itself; nothing to click.

const REFRESH_MS = 60 * 1000;
const RELOAD_MS = 6 * 60 * 60 * 1000;  // full reload now and then picks up app updates
const LUNCH_SWITCH_HOUR = 13;           // after lunch, fade today's lunch
const NIGHT = { from: 22, to: 6 };      // dim the screen overnight (Pi only)
const KIOSK = new URLSearchParams(location.search).has("kiosk");  // the Pi opens /display?kiosk=1
const MOBILE = location.pathname.startsWith("/mobile");
const EMBED = new URLSearchParams(location.search).has("embed");  // the Home tab on My page (/me) shows /mobile?embed=1
document.body.classList.toggle("mobile", MOBILE);
document.body.classList.toggle("embed", EMBED);
document.body.classList.toggle("kiosk", KIOSK);

const $ = sel => document.querySelector(sel);
let data = null;

function tick() {
  const now = new Date();
  let h = now.getHours() % 12 || 12;
  $("#time").textContent = `${h}:${String(now.getMinutes()).padStart(2, "0")}`;
  $("#date").textContent = `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}`;
  const hr = now.getHours();
  $("#night").hidden = !KIOSK || !(hr >= NIGHT.from || hr < NIGHT.to);
}

async function refresh() {
  try {
    data = await api("/api/dashboard");
  } catch (e) {
    $("#offline").hidden = false;  // really couldn't reach the planner
    return;
  }
  $("#offline").hidden = true;
  try {
    render();
  } catch (e) {
    console.error("display render failed", e);  // a page bug, not the network
  }
}

function item(it, people, { compact = false } = {}) {
  const color = itemColor(it, people);
  const who = people[it.person_id];
  let when;
  if (it.source === "task") when = "Due";
  else if (it.source === "holiday") when = it.kind === "holiday" ? "Holiday" : "";
  else if (it.all_day) when = "All day";
  else when = compact ? fmtTime(it.start_time) : fmtRange(it);
  const title = it.source === "shift" && who ? `${nameOf(who)} – ${it.title}` : it.title;
  return `<div class="item ${it.source}" style="--c:${esc(color)}">
    <div class="when">${esc(when)}</div>
    <div class="what">${esc(title)}${who && it.source !== "shift" && !compact && !it.who_in_title ? `<span class="who">${esc(nameOf(who))}</span>` : ""}</div>
  </div>`;
}

function render() {
  const people = personMap(data.people);
  $("#family").textContent = data.family_name ? `${data.family_name}` : "";

  // weather
  const w = data.weather;
  if (w) {
    const info = weatherInfo(w.code);
    const dayLine = (label, d) => {
      if (!d) return "";
      const di = weatherInfo(d.code);
      return `<div class="w-day"><span class="w-label">${label}</span><span class="w-dicon">${di.icon}</span>
        <span class="w-cond">${esc(di.label)}</span><span class="w-hilo"><b>${d.hi}°</b> / ${d.lo}°</span>
        <span class="w-rain">${d.rain ? `${d.rain}% rain` : ""}</span></div>`;
    };
    $("#weather").innerHTML = `<div class="w-now" title="${esc(info.label)} now"><span class="w-icon">${info.icon}</span>${w.temp}°</div>
      <div class="w-days">${dayLine("Today", w.daily[0])}${dayLine("Tomorrow", w.daily[1])}</div>`;
  } else {
    $("#weather").innerHTML = "";
  }
  const wByDate = Object.fromEntries((w?.daily || []).map(d => [d.date, d]));

  // today
  const today = data.days[0].items;
  $("#today-list").innerHTML = today.length
    ? today.map(it => item(it, people)).join("")
    : `<div class="nothing">Nothing scheduled today</div>`;

  // lunch: today (if it's a school day) and the next school day
  const kidsExist = data.people.some(p => p.is_kid);
  $("#lunch-panel").hidden = !kidsExist;
  if (kidsExist) {
    const afterLunch = new Date().getHours() >= LUNCH_SWITCH_HOUR;
    const lunchDays = data.lunch.filter(l => !l.no_school).slice(0, 2);
    $("#lunch").innerHTML = lunchDays.length ? lunchDays.map(l => `
      <div class="lunch-day ${afterLunch && l.date === data.today ? "past" : ""}">
        <div class="lunch-when">${esc(relDay(l.date, data.today))}</div>
        ${l.menu ? `<div class="menu">${esc(l.menu)}</div>` : `<div class="menu muted">No menu yet</div>`}
        <div class="kids">${l.kids.map(k => {
          const p = people[k.person_id];
          if (!p) return "";
          const label = LUNCH_SHORT[k.choice] || "?";
          return `<div class="kid ${k.choice || "unset"}" style="--c:${esc(p.color)}"><span class="name">${esc(p.name)}</span><span class="choice">${label}</span></div>`;
        }).join("")}</div>
      </div>`).join("") : `<div class="menu muted">No school days coming up</div>`;
  }

  // next six days
  $("#week").innerHTML = data.days.slice(1).map(day => {
    const d = parseISO(day.date);
    const wd = wByDate[day.date];
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    return `<div class="day ${weekend ? "weekend" : ""}">
      <div class="day-head">
        <div><span class="dname">${daysBetween(data.today, day.date) === 1 ? "Tomorrow" : DAY_NAMES[d.getDay()]}</span>
        <span class="dnum">${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}</span></div>
        ${wd ? `<div class="dw">${weatherInfo(wd.code).icon} ${wd.hi}°</div>` : ""}
      </div>
      <div class="day-items">${day.items.map(it => item(it, people, { compact: true })).join("") || `<div class="nothing small">—</div>`}</div>
    </div>`;
  }).join("");

  // tasks, one column per person who has any
  const groups = new Map();
  for (const t of data.tasks) {
    const key = t.person_id && people[t.person_id] ? t.person_id : 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const order = [...data.people.map(p => p.id).filter(id => groups.has(id)), ...(groups.has(0) ? [0] : [])];
  $("#tasks").innerHTML = order.length ? order.map(id => {
    const p = people[id];
    const list = groups.get(id);
    return `<div class="task-col" style="--c:${esc(p ? p.color : "#8a8f98")}">
      <div class="task-who">${esc(p ? p.name : "Family")}</div>
      ${list.slice(0, 6).map(t => {
        const diff = t.due_date ? daysBetween(data.today, t.due_date) : null;
        const cls = diff === null ? "" : diff < 0 ? "overdue" : diff <= 1 ? "soon" : "";
        const due = diff === null ? "" : diff < 0 ? "Overdue" : relDay(t.due_date, data.today);
        return `<div class="todo ${cls}"><span class="box"></span><span class="t">${esc(t.title)}</span>${due ? `<span class="due">${esc(due)}</span>` : ""}</div>`;
      }).join("")}
      ${list.length > 6 ? `<div class="more">+${list.length - 6} more</div>` : ""}
    </div>`;
  }).join("") : `<div class="nothing">All caught up 🎉</div>`;

  // legend
  $("#legend").innerHTML = data.people.map(p =>
    `<span><i style="background:${esc(p.color)}"></i>${esc(nameOf(p))}</span>`).join("") +
    `<span class="updated">Updated ${fmtTime(data.now)}</span>`;
}

// On the phone view: a button to edit your own shifts (phone sign-in), or to open the full planner.
if (MOBILE && !EMBED) {
  api("/api/me").then(me => {
    const link = $("#edit-link");
    if (me.role === "member") { link.textContent = "✏️ Shifts & appointments"; link.href = "/my-shifts"; }
    else if (me.role === "adult") { link.textContent = "⚙️ Full planner"; link.href = "/"; }
    else return;
    link.hidden = false;
  }).catch(() => {});
}

tick();
setInterval(tick, 1000);
refresh();
setInterval(refresh, REFRESH_MS);
setTimeout(() => location.reload(), RELOAD_MS);
