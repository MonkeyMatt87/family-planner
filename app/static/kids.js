// Kids' pages: /kids/<name> (home Wi-Fi only). /kids shows a big button for each kid.

const $ = sel => document.querySelector(sel);
let kids = [];
let kid = null;
let data = null;

// Looks per theme. "island" = ocean and hibiscus, "power" = video-game power-ups. Emoji only, no characters.
const THEMES = {
  island: { hello: "Aloha", star: "🌺", one: "flower", many: "flowers", done: "Awesome! 🌺", badge: "🏝️🌺" },
  power: { hello: "Hey", star: "🪙", one: "coin", many: "coins", done: "Power up! ⭐", badge: "⭐🍄" },
  "": { hello: "Hi", star: "⭐", one: "star", many: "stars", done: "Nice work! ⭐", badge: "👋" },
};
const theme = () => THEMES[kid?.theme || ""] || THEMES[""];

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2500);
}

function weatherTip(w) {
  const d = w.daily[0];
  if (d.rain >= 50) return "Bring a raincoat ☔";
  if (w.temp <= 0 || d.hi <= 2) return "Bundle up: hat and mittens! 🧤";
  if (d.hi < 12) return "Grab a jacket 🧥";
  if (d.hi >= 24) return "Nice and warm 😎";
  return "Have a great day! 🌟";
}


async function load() {
  data = await api(`/api/kids/${kid.id}`);
  render();
}

