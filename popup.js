"use strict";

/* ---------- storage (chrome.storage.sync, with a localStorage fallback for previewing) ---------- */
const DEFAULTS = {
  main: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  hour12: true,
  theme: "auto", // light | dark | auto
  zones: []      // [{ id, name, tz }]
};
const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync;

const store = {
  get() {
    if (hasChrome) return new Promise(r => chrome.storage.sync.get(DEFAULTS, r));
    try { return Promise.resolve({ ...DEFAULTS, ...JSON.parse(localStorage.getItem("clientclock") || "{}") }); }
    catch { return Promise.resolve({ ...DEFAULTS }); }
  },
  set(state) {
    if (hasChrome) return new Promise(r => chrome.storage.sync.set(state, r));
    try { localStorage.setItem("clientclock", JSON.stringify(state)); } catch {}
    return Promise.resolve();
  }
};

/* ---------- time helpers ---------- */
const ALL_ZONES = (() => {
  try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC"]; }
})();
const ZONE_SET = new Set([...ALL_ZONES, "UTC"]);
const partsCache = new Map();

function zoneParts(tz, date) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    partsCache.set(tz, f);
  }
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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12
  }).formatToParts(date);
  let time = "", period = "";
  for (const x of parts) {
    if (x.type === "dayPeriod") period = x.value;
    else if (x.type !== "literal" || !/^\s+$/.test(x.value)) time += x.value;
  }
  return { time: time.trim(), period };
}

function formatDate(tz, date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric"
  }).format(date);
}

function shortZone(tz, date) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(date);
    return (p.find(x => x.type === "timeZoneName") || {}).value || "";
  } catch { return ""; }
}

function cityOf(tz) {
  const last = tz.split("/").pop();
  return last.replace(/_/g, " ");
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

/* ---------- icons ---------- */
const SUN = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>';
const MOON = '<svg viewBox="0 0 16 16"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3Z"/></svg>';

/* ---------- state & DOM ---------- */
let state = { ...DEFAULTS };
const $ = id => document.getElementById(id);
const els = {
  hero: $("hero"), mainCity: $("mainCity"), mainChip: $("mainChip"),
  mainTime: $("mainTime"), mainAmpm: $("mainAmpm"), mainDate: $("mainDate"),
  list: $("list"), empty: $("empty"),
  settings: $("settings"), settingsBtn: $("settingsBtn"),
  mainInput: $("mainInput"), mainError: $("mainError"),
  addForm: $("addForm"), addBtn: $("addBtn"), foot: $("foot"),
  nameInput: $("nameInput"), tzInput: $("tzInput"), addError: $("addError"), cancelAdd: $("cancelAdd")
};

function save() { return store.set(state); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderList() {
  els.empty.hidden = state.zones.length > 0;
  els.list.innerHTML = state.zones.map(z => `
    <article class="card" data-id="${esc(z.id)}" data-tz="${esc(z.tz)}">
      <div class="card-main">
        <button type="button" class="name" title="Click to rename">${esc(z.name || cityOf(z.tz))}</button>
        <span class="meta"></span>
      </div>
      <div class="card-time">
        <div class="t"></div>
        <div class="diff"></div>
      </div>
      <button type="button" class="remove" aria-label="Remove ${esc(z.name || cityOf(z.tz))}">&times;</button>
    </article>`).join("");
  tick();
}

function tick() {
  const now = new Date();
  const main = state.main;
  const mainNight = isNight(main, now);

  // theme
  const theme = state.theme === "auto" ? (mainNight ? "dark" : "light") : state.theme;
  document.documentElement.dataset.theme = theme;

  // hero
  const ft = formatTime(main, now, state.hour12);
  els.mainTime.textContent = ft.time;
  els.mainAmpm.textContent = ft.period;
  els.mainCity.textContent = cityOf(main);
  els.mainDate.textContent = formatDate(main, now);
  els.hero.classList.toggle("night", mainNight);
  els.mainChip.innerHTML = (mainNight ? MOON : SUN) + (mainNight ? "Night" : "Day");

  // cards
  for (const card of els.list.children) {
    const tz = card.dataset.tz;
    const night = isNight(tz, now);
    card.classList.toggle("night", night);
    const t = formatTime(tz, now, state.hour12);
    card.querySelector(".t").innerHTML = esc(t.time) + (t.period ? `<small>${esc(t.period)}</small>` : "");
    const d = diffLabel(tz, main, now);
    card.querySelector(".diff").innerHTML =
      `<span class="${d.ahead ? "ahead" : ""}">${esc(d.text)}</span>` +
      (d.day ? `<span>&middot; ${d.day}</span>` : "") +
      `<span class="state" title="${night ? "Night" : "Day"} there">${night ? MOON : SUN}</span>`;
    const abbr = shortZone(tz, now);
    card.querySelector(".meta").textContent = cityOf(tz) + (abbr ? " · " + abbr : "");
  }
}

function syncControls() {
  els.mainInput.value = state.main;
  document.querySelectorAll(".seg").forEach(seg => {
    const key = seg.dataset.key;
    seg.querySelectorAll("button").forEach(b => {
      b.setAttribute("aria-pressed", String(String(state[key]) === b.dataset.v));
    });
  });
}

/* ---------- interactions ---------- */
els.settingsBtn.addEventListener("click", () => {
  const open = els.settings.hidden;
  els.settings.hidden = !open;
  els.settingsBtn.setAttribute("aria-expanded", String(open));
  els.settingsBtn.textContent = open ? "Done" : "Settings";
  if (open) syncControls();
});

document.querySelectorAll(".seg").forEach(seg => {
  seg.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    const key = seg.dataset.key;
    state[key] = key === "hour12" ? b.dataset.v === "true" : b.dataset.v;
    syncControls(); tick(); save();
  });
});

