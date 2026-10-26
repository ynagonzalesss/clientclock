"use strict";

/* ---------- storage (chrome.storage.sync, with a localStorage fallback for previewing) ---------- */
const DEFAULTS = {
  main: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  mainPlace: "",
  hour12: true,
  theme: "auto",        // light | dark | auto
  palette: "blush",     // blush | sage | slate | sand | graphite
  nameFont: "cormorant",// cormorant | playfair | fraunces | dancing | outfit
  seenVersion: "",
  zones: []             // [{ id, name, tz, place }]
};
const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync;
const VERSION = (hasChrome && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : "1.1.0";
const PALETTES = { blush: "Blush", sage: "Sage", slate: "Slate", sand: "Sand", graphite: "Graphite" };
const FONTS = { cormorant: "Cormorant", playfair: "Playfair", fraunces: "Fraunces", dancing: "Dancing Script", outfit: "Outfit" };

const store = {
  raw() {
    if (hasChrome) return new Promise(r => chrome.storage.sync.get(null, r));
    try { return Promise.resolve(JSON.parse(localStorage.getItem("clientclock") || "{}")); }
    catch { return Promise.resolve({}); }
  },
  set(state) {
    if (hasChrome) return new Promise(r => chrome.storage.sync.set(state, r));
    try { localStorage.setItem("clientclock", JSON.stringify(state)); } catch {}
    return Promise.resolve();
  }
};

/* ---------- time helpers ---------- */
const fmtCache = new Map();
function fmt(key, opts) {
  let f = fmtCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat("en-US", opts); fmtCache.set(key, f); }
  return f;
}
function validZone(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

function zoneParts(tz, date) {
  const f = fmt("parts|" + tz, {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

// minutes east of UTC for a zone at a moment
function offsetMin(tz, date) {
  const p = zoneParts(tz, date);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function isNight(tz, date) {
  const h = zoneParts(tz, date).h;
  return h < 6 || h >= 18;
}

function formatTime(tz, date, hour12) {
  const parts = fmt(`time|${tz}|${hour12}`, { timeZone: tz, hour: "numeric", minute: "2-digit", hour12 }).formatToParts(date);
  let time = "", period = "";
  for (const x of parts) {
    if (x.type === "dayPeriod") period = x.value;
    else if (x.type !== "literal" || !/^\s+$/.test(x.value)) time += x.value;
  }
  return { time: time.trim(), period };
}

function formatDate(tz, date) {
  return fmt("date|" + tz, { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(date);
}

function zoneName(tz, date, style) {
  try {
    const p = fmt(`zn|${tz}|${style}`, { timeZone: tz, timeZoneName: style }).formatToParts(date);
    return (p.find(x => x.type === "timeZoneName") || {}).value || "";
  } catch { return ""; }
}

function dayIndex(tz, date) {
  const p = zoneParts(tz, date);
  return Math.floor(Date.UTC(p.y, p.mo - 1, p.d) / 86400000);
}

function diffLabel(tz, main, date) {
  const m = offsetMin(tz, date) - offsetMin(main, date);
  const dayDelta = dayIndex(tz, date) - dayIndex(main, date);
  const day = dayDelta > 0 ? "Tomorrow" : dayDelta < 0 ? "Yesterday" : "";
  if (m === 0) return { text: "Same time", day, ahead: false };
  const abs = Math.abs(m), h = Math.floor(abs / 60), mm = abs % 60;
  const amount = (h ? h + "h" : "") + (h && mm ? " " : "") + (mm ? mm + "m" : "");
  return { text: amount + (m > 0 ? " ahead" : " behind"), day, ahead: m > 0 };
}

/* ---------- place search ---------- */
const norm = s => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const cityOf = tz => tz.split("/").pop().replace(/_/g, " ");
const modernTz = tz => TZ_LEGACY[tz] || tz;
const COUNTRY_ZONES = {};
const PLACE_BY_TZ = {};
for (const [tz, city, cc, note] of TZ_PLACES) {
  (COUNTRY_ZONES[cc] = COUNTRY_ZONES[cc] || []).push(tz);
  PLACE_BY_TZ[tz] = { city, cc, note };
}
const countryName = cc => (TZ_COUNTRIES[cc] || [cc])[0];

function placeLabel(tz) {
  const p = PLACE_BY_TZ[modernTz(tz)];
  if (!p) return tz === "UTC" ? "UTC" : cityOf(tz);
  return `${p.city}, ${countryName(p.cc)}`;
}

let INDEX = null;
function buildIndex() {
  // popular zones get a boost; earlier in the list = slightly higher (so a country lists its main zones first)
  const rank = new Map(TZ_POPULAR.map((tz, i) => [tz, 15 + (TZ_POPULAR.length - i) * 0.02]));
  const popular = { has: tz => rank.has(tz) };
  INDEX = [];
  for (const [tz, city, cc, note] of TZ_PLACES) {
    const multi = COUNTRY_ZONES[cc].length > 1;
    INDEX.push({
      tz, title: `${city}, ${countryName(cc)}`, sub: multi ? note : "", place: `${city}, ${countryName(cc)}`,
      keys: [norm(city), ...TZ_COUNTRIES[cc].map(norm)], minor: note ? [norm(note)] : [],
      boost: (rank.get(tz) || 0) - (tz.startsWith("Antarctica/") ? 30 : 0)
    });
  }
  for (const [term, tz, title, sub] of TZ_ALIASES) {
    const isAbbr = /^[A-Z]{2,5} · /.test(title);
    INDEX.push({
      tz, title, sub, keys: [norm(term)], minor: [],
      place: isAbbr ? title.split(" · ")[1] : title,
      boost: (popular.has(tz) ? 8 : 0) + (sub === "Capital" ? 5 : 0)
    });
  }
}

function scoreKey(k, q) {
  if (k === q) return 100;
  if (k.startsWith(q)) return 80 - Math.min(10, (k.length - q.length) * 0.3);
  if ((" " + k).includes(" " + q)) return 60;
  if (q.length >= 3 && k.includes(q)) return 30;
  return 0;
}

function search(query) {
  if (!INDEX) buildIndex();
  const q = norm(query);
  if (!q) return [];
  const scored = [];
  for (const e of INDEX) {
    let s = 0;
    for (const k of e.keys) s = Math.max(s, scoreKey(k, q));
    for (const k of e.minor) s = Math.max(s, scoreKey(k, q) * 0.6);
    if (s > 0) scored.push([s + e.boost, e]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title));
  const seen = new Set(), out = [];
  for (const [, e] of scored) {
    const key = e.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(e);
    if (out.length >= 30) break;
  }
  return out;
}

function attachSearch(input, list, onPick) {
  let results = [], active = 0;
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const render = () => {
    if (!input.value.trim()) { close(); return; }
    const now = new Date();
    list.innerHTML = results.length ? results.map((e, i) => {
      const off = zoneName(e.tz, now, "shortOffset") || "GMT";
      const t = formatTime(e.tz, now, state.hour12);
      const sub = [e.sub, off, `${t.time}${t.period ? " " + t.period : ""}`].filter(Boolean).join(" · ");
      return `<div role="option" id="${list.id}-${i}" aria-selected="${i === active}" data-i="${i}">
        <span class="opt-title">${esc(e.title)}</span><span class="opt-sub">${esc(sub)}</span></div>`;
    }).join("") : `<div class="no-results">No match. Try a country, a big city, or EST/PST.</div>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", results.length ? `${list.id}-${active}` : "");
    const el = list.querySelector('[aria-selected="true"]');
    if (el) el.scrollIntoView({ block: "nearest" });
  };
  const pick = i => {
    const e = results[i]; if (!e) return;
    input.value = e.title;
    input.dataset.tz = e.tz;
    input.dataset.place = e.place;
    close();
    onPick && onPick(e);
  };
  input.addEventListener("input", () => {
    delete input.dataset.tz; delete input.dataset.place;
    results = search(input.value); active = 0; render();
  });
  input.addEventListener("keydown", ev => {
    if (list.hidden && ev.key === "ArrowDown" && input.value.trim()) { results = search(input.value); render(); return; }
    if (list.hidden) return;
    if (ev.key === "ArrowDown") { ev.preventDefault(); active = Math.min(active + 1, results.length - 1); render(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (ev.key === "Enter") { if (results.length) { ev.preventDefault(); pick(active); } }
    else if (ev.key === "Escape") { ev.preventDefault(); close(); }
  });
  list.addEventListener("mousedown", ev => {
    const o = ev.target.closest('[role="option"]');
    if (o) { ev.preventDefault(); pick(+o.dataset.i); }
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
  return { close };
}

/* ---------- icons ---------- */
const SUN = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>';
const MOON = '<svg viewBox="0 0 16 16"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3Z"/></svg>';

/* ---------- state & DOM ---------- */
let state = { ...DEFAULTS };
const $ = id => document.getElementById(id);
const els = {
  hero: $("hero"), mainCity: $("mainCity"), mainChip: $("mainChip"),
  mainTime: $("mainTime"), mainAmpm: $("mainAmpm"), mainDate: $("mainDate"),
  list: $("list"), empty: $("empty"), news: $("news"), newsOk: $("newsOk"),
  settings: $("settings"), settingsBtn: $("settingsBtn"),
  mainInput: $("mainInput"), mainResults: $("mainResults"),
  paletteName: $("paletteName"), fontName: $("fontName"),
  addForm: $("addForm"), addBtn: $("addBtn"), foot: $("foot"),
  nameInput: $("nameInput"), tzInput: $("tzInput"), addResults: $("addResults"),
  addError: $("addError"), cancelAdd: $("cancelAdd")
};

function save() { return store.set(state); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function zonePlace(z) { return z.place || placeLabel(z.tz); }

function applyLook(night) {
  const root = document.documentElement;
  root.dataset.theme = state.theme === "auto" ? (night ? "dark" : "light") : state.theme;
  root.dataset.palette = PALETTES[state.palette] ? state.palette : "blush";
  root.dataset.font = FONTS[state.nameFont] ? state.nameFont : "cormorant";
}

function renderList() {
  els.empty.hidden = state.zones.length > 0;
  els.list.innerHTML = state.zones.map(z => `
    <article class="card" data-id="${esc(z.id)}" data-tz="${esc(z.tz)}">
      <div class="card-main">
        <button type="button" class="name" title="Click to rename">${esc(z.name || zonePlace(z).split(",")[0])}</button>
        <span class="meta"></span>
      </div>
      <div class="card-time">
        <div class="t"></div>
        <div class="diff"></div>
      </div>
      <button type="button" class="remove" aria-label="Remove ${esc(z.name || zonePlace(z))}">&times;</button>
    </article>`).join("");
  tick();
}

function tick() {
  const now = new Date();
  const main = state.main;
  const mainNight = isNight(main, now);
  applyLook(mainNight);

  const ft = formatTime(main, now, state.hour12);
  els.mainTime.textContent = ft.time;
  els.mainAmpm.textContent = ft.period;
  els.mainCity.textContent = (state.mainPlace || placeLabel(main)).split(",")[0];
  els.mainDate.textContent = formatDate(main, now);
  els.hero.classList.toggle("night", mainNight);
  els.mainChip.innerHTML = (mainNight ? MOON : SUN) + (mainNight ? "Night" : "Day");

  for (const card of els.list.children) {
    const tz = card.dataset.tz;
    const zone = state.zones.find(z => z.id === card.dataset.id);
    const night = isNight(tz, now);
    card.classList.toggle("night", night);
    const t = formatTime(tz, now, state.hour12);
    card.querySelector(".t").innerHTML = esc(t.time) + (t.period ? `<small>${esc(t.period)}</small>` : "");
    const d = diffLabel(tz, main, now);
    card.querySelector(".diff").innerHTML =
      `<span class="${d.ahead ? "ahead" : ""}">${esc(d.text)}</span>` +
      (d.day ? `<span>&middot; ${d.day}</span>` : "") +
      `<span class="state" title="${night ? "Night" : "Day"} there">${night ? MOON : SUN}</span>`;
    const abbr = zoneName(tz, now, "short");
    const place = zone ? zonePlace(zone) : placeLabel(tz);
    card.querySelector(".meta").textContent = place + (abbr ? " · " + abbr : "");
  }
}

function syncControls() {
  if (document.activeElement !== els.mainInput) els.mainInput.value = state.mainPlace || placeLabel(state.main);
  document.querySelectorAll("[data-key]").forEach(group => {
    const key = group.dataset.key;
    group.querySelectorAll("button").forEach(b => {
      b.setAttribute("aria-pressed", String(String(state[key]) === b.dataset.v));
    });
  });
  els.paletteName.textContent = "· " + (PALETTES[state.palette] || "Blush");
  els.fontName.textContent = "· " + (FONTS[state.nameFont] || "Cormorant");
}

/* ---------- interactions ---------- */
els.settingsBtn.addEventListener("click", () => {
  const open = els.settings.hidden;
  els.settings.hidden = !open;
  els.settingsBtn.setAttribute("aria-expanded", String(open));
  els.settingsBtn.textContent = open ? "Done" : "Settings";
  if (open) syncControls();
});

document.querySelectorAll("[data-key]").forEach(group => {
  group.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    const key = group.dataset.key;
    state[key] = key === "hour12" ? b.dataset.v === "true" : b.dataset.v;
    syncControls(); renderList(); save();
  });
});

attachSearch(els.mainInput, els.mainResults, e => {
  state.main = e.tz; state.mainPlace = e.place;
  tick(); save();
});
els.mainInput.addEventListener("blur", () => setTimeout(() => {
  if (!els.mainInput.dataset.tz) els.mainInput.value = state.mainPlace || placeLabel(state.main);
}, 150));

function openAdd(open) {
  els.addForm.hidden = !open;
  els.foot.hidden = open;
  els.addError.hidden = true;
  if (open) {
    els.nameInput.value = ""; els.tzInput.value = "";
    delete els.tzInput.dataset.tz; delete els.tzInput.dataset.place;
    els.nameInput.focus();
  }
}
els.addBtn.addEventListener("click", () => openAdd(true));
els.cancelAdd.addEventListener("click", () => openAdd(false));
attachSearch(els.tzInput, els.addResults, () => { els.addError.hidden = true; });

els.addForm.addEventListener("submit", e => {
  e.preventDefault();
  let tz = els.tzInput.dataset.tz, place = els.tzInput.dataset.place;
  if (!tz && els.tzInput.value.trim()) {           // typed but didn't pick: take the best match
    const best = search(els.tzInput.value)[0];
    if (best) { tz = best.tz; place = best.place; }
  }
  if (!tz || !validZone(tz)) { els.addError.hidden = false; els.tzInput.focus(); return; }
  const name = els.nameInput.value.trim() || place.split(",")[0];
  state.zones = [...state.zones, { id: Date.now().toString(36), name, tz, place }];
  save(); renderList(); openAdd(false);
});

els.list.addEventListener("click", e => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.closest(".remove")) {
    state.zones = state.zones.filter(z => z.id !== id);
    save(); renderList();
    return;
  }

  const nameBtn = e.target.closest(".name");
  if (nameBtn) {
    const zone = state.zones.find(z => z.id === id);
    const input = document.createElement("input");
    input.className = "name-input";
    input.maxLength = 40;
    input.value = zone.name;
    nameBtn.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = keep => {
      if (done) return; done = true;
      if (keep) { zone.name = input.value.trim() || zonePlace(zone).split(",")[0]; save(); }
      renderList();
    };
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") commit(true);
      if (ev.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }
});

els.newsOk.addEventListener("click", () => {
  els.news.hidden = true;
  state.seenVersion = VERSION; save();
});

// keep in sync if changed from another open window
if (hasChrome) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k in changes) if (k in DEFAULTS) state[k] = changes[k].newValue;
    renderList(); syncControls();
  });
}

/* ---------- start ---------- */
(async function init() {
  const raw = await store.raw();
  const isNewInstall = Object.keys(raw).length === 0;
  state = { ...DEFAULTS, ...raw };
  if (!validZone(state.main)) state.main = "UTC";
  state.zones = (state.zones || []).filter(z => z && validZone(z.tz));

  if (isNewInstall) { state.seenVersion = VERSION; save(); }
  else if (state.seenVersion !== VERSION && VERSION.startsWith("1.1")) els.news.hidden = false;

  syncControls();
  renderList();
  setInterval(tick, 1000);
})();