function render() {
  const th = theme();
  document.body.dataset.theme = kid.theme || "";
  document.documentElement.style.setProperty("--kid", kid.color);
  $("#picker").hidden = true;
  $("#page").hidden = false;
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? th.hello : "Good evening";
  $("#hello").textContent = `${greet}, ${kid.name}! ${kid.icon || th.badge}`;
  $("#today").textContent = `${DAY_NAMES[now.getDay()]}, ${MONTH_NAMES[now.getMonth()]} ${now.getDate()}` +
    (data.kid.teacher ? ` · 👩‍🏫 ${data.kid.teacher}` : "");

  // morning summary (today until 3 pm, then tomorrow)
  const s = data.summary;
  const when = s.when === "today" ? "Today" : "Tomorrow";
  const lines = [];
  if (s.school) {
    lines.push(`🏫 School ${s.when}${s.rotation ? ` · <b>Day ${s.rotation}</b>` : ""}${s.special ? ` · ${esc(s.special)}` : ""}`);
    if (s.special && s.special.includes("Gym")) lines.push("👟 Gym: wear your sneakers");
    if (s.special && s.special.includes("Library")) lines.push("📚 Library: bring your library book");
    lines.push("🚌 Bus at 8:30. Be ready by 8:00");
    if (s.lunch) lines.push(s.lunch.choice === "buy" ? `🍽️ School lunch: ${esc(s.lunch.menu)}`
      : s.lunch.choice === "pack" ? "🥪 Bring your packed lunch" : "🍴 Lunch: ask a grown-up");
  } else if (s.reason !== "Weekend") {
    lines.push(`🎉 No school ${s.when}: ${esc(s.reason)}`);
  } else {
    lines.push(`😎 It's the weekend!`);
  }
  if (s.event) lines.push(esc(s.event));
  $("#summary").innerHTML = `<h2>☀️ ${when}</h2>${lines.map(l => `<div class="line">${l}</div>`).join("")}`;

  // weather
  const w = data.weather;
  $("#weather").hidden = !w;
  if (w) {
    const info = weatherInfo(w.code), d0 = w.daily[0], d1 = w.daily[1];
    $("#weather").innerHTML = `
      <div class="big">${info.icon}</div>
      <div class="temp">${w.temp}° <small>${esc(info.label)}</small></div>
      <div class="tip">${esc(weatherTip(w))} · High ${d0.hi}°</div>
      ${d1 ? `<div class="tomorrow">Tomorrow: ${weatherInfo(d1.code).icon} ${esc(weatherInfo(d1.code).label)}, high ${d1.hi}°${d1.rain >= 40 ? ` · ${d1.rain}% rain` : ""}</div>` : ""}`;
  }

  // chores
  const doneCount = data.chores.filter(c => c.done).length;
  $("#chores").innerHTML = `
    <div class="chore-head"><h2>✅ My jobs today</h2><span class="stars">${th.star} ${data.stars} ${data.stars === 1 ? th.one : th.many} this week</span></div>
    ${data.chores.map(c => `<button class="todo ${c.done ? "done" : ""}" data-chore="${c.id}">
      <span class="box">${c.done ? th.star : ""}</span><span class="t">${esc(c.title)}</span></button>`).join("")}
    ${data.chores.length && doneCount === data.chores.length ? `<div class="all-done">All done! ${th.star}${th.star}${th.star}</div>` : ""}`;

  // bedtime routine: school nights, from 4 pm (above the day's jobs, since it's what's next)
  $("#bedtime").hidden = !data.bedtime_show;
  if (data.bedtime_show) {
    const nowHM = `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const allDone = data.bedtime.every(c => c.done);
    $("#bedtime").innerHTML = `
      <div class="chore-head"><h2>🌙 Bedtime</h2><span class="stars">${allDone ? `Sleep well! 💤` : data.summary.school && data.summary.when === "tomorrow" ? "School tomorrow" : "No school tomorrow"}</span></div>
      ${data.bedtime.map(c => `<button class="todo ${c.done ? "done" : ""}" data-chore="${c.id}">
        <span class="box">${c.done ? th.star : ""}</span><span class="t">${esc(c.title)}</span>
        ${c.at ? `<span class="due ${!c.done && c.at <= nowHM ? "soon" : ""}">${fmtTime(c.at)}</span>` : ""}</button>`).join("")}`;
  }

  // homework and reading: after school (from 3 pm)
  $("#homework").hidden = !data.homework_show;
  if (data.homework_show) {
    const hwDone = data.homework.every(c => c.done);
    $("#homework").innerHTML = `
      <div class="chore-head"><h2>📚 Homework &amp; reading</h2><span class="stars">${hwDone ? `All done! ${th.star}` : "Tonight"}</span></div>
      ${data.homework.map(c => `<button class="todo ${c.done ? "done" : ""}" data-chore="${c.id}">
        <span class="box">${c.done ? th.star : ""}</span><span class="t">${esc(c.title)}</span></button>`).join("")}`;
  }

  // rewards the grown-ups picked: how close they are
  $("#rewards").hidden = !data.rewards.length;
  if (data.rewards.length) {
    $("#rewards").innerHTML = `
      <div class="chore-head"><h2>🎁 My rewards</h2><span class="stars">${th.star} ${data.balance} saved</span></div>
      ${data.rewards.map(r => {
        const left = r.cost - data.balance;
        return `<div class="reward">
          <div class="reward-top"><span class="t">${esc(r.title)}</span><span class="due">${left <= 0 ? "🎉 You can get it! Ask a grown-up" : `${left} more ${left === 1 ? th.one : th.many}`}</span></div>
          <div class="reward-track"><i style="width:${Math.min(100, data.balance / r.cost * 100).toFixed(0)}%"></i></div></div>`;
      }).join("")}`;
  }

  // countdowns: next day off, birthdays, parties
  const cds = [];
  const off = data.next_day_off;
  if (off) cds.push({ n: off.days, what: `until ${off.name === "No school" ? "a day off school" : off.name}`, icon: "🎉" });
  for (const b of data.birthdays) cds.push({ n: b.days, what: b.mine ? `until your birthday! You'll be ${b.age}` : `until ${b.name}'s birthday`, icon: "🎂" });
  for (const p of data.parties) cds.push({ n: p.days, what: `until ${p.title}${p.location ? ` (${p.location})` : ""}`, icon: "🎈" });
  cds.sort((a, b) => a.n - b.n);
  $("#countdowns").innerHTML = cds.slice(0, 3).map(c => c.n === 0
    ? `<div class="cd"><div class="num">Today!</div><div class="what">${c.icon} ${esc(c.what.replace(/^until /, ""))}</div></div>`
    : `<div class="cd"><div class="num">${c.n}</div><div class="what">${c.icon} ${c.n === 1 ? "sleep" : "sleeps"} ${esc(c.what)}</div></div>`).join("");
  $("#countdowns").hidden = !cds.length;

  // lunch
  $("#lunch").innerHTML = data.lunch.length ? data.lunch.map(l => {
    const mine = l.choice === "buy" ? "🍽️ You're having school lunch" : l.choice === "pack" ? "🥪 Bring your packed lunch" : "Not decided yet";
    return `<div class="lunch-day">
      <div class="when">${esc(relDay(l.date, data.today))}</div>
      <div class="menu">${esc(l.menu || "Menu not posted yet")}</div>
      <span class="mine ${l.choice || "unset"}">${mine}</span>
    </div>`;
  }).join("") : `<div class="empty">No school days coming up 🎈</div>`;

  // to-dos (kids can add their own)
  $("#tasks").innerHTML = (data.tasks.length ? data.tasks.map(t => {
    const diff = t.due_date ? daysBetween(data.today, t.due_date) : null;
    const due = diff === null ? "" : diff < 0 ? "Late!" : relDay(t.due_date, data.today);
    return `<button class="todo ${t.done ? "done" : ""}" data-task="${t.id}">
      <span class="box">${t.done ? "✓" : ""}</span><span class="t">${esc(t.title)}</span>
      ${due && !t.done ? `<span class="due ${diff !== null && diff <= 1 ? "soon" : ""}">${esc(due)}</span>` : ""}
    </button>`;
  }).join("") : `<div class="empty">Nothing to do. Nice! 🎉</div>`);

  // joke and fact of the day
  $("#fun").innerHTML = `
    <h2>😂 Joke of the day</h2>
    <p class="joke">${esc(data.joke)}</p>
    <button class="reveal" id="reveal">Tap for the answer</button>
    <p class="punch" id="punch" hidden>${esc(data.punchline)}</p>
    <h2 class="fact-h">🤓 Did you know?</h2>
    <p class="fact">${esc(data.fact)}</p>`;

  // coming up: only days that have something
  const busy = data.days.filter(d => d.items.length);
  $("#days").innerHTML = busy.length ? busy.map(d => `<div class="day">
      <div class="dname">${esc(relDay(d.date, data.today))}</div>
      ${d.items.map(it => {
        const color = it.color || (it.person_id === kid.id ? kid.color : "#8a8f98");
        const when = it.source === "task" ? "Due" : it.source === "holiday" ? (it.kind === "holiday" ? "Day off" : "")
          : it.all_day ? "" : fmtTime(it.start_time);
        return `<div class="item" style="--c:${esc(color)}">${when ? `<span class="when">${esc(when)}</span>` : ""}<span class="what">${esc(it.title)}</span></div>`;
      }).join("")}
    </div>`).join("") : `<div class="empty">Nothing on the calendar this week.</div>`;

  $("#updated").textContent = `Updated ${fmtTime(`${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`)}`;
}

// Morning reminders (7:00 on school days). Needs https: the home address from Settings (home_url).
async function setupBell() {
  const bell = $("#bell");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  if (!window.isSecureContext && !data.home_url) return;  // no https address set up: nothing to offer
  bell.hidden = false;
  const page = `${data.home_url}/kids/${encodeURIComponent(kid.name.toLowerCase())}`;
  if (!window.isSecureContext) {
    bell.innerHTML = `<h2>🔔 Morning reminders</h2><p class="empty">To get a reminder on this phone every school morning, open
      <b>${esc(page)}</b> and add that to your home screen.</p>`;
    return;
  }
  const reg = await navigator.serviceWorker.register("/kids-sw.js", { scope: "/kids/" });
  const sub = await reg.pushManager.getSubscription();
  if (sub && Notification.permission === "granted") {
    await api(`/api/kids/${kid.id}/push`, { method: "POST", body: { subscription: sub.toJSON() } });  // keep it linked to this kid
    bell.innerHTML = `<h2>🔔 Morning reminders are on</h2><p class="empty">Every school day at 7:00.</p>
      <button class="reveal" id="bell-test">Send one now</button>`;
  } else if (Notification.permission === "denied") {
    bell.innerHTML = `<h2>🔔 Morning reminders</h2><p class="empty">Notifications are blocked for this page. Ask a grown-up to allow them in Chrome's site settings.</p>`;
  } else {
    bell.innerHTML = `<h2>🔔 Morning reminders</h2><p class="empty">Get your day on this phone every school morning at 7:00.</p>
      <button class="reveal" id="bell-on">Turn on reminders</button>`;
  }
}