els.mainInput.addEventListener("change", () => {
  const v = els.mainInput.value.trim();
  if (!ZONE_SET.has(v)) { els.mainError.hidden = false; return; }
  els.mainError.hidden = true;
  state.main = v; tick(); save();
});

function openAdd(open) {
  els.addForm.hidden = !open;
  els.foot.hidden = open;
  els.addError.hidden = true;
  if (open) { els.nameInput.value = ""; els.tzInput.value = ""; els.nameInput.focus(); }
}
els.addBtn.addEventListener("click", () => openAdd(true));
els.cancelAdd.addEventListener("click", () => openAdd(false));

els.addForm.addEventListener("submit", e => {
  e.preventDefault();
  const tz = els.tzInput.value.trim();
  if (!ZONE_SET.has(tz)) { els.addError.hidden = false; els.tzInput.focus(); return; }
  const name = els.nameInput.value.trim() || cityOf(tz);
  state.zones = [...state.zones, { id: Date.now().toString(36), name, tz }];
  save(); renderList(); openAdd(false);
  els.list.scrollTop = els.list.scrollHeight;
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
      if (keep) { zone.name = input.value.trim() || cityOf(zone.tz); save(); }
      renderList();
    };
    input.addEventListener("keydown", ev => {
      if (ev.key === "Enter") commit(true);
      if (ev.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }
});

// keep in sync if changed from another open window
if (hasChrome) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const k in changes) state[k] = changes[k].newValue;
    renderList(); syncControls();
  });
}

/* ---------- start ---------- */
(async function init() {
  // datalist: value = IANA name, label = readable city
  els.tzList = document.getElementById("tzList");
  els.tzList.innerHTML = [...ZONE_SET].map(z => `<option value="${esc(z)}">${esc(cityOf(z))}</option>`).join("");

  state = await store.get();
  if (!ZONE_SET.has(state.main)) state.main = "UTC";
  syncControls();
  renderList();
  setInterval(tick, 1000);
})();
