// Doctor report: one person's medicine, puffers and symptoms over a date range, ready to print or save as a PDF.

const $ = sel => document.querySelector(sel);
const today = toISO(new Date());
const params = new URLSearchParams(location.search);
const form = $("#controls");

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3000);
}

const when = iso => `${DAY_NAMES[parseISO(iso.slice(0, 10)).getDay()].slice(0, 3)} ${MONTH_NAMES[parseISO(iso.slice(0, 10)).getMonth()].slice(0, 3)} ${parseISO(iso.slice(0, 10)).getDate()}`;
const clock = iso => fmtTime(iso.slice(11, 16));

async function load() {
  const person = form.person.value, start = form.start.value, end = form.end.value;
  history.replaceState(null, "", `/report?person=${person}&start=${start}&end=${end}`);
  $("#csv").href = `/api/meds/report.csv?person_id=${person}&start=${start}&end=${end}`;
  const d = await api(`/api/meds/report?person_id=${person}&start=${start}&end=${end}`);
  document.title = `${d.person.name}: medicine ${d.start} to ${d.end}`;
  const puffers = d.summary.filter(s => s.kind === "puffer");
  const rescue = puffers.filter(s => /rescue|ventolin|salbutamol|airomir|blue/i.test(s.med));
  $("#report").innerHTML = `
    <h1>${esc(d.person.name)}</h1>
    <div class="meta">${d.person.birthday ? `Born ${esc(d.person.birthday)}${d.person.age != null ? ` (age ${d.person.age})` : ""} · ` : ""}${esc(when(d.start))} to ${esc(when(d.end))}, ${d.days.length} days · made ${esc(d.made.replace("T", " "))}</div>

    <h2>Summary</h2>
    ${d.summary.length ? `<table><tr><th>Medicine</th><th class="num">Times</th>${puffers.length ? `<th class="num">Puffs</th>` : ""}<th class="num">Days used</th><th class="num">Most in a day</th><th>Last</th></tr>
      ${d.summary.map(s => `<tr><td>${s.kind === "puffer" ? "🫁" : "💊"} ${esc(s.med)}</td><td class="num">${s.times}</td>${puffers.length ? `<td class="num">${s.puffs ?? ""}</td>` : ""}
        <td class="num">${s.days_used} of ${d.days.length}</td><td class="num">${s.most_in_a_day}</td><td>${esc(when(s.last))} ${esc(clock(s.last))}</td></tr>`).join("")}</table>`
      : `<div class="none">No medicine given in this time.</div>`}
    ${rescue.length ? `<p class="meta">Rescue puffer: used on ${rescue.reduce((a, s) => a + s.days_used, 0)} of ${d.days.length} days, ${rescue.reduce((a, s) => a + s.times, 0)} times.</p>` : ""}
    ${d.highest_temp != null ? `<p class="meta">Highest temperature: <span class="fever">${d.highest_temp} °C</span></p>` : ""}

    ${d.summary.length && d.days.length <= 31 ? `<h2>By day</h2><div class="days"><table>
      <tr><th></th>${d.days.map(x => `<th>${parseISO(x).getDate()}</th>`).join("")}</tr>
      ${d.summary.map(s => `<tr><td>${esc(s.med.split(":").pop().split("(")[0].trim())}</td>${d.days.map(x => `<td class="${s.per_day[x] ? "hit" : ""}">${s.per_day[x] || ""}</td>`).join("")}</tr>`).join("")}
      ${d.symptoms.length ? `<tr><td>Symptoms noted</td>${d.days.map(x => { const n = d.symptoms.filter(y => y.at.slice(0, 10) === x).length; return `<td class="${n ? "hit" : ""}">${n || ""}</td>`; }).join("")}</tr>` : ""}
    </table></div>` : ""}

    <h2>Symptoms</h2>
    ${d.symptoms.length ? `<table><tr><th>When</th><th>What</th><th>How bad</th><th class="num">Temp</th><th>Note</th></tr>
      ${d.symptoms.map(s => `<tr><td>${esc(when(s.at))} ${esc(clock(s.at))}</td><td>${esc(s.kinds)}</td><td>${esc(s.severity)}</td>
        <td class="num ${s.temp >= 38 ? "fever" : ""}">${s.temp != null ? `${s.temp} °C` : ""}</td><td>${esc(s.note)}</td></tr>`).join("")}</table>`
      : `<div class="none">No symptoms noted.</div>`}

    <h2>Every dose</h2>
    ${d.log.length ? `<table><tr><th>When</th><th>Medicine</th><th>Dose</th><th>Given by</th><th>Note</th></tr>
      ${d.log.map(l => `<tr><td>${esc(when(l.at))} ${esc(clock(l.at))}</td><td>${esc(l.med)}</td><td>${esc(l.dose)}</td><td>${esc(l.by_name || "")}</td><td>${esc(l.note)}</td></tr>`).join("")}</table>`
      : `<div class="none">None.</div>`}

    ${d.current_meds.length ? `<h2>Current medicine</h2><table><tr><th>Medicine</th><th>Dose</th><th>When</th></tr>
      ${d.current_meds.map(m => { const t = JSON.parse(m.times || "[]"); return `<tr><td>${m.kind === "puffer" ? "🫁" : "💊"} ${esc(m.name)}</td><td>${esc(m.dose)}</td>
        <td>${t.length ? t.map(fmtTime).join(", ") : "as needed"}${m.min_hours ? ` · at least ${m.min_hours} h apart` : ""}${m.max_per_day ? ` · max ${m.max_per_day}/day` : ""}${m.notes ? ` · ${esc(m.notes)}` : ""}</td></tr>`; }).join("")}</table>` : ""}
    <p class="foot">Recorded by the family in their planner. Times are when a dose was marked as given.</p>`;
}

function setRange(days) {
  form.end.value = today;
  form.start.value = addDays(today, -(days - 1));
  document.querySelectorAll("[data-days]").forEach(b => b.classList.toggle("on", Number(b.dataset.days) === days));
}

document.querySelectorAll("[data-days]").forEach(b => b.addEventListener("click", () => { setRange(Number(b.dataset.days)); load().catch(e => toast(e.message)); }));
form.addEventListener("change", () => { document.querySelectorAll("[data-days]").forEach(b => b.classList.remove("on")); load().catch(e => toast(e.message)); });
$("#print").addEventListener("click", () => window.print());
$("#back-link").addEventListener("click", e => { e.preventDefault(); history.length > 1 ? history.back() : (location.href = "/"); });

(async () => {
  try {
    const data = await api("/api/meds");
    const people = data.people.filter(p => p.is_kid || data.meds.some(m => m.person_id === p.id));
    const chosen = params.get("person") || people[0]?.id;
    form.person.innerHTML = people.map(p => `<option value="${p.id}" ${String(p.id) === String(chosen) ? "selected" : ""}>${esc(nameOf(p))}</option>`).join("");
    if (params.get("start") && params.get("end")) { form.start.value = params.get("start"); form.end.value = params.get("end"); }
    else setRange(14);
    await load();
  } catch (e) { toast(e.message); }
})();