async function turnOnBell() {
  if (await Notification.requestPermission() !== "granted") return setupBell();
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api("/api/kids/push/key");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await api(`/api/kids/${kid.id}/push`, { method: "POST", body: { subscription: sub.toJSON() } });
  toast("Reminders are on! 🔔");
  await api(`/api/kids/${kid.id}/push/test`, { method: "POST" });
  setupBell();
}

function b64uToBytes(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function showPicker() {
  $("#page").hidden = true;
  $("#picker").hidden = false;
  $("#picker-list").innerHTML = kids.map(k =>
    `<a class="pick" href="/kids/${encodeURIComponent(k.name.toLowerCase())}" style="--c:${esc(k.color)}">${esc(nameOf(k) || k.name)} ${(THEMES[k.theme] || THEMES[""]).badge}</a>`).join("");
}

document.addEventListener("click", async e => {
  if (e.target.id === "reveal") {
    e.target.hidden = true;
    $("#punch").hidden = false;
    return;
  }
  if (e.target.id === "bell-on") return turnOnBell().catch(err => toast(err.message));
  if (e.target.id === "bell-test") {
    return api(`/api/kids/${kid.id}/push/test`, { method: "POST" })
      .then(r => toast(r.sent ? "Sent! Check your notifications 🔔" : "Couldn't send it"))
      .catch(err => toast(err.message));
  }
  const c = e.target.closest("[data-chore]");
  const t = e.target.closest("[data-task]");
  try {
    if (c) {
      const r = await api(`/api/kids/${kid.id}/chores/${c.dataset.chore}`, { method: "POST" });
      if (r.done) toast(theme().done);
      await load();
    } else if (t) {
      const r = await api(`/api/kids/${kid.id}/tasks/${t.dataset.task}`, { method: "POST" });
      if (r.done) toast(theme().done);
      await load();
    }
  } catch (err) { toast(err.message); }
});

$("#add-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  try {
    await api(`/api/kids/${kid.id}/tasks`, { method: "POST", body: { title: f.title.value, due_date: f.due.value || null } });
    f.reset();
    toast("Added! 📝");
    await load();
  } catch (err) { toast(err.message); }
});

(async () => {
  try {
    kids = await api("/api/kids");
    const slug = decodeURIComponent(location.pathname.split("/")[2] || "").toLowerCase();
    kid = kids.find(k => k.name.toLowerCase() === slug);
    if (!kid) return showPicker();
    document.title = `${kid.name}'s Day`;
    await load();
    setupBell().catch(() => {});
    setInterval(() => load().catch(() => {}), 5 * 60 * 1000);
  } catch (err) {
    toast(err.message);
  }
})();
