// First-run setup (/setup): the family, where you live, the family PIN. Only works from the home network.

const $ = sel => document.querySelector(sel);
const COLORS = ["#f07a1a", "#8e5bd6", "#e0529c", "#2e9e5b", "#2f6fdb", "#d4a017", "#17a2b8", "#b0413e"];
const FAHRENHEIT = new Set(["US", "LR", "MM", "BS", "BZ", "KY", "PW"]);
let countries = [];
let place = null;  // {latitude, longitude, label}

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 4500 : 2000);
}

// ------------------------------------------------------------ people

function personRow(p = {}) {
  const i = $("#people").children.length;
  const row = document.createElement("div");
  row.className = "person-row";
  row.innerHTML = `
    <input type="color" value="${esc(p.color || COLORS[i % COLORS.length])}" aria-label="Colour">
    <input type="text" placeholder="${p.is_kid ? "Kid's name" : "Name"}" value="${esc(p.name || "")}" maxlength="40" autocomplete="off">
    <div class="seg"><button type="button" data-kid="0" class="${p.is_kid ? "" : "on"}">Adult</button><button type="button" data-kid="1" class="${p.is_kid ? "on" : ""}">Kid</button></div>
    <button type="button" class="icon-btn small" aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  row.querySelectorAll("[data-kid]").forEach(b => b.addEventListener("click", () =>
    row.querySelectorAll("[data-kid]").forEach(x => x.classList.toggle("on", x === b))));
  row.querySelector(".icon-btn").addEventListener("click", () => row.remove());
  $("#people").appendChild(row);
}

function people() {
  return [...$("#people").children].map(row => ({
    name: row.querySelector("input[type=text]").value.trim(),
    color: row.querySelector("input[type=color]").value,
    is_kid: row.querySelector("[data-kid].on")?.dataset.kid === "1",
  })).filter(p => p.name);
}

// ------------------------------------------------------------ where you live (Open-Meteo's free place search)

function fillSubdivs(code, pick = "") {
  const c = countries.find(x => x.code === code);
  const sel = $("[name=holiday_subdiv]");
  sel.innerHTML = `<option value="">All of the country</option>` +
    (c?.subdivs || []).map(s => `<option value="${esc(s.code)}">${esc(s.name)}</option>`).join("");
  const match = (c?.subdivs || []).find(s => s.code === pick || s.name.toLowerCase() === pick.toLowerCase());
  sel.value = match ? match.code : "";
}

async function searchCity(q) {
  const box = $("#city-results");
  if (q.length < 2) { box.innerHTML = ""; return; }
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&name=${encodeURIComponent(q)}`);
    const results = (await r.json()).results || [];
    box.innerHTML = results.map((p, i) => `<button type="button" data-i="${i}">${esc(p.name)}${p.admin1 ? `, ${esc(p.admin1)}` : ""} <span class="muted">· ${esc(p.country || p.country_code)}</span></button>`).join("")
      || `<div class="hint">No places found. You can skip this and add the weather later in Settings.</div>`;
    box.querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => pickCity(results[Number(b.dataset.i)])));
  } catch (_) {
    box.innerHTML = `<div class="hint">Couldn't search right now (no internet?). You can add the weather later in Settings.</div>`;
  }
}

function pickCity(p) {
  place = { latitude: p.latitude.toFixed(4), longitude: p.longitude.toFixed(4) };
  $("#city-results").innerHTML = "";
  $("[name=city]").value = p.name;
  $("#picked").textContent = `📍 ${p.name}${p.admin1 ? `, ${p.admin1}` : ""}, ${p.country || p.country_code} (${place.latitude}, ${place.longitude})`;
  if (countries.some(c => c.code === p.country_code)) {
    $("[name=holiday_country]").value = p.country_code;
    fillSubdivs(p.country_code, p.admin1 || "");
  }
  $("[name=temp_unit]").value = FAHRENHEIT.has(p.country_code) ? "fahrenheit" : "celsius";
}

// ------------------------------------------------------------ save

$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  const family = people();
  if (!family.length) return toast("Add at least one person", true);
  if (!family.some(p => !p.is_kid)) return toast("Add at least one adult", true);
  if (f.pin.value !== f.pin2.value) return toast("The two PINs don't match", true);
  const btn = f.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    await api("/api/setup", { method: "POST", body: {
      family_name: f.family_name.value, people: family, pin: f.pin.value,
      holiday_country: f.holiday_country.value, holiday_subdiv: f.holiday_subdiv.value,
      latitude: place?.latitude || "", longitude: place?.longitude || "", temp_unit: f.temp_unit.value,
      public_url: f.public_url.value,
    } });
    location.href = "/";
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
});

$("#add-person").addEventListener("click", () => personRow({ is_kid: $("#people").children.length >= 2 }));
$("[name=holiday_country]").addEventListener("change", e => fillSubdivs(e.target.value));
let searchTimer;
$("[name=city]").addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchCity(e.target.value.trim()), 350);
});

(async () => {
  try {
    const info = await api("/api/setup");
    if (!info.needed) return (location.href = "/");
    if (!info.from_home) return ($("#not-home").hidden = false);
    $("#tz").textContent = info.timezone;
    countries = await api("/api/setup/countries");
    $("[name=holiday_country]").innerHTML = `<option value="">None</option>` +
      countries.map(c => `<option value="${esc(c.code)}">${esc(c.name)}</option>`).join("");
    personRow({});
    personRow({});
    personRow({ is_kid: true });
    $("#setup-form").hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
})();
