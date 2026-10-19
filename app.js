/* Shared dashboard code for every tracker. Each app page (index.html for Jeff, max/index.html for Max)
   sets window.PKT before loading this file:
     owner      "Jeff"                         → "Jeff's Pokémon Tracker"
     sheetName  "Pokemon tracker Jeff"         → shown in the app
     sheetId    Google Sheet ID                → the app only accepts data from this sheet
     who        ""  or "max"                   → which sheet the Apps Script reads (?who=max)
     photos     "sealed/"                      → folder holding photos.json and your own photos
     store      "pkt" / "pkt-max"              → prefix for what the app saves on the phone (keeps apps apart)
     fallback   true                           → if never loaded, show the old Apps Script page instead
     api        Apps Script /exec link         → optional: this tracker's own data link (default: Jeff's) */
const CFG = Object.assign({owner:"Jeff", sheetName:"Pokemon tracker Jeff", sheetId:"", who:"", photos:"sealed/", store:"pkt", fallback:false}, window.PKT || {});
const SHEET_ID = CFG.sheetId;
const SHEET_URL = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/edit";
// The Apps Script web app. "?data=1" returns the sheet as data; without it, the old all-in-one page.
// A page can use its own Apps Script link (api) — Max's tracker has one — otherwise Jeff's is used.
const API = CFG.api || "https://script.google.com/macros/s/AKfycbxkjs8M4ngqGeTfGU3787LDaHR_14qMyPYEdk3aiF5iLovlu1aQYs9Db_NTbfosv2jQCA/exec";
const CACHE_KEY = CFG.store + "-data";
const TAB_KEY = CFG.store + "-tab";
const KEYS = ["collection","storage","grading","log","history"];
const TIERS = [
  {k:"top", label:"Top loaders", sub:"$20+ · penny sleeve + 35pt"},
  {k:"binder", label:"Binder", sub:"$2–19.99 · Vault X 9-pocket"},
  {k:"bulk", label:"Bulk box", sub:"Under $2 · 3,600-count"},
  {k:"sealed", label:"Sealed", sub:"Sealed shelf"}
];
const S = {data:{}, err:{}, at:{}, tab:"overview", q:"", filter:"all", sort:"value", page:null, mode:"loading", busy:false};

try { const t = localStorage.getItem(TAB_KEY); if (t) S.tab = t; } catch(e) {}

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = v => { const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; };
const usd = n => n.toLocaleString("en-US", {style:"currency", currency:"USD"});
const usd0 = n => n.toLocaleString("en-US", {style:"currency", currency:"USD", maximumFractionDigits:0});
const int = n => Math.round(n).toLocaleString("en-US");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function tierOf(loc){
  const l = String(loc||"");
  if (/^buffer/i.test(l) || /top loader/i.test(l)) return "top";
  if (/^binder/i.test(l)) return "binder";
  if (/^bulk/i.test(l)) return "bulk";
  if (/sealed/i.test(l)) return "sealed";
  return "other";
}
function ago(ts){
  if (!ts) return "";
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "Updated just now";
  if (m < 60) return "Updated " + m + " min ago";
  const h = Math.round(m / 60);
  return h < 24 ? "Updated " + h + " hr ago" : "Updated " + new Date(ts).toLocaleDateString();
}

/* ---------- card pictures ---------- */
/* Card pictures come from TCGdex (free card database), matched by set name + card number.
   Your own photos (photos.json in the CFG.photos folder, e.g. sealed/photos.json) come first: sealed items by name, single cards by
   "Name Number" (e.g. "Tyrunt 070"). Sealed items without a photo show the set's logo.
   The set list and each set's card list are saved on the phone so they load once. */
const TCG = "https://api.tcgdex.net/v2/en";
const IMG = {sets:null, logos:{}, photos:null, maps:{}, names:{}, loading:{}};
const normName = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const normSet = s => String(s || "").replace(/\(.*?\)/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const numKey = n => { const x = String(n || "").split("/")[0].trim().toLowerCase().replace(/\s+/g, ""); return /^\d+$/.test(x) ? String(+x) : x; };
const hasPic = r => r.tier !== "sealed" && r.num && !/mixed/i.test(r.num) && !/\(count\)/i.test(r.name);
const picAttrs = r => hasPic(r) ? ` data-set="${esc(r.set)}" data-num="${esc(r.num)}" data-name="${esc(r.name)}"`
  : r.tier === "sealed" ? ` data-sealed="${esc(r.name)}" data-lset="${esc(r.set)}"` : "";
function cacheGet(k, maxAge){ try { const v = JSON.parse(localStorage.getItem(k) || "null"); if (v && Date.now() - v.t < maxAge) return v.d; } catch(e) {} return null; }
function cachePut(k, d){ try { localStorage.setItem(k, JSON.stringify({t:Date.now(), d})); } catch(e) {} }
async function getJSON(url){ const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json(); }
function setIdFor(name){
  const n = normSet(name);
  if (!n || !IMG.sets) return null;
  return IMG.sets[n] || (n.endsWith("blackstarpromos") && IMG.sets[n.replace(/blackstarpromos$/, "pblackstarpromos")]) || null;
}
// undefined = not known yet, null = no picture, string = picture address
function lookup(set, num){
  if (!IMG.sets) return undefined;
  const id = setIdFor(set);
  if (!id) return null;
  const m = IMG.maps[id];
  return m ? (m[numKey(num)] || null) : undefined;
}
function loadSets(){
  if (IMG.sets) return Promise.resolve();
  return IMG.loading._sets || (IMG.loading._sets = (async () => {
    let idx = cacheGet("pkt-tcg-sets2", 7 * 864e5);
    if (!idx) {
      try {
        idx = {ids:{}, logos:{}};
        for (const x of await getJSON(TCG + "/sets")) {
          const k = normSet(x.name);
          if (!k || idx.ids[k]) continue;
          idx.ids[k] = x.id;
          if (x.logo) idx.logos[k] = x.logo;
        }
        cachePut("pkt-tcg-sets2", idx);
      } catch(e) { idx = {ids:{}, logos:{}}; }
    }
    IMG.sets = idx.ids; IMG.logos = idx.logos;
  })());
}
function loadSet(id){
  if (IMG.maps[id]) return Promise.resolve();
  return IMG.loading[id] || (IMG.loading[id] = (async () => {
    let m = cacheGet("pkt-tcg-set-" + id, 14 * 864e5);
    if (!m) {
      try {
        m = {};
        for (const c of (await getJSON(TCG + "/sets/" + encodeURIComponent(id))).cards || []) if (c.image) m[numKey(c.localId)] = c.image;
        cachePut("pkt-tcg-set-" + id, m);
      } catch(e) { m = {}; }
    }
    IMG.maps[id] = m;
  })());
}
// Backup match: same card name + number in any set (stamps like "(Eevee Stamp)" are ignored).
const cardName = n => String(n || "").replace(/\(.*?\)/g, "").trim();
function lookupByName(name, num){
  const L = IMG.names[normName(cardName(name))];
  return L === undefined ? undefined : (L[numKey(num)] || null);
}
function loadName(name){
  const k = normName(cardName(name));
  if (!k || IMG.names[k]) return Promise.resolve();
  return IMG.loading["n:" + k] || (IMG.loading["n:" + k] = (async () => {
    let m = cacheGet("pkt-tcg-name-" + k, 14 * 864e5);
    if (!m) {
      try {
        m = {};
        for (const c of await getJSON(TCG + "/cards?name=eq:" + encodeURIComponent(cardName(name)))) {
          const nk = numKey(c.localId);
          if (c.image && !m[nk]) m[nk] = c.image;
        }
        cachePut("pkt-tcg-name-" + k, m);
      } catch(e) { m = {}; }
    }
    IMG.names[k] = m;
  })());
}
function loadPhotos(){
  if (IMG.photos) return Promise.resolve();
  return IMG.loading._photos || (IMG.loading._photos = fetch(CFG.photos + "photos.json", {cache:"no-cache"})
    .then(r => r.ok ? r.json() : {}).catch(() => ({}))
    .then(m => { IMG.photos = {}; for (const k in m) IMG.photos[normName(k)] = CFG.photos + m[k]; }));
}
// Sealed item: {url, logo} or null; undefined = not known yet
function lookupSealed(name, set){
  if (!IMG.photos || !IMG.sets) return undefined;
  const ph = IMG.photos[normName(name)];
  if (ph) return {url:ph, logo:false};
  const lg = IMG.logos[normSet(set)];
  return lg ? {url:lg + ".webp", logo:true} : null;
}
function putImg(el, url, logo){
  const img = new Image();
  img.alt = ""; img.decoding = "async"; img.loading = "lazy";
  img.onload = () => el.classList.add("has-img");
  if (logo) el.classList.add("logo");
  img.src = url;
  el.appendChild(img);
}
// Fills in every picture box on screen; fetches what it doesn't know yet, then runs again.
function hydrate(root){
  root = root || document;
  const need = new Set(), needNames = new Set();
  let wantSealed = false;
  root.querySelectorAll("[data-set][data-num]:not([data-done])").forEach(el => {
    if (!IMG.photos) { wantSealed = true; return; }
    const own = IMG.photos[normName(cardName(el.dataset.name) + " " + String(el.dataset.num).split("/")[0])];
    if (own) { el.dataset.done = "1"; putImg(el, own, false); return; }
    let u = lookup(el.dataset.set, el.dataset.num);
    if (u === undefined) { need.add(el.dataset.set); return; }
    if (!u && el.dataset.name) {
      u = lookupByName(el.dataset.name, el.dataset.num);
      if (u === undefined) { needNames.add(el.dataset.name); return; }
    }
    el.dataset.done = "1";
    if (u) putImg(el, u + "/" + (el.dataset.size || "low") + ".webp", false);
  });
  root.querySelectorAll("[data-sealed]:not([data-done])").forEach(el => {
    const u = lookupSealed(el.dataset.sealed, el.dataset.lset);
    if (u === undefined) { wantSealed = true; return; }
    el.dataset.done = "1";
    if (u) putImg(el, u.url, u.logo);
  });
  if (!need.size && !needNames.size && !wantSealed) return;
  Promise.all([loadSets(), wantSealed ? loadPhotos() : null])
    .then(() => Promise.all([...need].map(n => { const id = setIdFor(n); return id ? loadSet(id) : null; }).concat([...needNames].map(loadName))))
    .then(() => hydrate(root));
}

/* ---------- card details ---------- */
// TCGplayer search for the current price: singles by "Name Number" (e.g. "Tyrunt 070"), sealed by name.
function priceUrl(r){
  if (!r || /\(count\)/i.test(r.name)) return "";
  const num = String(r.num || "").split("/")[0].trim();
  const base = r.tier === "sealed" ? r.name : cardName(r.name);
  const q = (base + (r.tier !== "sealed" && num && !/mixed/i.test(num) ? " " + num : "")).replace(/[\[\]]/g, " ").replace(/\s+/g, " ").trim();
  return q ? "https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&view=grid&q=" + encodeURIComponent(q) : "";
}
function openDetail(i){
  const r = (S.data.collection || [])[i];
  const d = $("detail");
  if (!r || !d) return;
  const row = (k, v) => v ? `<div><div class="k">${k}</div><div class="v">${esc(v)}</div></div>` : "";
  d.innerHTML = `<div class="dhead"><button class="btn" type="button" id="dclose">Close</button></div>
    <div class="dimg"${picAttrs(r)} data-size="high"></div>
    <div class="dbody">
      <div><h2>${esc(r.name)}</h2><div class="note">${esc(r.set)}${r.num ? " · " + esc(r.num) : ""}${r.rarity ? " · " + esc(r.rarity) : ""}</div></div>
      <div class="gtbl">
        <div><div class="k">Price</div><div class="v">${usd(r.price)}</div></div>
        <div><div class="k">Qty</div><div class="v">${int(r.qty)}</div></div>
        <div><div class="k">Total</div><div class="v">${usd(r.total)}</div></div>
      </div>
      ${priceUrl(r) ? `<a class="btn primary" href="${priceUrl(r)}" target="_blank" rel="noopener" style="justify-content:center;text-decoration:none;padding:9px 12px">Check price on TCGplayer ↗</a>` : ""}
      <div class="loc" style="display:flex;flex-wrap:wrap;gap:6px"><span class="pin t-${r.tier}"><i></i>${esc(r.loc || "No location")}</span>${r.sleeve ? '<span class="flag">Needs penny sleeve</span>' : ""}</div>
      <div class="gtbl">${row("Condition", r.cond)}${row("Protection", r.prot)}${row("Added", r.date)}${row("Status", r.status)}${row("Check", r.check)}${row("Category", r.cat)}</div>
      ${hasPic(r) ? '<p class="note" style="margin:0">Card picture from TCGdex, matched by set and number.</p>' : r.tier === "sealed" ? '<p class="note" style="margin:0">Shows your photo if you\'ve added one, otherwise the set logo.</p>' : ""}
    </div>`;
  $("dclose").onclick = () => d.close();
  d.onclick = e => { if (e.target === d) d.close(); };
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
  hydrate(d);
}

/* ---------- parsing ---------- */
function parse(key, rows){
  const body = rows.slice(1).filter(r => r && r.length && String(r[0]||"").trim());
  if (key === "collection") return body.map((r, i) => {
    const qty = money(r[6]) || 1, price = money(r[7]);
    const total = r[11] ? money(r[11]) : qty * price;
    const m = String(r[9]||"").match(/P\s*(\d+)\s*S\s*(\d+)/i);
    return {i, name:r[0], set:r[1]||"", num:r[2]||"", rarity:r[3]||"", cat:r[4]||"", cond:r[5]||"",
      qty, price, total, date:r[8]||"", loc:r[9]||"", prot:r[10]||"", rec:r[12]||"", req:r[13]||"",
      status:r[14]||"", check:r[15]||"", tier:tierOf(r[9]), page:m?+m[1]:null, slot:m?+m[2]:null,
      sleeve:/^upgrade/i.test(String(r[15]||""))};
  });
  if (key === "storage") {
    const units = [], spots = [];
    let inSpots = false;
    for (const r of rows.slice(1)) {
      if (!r || !r.length || !String(r[0]||"").trim()) continue;
      if (/next open spot/i.test(r[0])) { inSpots = true; continue; }
      if (inSpots) spots.push({label:r[0], loc:r[1]||""});
      else units.push({unit:r[0], spec:r[1]||"", rule:r[2]||"", count:money(r[3]), max:money(r[4]), status:r[7]||""});
    }
    return {units, spots};
  }
  if (key === "grading") return body.map(r => ({name:r[0], set:r[1]||"", num:r[2]||"", raw:money(r[3]), p10:money(r[4]), p9:money(r[5]), p8:money(r[6]),
      net10:money(r[7]), net9:money(r[8]), rec:String(r[9]||"").toUpperCase(), ai:r[10]||"", hands:r[11]||"", send:r[12]||"", step:r[13]||"", grade:r[14]||"", housing:r[15]||""}));
  if (key === "log") return body.map(r => ({date:r[0], items:money(r[1]), value:money(r[2]), note:r[3]||""}));
  // Price History: Date | Card / Item Name | Set / Series | Card # | Old Price ($) | New Price ($), one row per card the Sunday check re-prices
  if (key === "history") return body.map(r => ({date:String(r[0]||"").trim(), name:r[1]||"", set:r[2]||"", num:r[3]||"",
      old:money(r[4]), now:money(r[5]), hasOld:String(r[4]||"").trim() !== "" && String(r[5]||"").trim() !== ""}));
  return body;
}

/* ---------- loading ---------- */
/* Fetches every tab in one request to Code.gs (doGet with ?data=1). Keeps the last good copy if a refresh fails. */
async function fetchData(){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(API + "?data=1" + (CFG.who ? "&who=" + encodeURIComponent(CFG.who) : "") + "&t=" + Date.now(), {cache:"no-store", signal:ctl.signal});
    if (!res.ok) throw new Error("The sheet answered with error " + res.status + ".");
    const d = await res.json();
    if (d && d.error) throw new Error(d.error);
    if (!rightSheet(d)) { const e = new Error(""); e.code = "wrong_sheet"; throw e; }
    return d;
  } finally { clearTimeout(timer); }
}
// Never show another tracker's cards: the Apps Script says which sheet it read (newer Code.gs only).
// Jeff's app also accepts data without that tag, so it keeps working with the older Code.gs.
function rightSheet(d){
  if (!d) return false;
  if (d.sheetId) return d.sheetId === SHEET_ID;
  return !CFG.who || !!CFG.api; // a page's own link (api) only serves that page's sheet
}
function apply(d){
  const at = (d && d.at) || Date.now();
  for (const k of KEYS) {
    const rows = d && d[k];
    if (Array.isArray(rows)) { S.data[k] = parse(k, rows); S.at[k] = at; S.err[k] = null; }
    else if (k === "history") { S.data.history = null; S.err.history = null; } // optional tab: no history yet is normal
    else { S.err[k] = {code:"missing_tab", message:""}; }
  }
  S.mode = S.data.collection ? "ready" : "error";
}
function loadAll(){
  if (S.busy || S.fallback) return;
  S.busy = true; render();
  fetchData().then(d => {
    S.busy = false;
    apply(d);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch(e) {}
    render();
  }).catch(e => {
    S.busy = false;
    // Never loaded here before (e.g. Code.gs not updated yet): show the Apps Script version instead (Jeff's app only).
    if (!S.data.collection && CFG.fallback && !(e && e.code === "wrong_sheet")) { useFallback(); return; }
    const err = {code: (e && e.code) || "error", message: e && e.name === "AbortError" ? "The sheet took too long to answer." : ((e && e.message) || "")};
    KEYS.forEach(k => S.err[k] = err);
    if (!S.data.collection) S.mode = "error";
    render();
  });
}
function useFallback(){
  S.fallback = true;
  document.body.innerHTML = `<iframe src="${API}" title="${esc(CFG.owner)}'s Pokémon Tracker" allow="fullscreen" style="position:fixed;inset:0;width:100%;height:100%;border:0;display:block"></iframe>`;
}
function boot(){
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if (c && rightSheet(c)) apply(c); } catch(e) {}
  render();
  loadAll();
  // Refresh every 5 minutes while the app is on screen, and when you come back to it.
  setInterval(() => { if (!document.hidden) loadAll(); }, 300000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && S.at.collection && Date.now() - S.at.collection > 120000) loadAll();
  });
}

/* ---------- render shell ---------- */
function render(){
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  $("stamp").textContent = S.busy ? "" : ago(S.at.collection);
  const rb = $("refresh");
  rb.disabled = S.busy;
  rb.innerHTML = S.busy ? '<span class="spin" aria-hidden="true"></span> Loading' : "Refresh";

  const main = $("main");
  if (!S.data.collection) {
    main.dataset.view = "state";
    main.innerHTML = stateView();
    const a = $("act"); if (a) a.onclick = () => loadAll();
    return;
  }
  if (S.tab === "collection" && main.dataset.view === "collection" && $("q")) { updateList(); return; }
  main.dataset.view = S.tab;
  main.innerHTML = ({overview:viewOverview, collection:viewCollection, binder:viewBinder, grading:viewGrading, storage:viewStorage}[S.tab] || viewOverview)();
  wire();
  hydrate(main);
}

function stateView(){
  if (S.mode === "loading" || (S.busy && !S.err.collection)) {
    return `<section class="hero"><div class="eyebrow">Collection value</div><div class="skel" style="height:48px;width:55%;margin-top:10px"></div><div class="skel" style="width:70%;margin-top:14px"></div></section>
      <section class="panel"><div class="skel" style="width:40%"></div><div class="skel" style="margin-top:14px"></div><div class="skel" style="margin-top:10px;width:80%"></div></section>
      <p class="note">Reading “${esc(CFG.sheetName)}” from Google Sheets…</p>`;
  }
  const e = S.err.collection || {code:"error"};
  if (e.code === "missing_tab") return msg("No Collection tab found", "The sheet opened, but it has no tab named “Collection”. If you renamed it, change the name back or update Code.gs.", "Try again");
  if (e.code === "wrong_sheet") return msg("Almost ready", "The data link hasn't been updated for “" + CFG.sheetName + "” yet. Once the new Code.gs is deployed in Apps Script, tap Try again.", "Try again");
  return msg("The sheet couldn't be read", (e.message ? e.message + " " : "") + "Check your connection and that “" + CFG.sheetName + "” still exists, then try again.", "Try again");
}
function msg(title, text, action){
  return `<div class="state"><h2>${esc(title)}</h2><p>${esc(text)}</p>${action ? `<button class="btn primary" id="act" type="button">${esc(action)}</button>` : ""}<a class="note" href="${SHEET_URL}" target="_blank" rel="noopener">Open the sheet in Google Sheets</a></div>`;
}
function secErr(key, label){
  const e = S.err[key];
  if (!e) return "";
  return `<div class="secerr">${esc(label)} didn't load (${esc(e.code.replace(/_/g," "))}). ${S.data[key] ? "Showing the last copy." : "Tap Refresh to try again."}</div>`;
}

/* ---------- derived ---------- */
function stats(){
  const c = S.data.collection || [];
  const t = {}; TIERS.concat([{k:"other"}]).forEach(x => t[x.k] = {qty:0, value:0, rows:0});
  let qty = 0, value = 0;
  for (const r of c) { qty += r.qty; value += r.total; const b = t[r.tier]; b.qty += r.qty; b.value += r.total; b.rows++; }
  return {c, t, qty, value};
}
const dateVal = s => { const t = Date.parse(String(s || "").trim()); return isFinite(t) ? t : 0; };
const shortDate = s => { const t = dateVal(s); return t ? new Date(t).toLocaleDateString("en-US", {month:"short", day:"numeric", timeZone:"UTC"}) : String(s || ""); };
// Newest first: by Date Added, then by sheet order (rows added later sit lower in the sheet)
const byNewest = (a,b) => dateVal(b.date) - dateVal(a.date) || b.i - a.i;
// Finds the Collection row for a card named elsewhere (Grading, Price History): exact name first, then without stamp notes
function findCard(name, num, set){
  const c = S.data.collection || [], n = numKey(num), full = normName(name), base = normName(cardName(name)), st = normSet(set);
  const tries = [r => normName(r.name) === full, r => normName(cardName(r.name)) === base];
  for (const ok of tries) {
    const hit = c.filter(r => ok(r) && numKey(r.num) === n);
    if (hit.length) return hit.find(r => !st || normSet(r.set) === st) || hit[0];
  }
  return null;
}
// Price changes from the latest Sunday price check that logged per-card prices
function movers(){
  const H = (S.data.history || []).filter(h => h.date && h.name);
  if (!H.length) return null;
  const last = H.reduce((m, h) => dateVal(h.date) > dateVal(m) ? h.date : m, H[0].date);
  const run = H.filter(h => h.date === last);
  const ch = run.filter(h => h.hasOld && h.old > 0 && Math.abs(h.now - h.old) >= 0.005).map(h => {
    const r = findCard(h.name, h.num, h.set);
    return {h, r, d:h.now - h.old, pct:(h.now - h.old) / h.old};
  });
  return {date:last, checked:run.length,
    up:ch.filter(x => x.d > 0).sort((a,b) => b.d - a.d).slice(0, 4),
    down:ch.filter(x => x.d < 0).sort((a,b) => a.d - b.d).slice(0, 4)};
}

/* ---------- views ---------- */
function viewOverview(){
  const {c, t, qty, value} = stats();
  const sealedQty = t.sealed.qty, cardQty = qty - sealedQty;
  const stack = TIERS.map(x => `<span class="c-${x.k}" style="width:${value ? (t[x.k].value / value * 100).toFixed(2) : 0}%" title="${esc(x.label)}"></span>`).join("");
  const tiers = TIERS.map(x => `<div class="tier"><i class="c-${x.k}"></i><span class="l">${x.label}</span><span class="v">${usd(t[x.k].value)}</span><span class="s">${x.sub}</span><span class="c">${int(t[x.k].qty)} ${x.k === "sealed" ? "items" : "cards"}</span></div>`).join("");

  const sets = {};
  c.filter(r => r.tier !== "sealed").forEach(r => { const k = r.set.replace(/\s*\(.*\)\s*$/, "") || "Unknown"; sets[k] = (sets[k] || 0) + r.total; });
  const top = Object.entries(sets).sort((a,b) => b[1]-a[1]).slice(0, 8);
  const max = top.length ? top[0][1] : 1;
  const setBars = top.map(([n,v]) => `<div class="bar"><span class="n" title="${esc(n)}">${esc(n)}</span><span class="t"><span style="width:${(v/max*100).toFixed(1)}%"></span></span><span class="v">${usd(v)}</span></div>`).join("");

  const hits = c.filter(r => r.tier !== "sealed" && !/\(count\)/i.test(r.name)).sort((a,b) => b.price - a.price).slice(0, 6)
    .map(r => `<li class="t-${r.tier} tap" data-i="${r.i}"><span class="thumb sm"${picAttrs(r)}></span><span class="nm">${esc(r.name)}</span><span class="px">${usd(r.price)}</span><span class="meta">${esc(r.set)} · ${esc(r.num)} · <span class="pin"><i></i>${esc(r.loc)}</span></span></li>`).join("");

  const needSleeve = c.filter(r => r.sleeve);
  const nsQty = needSleeve.reduce((a,r) => a + r.qty, 0);
  const g = S.data.grading || [];
  const screen = g.filter(x => /screen/i.test(x.send) || !x.send).length;

  return `
  <section class="hero" aria-label="Collection value">
    <div class="eyebrow">Collection value · ${esc(CFG.sheetName)}</div>
    <div class="big">${usd(value)}</div>
    <div class="sub"><span><b>${int(cardQty)}</b> cards</span><span><b>${int(sealedQty)}</b> sealed items</span><span><b>${int(c.length)}</b> rows</span>${S.data.log && S.data.log.length ? `<span>Last price check <b>${esc(S.data.log[S.data.log.length-1].date)}</b></span>` : ""}</div>
  </section>
  <section class="panel">
    <h2>Where the value sits</h2>
    <div class="stack" role="img" aria-label="Value split by storage tier">${stack}</div>
    <div class="tiers">${tiers}</div>
  </section>
  <div class="grid2">
    <section class="panel"><h2>Top cards</h2><ul class="hits pics">${hits || '<li class="muted">No singles yet.</li>'}</ul></section>
    <section class="panel"><h2>Value by set</h2><div class="bars">${setBars || '<p class="note">No singles yet.</p>'}</div></section>
  </div>
  <div class="grid2">
    <section class="panel">${recentView(c)}</section>
    <section class="panel">${moversView()}</section>
  </div>
  <div class="grid2">
    <section class="panel">
      <h2>To do</h2>
      <ul class="hits">
        <li><span class="nm">Penny-sleeve the holos</span><span class="px">${int(nsQty)}</span><span class="meta">${needSleeve.length} rows in Bulk Row 1 are still raw. <button class="btn" type="button" data-go="collection" data-filter="sleeve" style="margin-left:4px">Show them</button></span></li>
        <li><span class="nm">Grading candidates to screen</span><span class="px">${S.data.grading ? int(screen) : "–"}</span><span class="meta">Check centering and surface before deciding. <button class="btn" type="button" data-go="grading" style="margin-left:4px">Open grading</button></span></li>
      </ul>
      ${secErr("grading","Grading")}
    </section>
    <section class="panel"><h2>Value over time</h2>${logView()}</section>
  </div>`;
}

function recentView(c){
  const rows = c.filter(r => !/\(count\)/i.test(r.name)).sort(byNewest).slice(0, 6);
  const li = rows.map(r => `<li class="t-${r.tier} tap" data-i="${r.i}"><span class="thumb sm"${picAttrs(r)}></span><span class="nm">${esc(r.name)}</span><span class="px">${usd(r.price)}</span><span class="meta">${esc(r.set)}${r.num ? " · " + esc(r.num) : ""}${r.date ? " · added " + esc(shortDate(r.date)) : ""}</span></li>`).join("");
  return `<div class="pager" style="margin-bottom:12px"><h2 style="margin:0">Recently added</h2>${rows.length ? '<button class="btn" type="button" data-go="collection" data-sort="newest">See all</button>' : ""}</div>
    <ul class="hits pics">${li || '<li class="muted">Nothing added yet.</li>'}</ul>`;
}

function moversView(){
  const m = movers();
  const head = `<h2>Price movers</h2>`;
  if (!m) return `${head}<p class="note" style="margin:0">Movers show up after the next Sunday price check, which will save each card's old and new price.</p>`;
  const item = x => {
    const r = x.r, tap = r ? ` tap" data-i="${r.i}` : "";
    const pic = picAttrs(r || {tier:"binder", name:x.h.name, set:x.h.set, num:x.h.num});
    return `<li class="t-${r ? r.tier : "binder"}${tap}"><span class="thumb sm"${pic}></span><span class="nm">${esc(x.h.name)}</span><span class="px ${x.d >= 0 ? "pos" : "neg"}">${x.d >= 0 ? "+" : "−"}${usd(Math.abs(x.d))}</span><span class="meta">${usd(x.h.old)} → ${usd(x.h.now)} · <span class="${x.d >= 0 ? "pos" : "neg"}">${x.d >= 0 ? "+" : "−"}${Math.abs(x.pct * 100).toFixed(0)}%</span></span></li>`;
  };
  const list = (t, a) => a.length ? `<div class="eyebrow" style="margin:4px 0 6px">${t}</div><ul class="hits pics">${a.map(item).join("")}</ul>` : "";
  const body = list("Up", m.up) + (m.up.length && m.down.length ? '<div style="height:12px"></div>' : "") + list("Down", m.down);
  return `${head}<p class="note" style="margin:-6px 0 12px">Price check on ${esc(shortDate(m.date))} · ${int(m.checked)} cards checked</p>${body || '<p class="note" style="margin:0">No prices changed in that check.</p>'}`;
}

function logView(){
  const err = secErr("log","Price log");
  const L = (S.data.log || []).filter(x => x.value > 0);
  if (!L.length) return err || '<p class="note">No price checks logged yet.</p>';
  if (L.length < 2) {
    const x = L[0];
    return `${err}<p style="margin:0"><span class="num" style="font-size:22px;font-weight:500">${usd(x.value)}</span> <span class="muted">on ${esc(x.date)}</span></p><p class="note">The trend line starts after the next Sunday price check adds a second point.</p>`;
  }
  const W = 560, H = 150, pl = 8, pr = 8, pt = 16, pb = 26;
  const vs = L.map(x => x.value), lo = Math.min(...vs), hi = Math.max(...vs), span = (hi - lo) || hi * .1 || 1;
  const X = i => pl + i * (W - pl - pr) / (L.length - 1);
  const Y = v => pt + (1 - (v - (lo - span*.1)) / (span*1.2)) * (H - pt - pb);
  const pts = L.map((x,i) => `${X(i).toFixed(1)},${Y(x.value).toFixed(1)}`).join(" ");
  const last = L[L.length-1], first = L[0], d = last.value - first.value;
  return `${err}<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Collection value from ${esc(first.date)} to ${esc(last.date)}">
    <line x1="${pl}" x2="${W-pr}" y1="${H-pb}" y2="${H-pb}" stroke="var(--line)"/>
    <polygon points="${X(0)},${H-pb} ${pts} ${X(L.length-1)},${H-pb}" fill="var(--accent-soft)"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${X(L.length-1)}" cy="${Y(last.value)}" r="4.5" fill="var(--accent)"/>
    <text x="${pl}" y="${H-8}">${esc(first.date)}</text><text x="${W-pr}" y="${H-8}" text-anchor="end">${esc(last.date)}</text>
  </svg><p class="note" style="margin:6px 0 0">${usd(last.value)} now · <span class="${d >= 0 ? "pos" : "neg"}">${d >= 0 ? "+" : "−"}${usd(Math.abs(d))}</span> since ${esc(first.date)}</p>`;
}

const FILTERS = [
  {k:"all", label:"All"}, {k:"top", label:"Top loaders"}, {k:"binder", label:"Binder"},
  {k:"bulk", label:"Bulk box"}, {k:"sealed", label:"Sealed"}, {k:"sleeve", label:"Needs sleeve"}
];
function viewCollection(){
  return `<div class="toolbar">
    <label class="search" for="q"><span class="muted" aria-hidden="true">⌕</span><input id="q" type="search" placeholder="Search name, set, number or location" value="${esc(S.q)}" autocomplete="off"></label>
    <div class="chips" role="group" aria-label="Filter">${FILTERS.map(f => `<button type="button" class="chip" data-filter="${f.k}" aria-pressed="${S.filter === f.k}">${["top","binder","bulk","sealed"].includes(f.k) ? `<i class="c-${f.k}"></i>` : ""}${f.label}</button>`).join("")}</div>
    <div class="sortrow"><span id="count"></span><label>Sort <select id="sort"><option value="value">Highest value</option><option value="newest">Newest first</option><option value="name">Name A–Z</option><option value="set">Set</option><option value="loc">Location</option></select></label></div>
  </div>
  <ul class="list" id="colList"></ul>`;
}
function filtered(){
  const q = S.q.trim().toLowerCase();
  let rows = (S.data.collection || []).filter(r => {
    if (S.filter === "sleeve" ? !r.sleeve : (S.filter !== "all" && r.tier !== S.filter)) return false;
    if (!q) return true;
    return [r.name, r.set, r.num, r.rarity, r.loc].join(" ").toLowerCase().includes(q);
  });
  const by = {
    value: (a,b) => b.price - a.price || b.total - a.total,
    newest: byNewest,
    name: (a,b) => a.name.localeCompare(b.name),
    set: (a,b) => a.set.localeCompare(b.set) || String(a.num).localeCompare(String(b.num), undefined, {numeric:true}),
    loc: (a,b) => a.loc.localeCompare(b.loc, undefined, {numeric:true})
  }[S.sort];
  return rows.sort(by);
}
function updateList(){
  const rows = filtered();
  const qty = rows.reduce((a,r) => a + r.qty, 0), val = rows.reduce((a,r) => a + r.total, 0);
  $("count").textContent = `${rows.length} rows · ${int(qty)} items · ${usd(val)}`;
  document.querySelectorAll(".chip").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.filter === S.filter)));
  $("colList").innerHTML = rows.length ? rows.map(r => `
    <li class="row t-${r.tier} tap" data-i="${r.i}" tabindex="0">
      <span class="thumb"${picAttrs(r)}></span>
      <div><div class="nm">${esc(r.name)}</div><div class="meta">${esc(r.set)}${r.num ? " · " + esc(r.num) : ""}${r.rarity ? " · " + esc(r.rarity) : ""}${r.cond && r.cond !== "NM" ? " · " + esc(r.cond) : ""}</div></div>
      <div class="val"><div class="px">${usd(r.price)}</div>${r.qty > 1 ? `<div class="qty">×${int(r.qty)} · ${usd(r.total)}</div>` : ""}</div>
      <div class="loc"><span class="pin"><i></i>${esc(r.loc || "No location")}</span>${r.sleeve ? '<span class="flag">Needs penny sleeve</span>' : ""}</div>
    </li>`).join("") : `<li class="empty">Nothing matches “${esc(S.q)}”.</li>`;
  hydrate($("colList"));
}

function viewBinder(){
  const c = (S.data.collection || []).filter(r => r.page);
  const st = S.data.storage;
  const nextLoc = st && st.spots.find(s => /binder/i.test(s.label));
  const nm = nextLoc && String(nextLoc.loc).match(/P\s*(\d+)\s*S\s*(\d+)/i);
  const next = nm ? {p:+nm[1], s:+nm[2]} : null;
  const used = c.length, maxP = Math.max(1, ...c.map(r => r.page), next ? next.p : 1);
  if (S.page == null) S.page = next ? next.p : 1;
  const P = S.page;
  const onPage = {}; c.filter(r => r.page === P).forEach(r => onPage[r.slot] = r);
  let slots = "";
  for (let s = 1; s <= 9; s++) {
    const r = onPage[s];
    if (r) slots += `<div class="slot fill tap" data-i="${r.i}"><span class="art"${picAttrs(r)}></span><span class="sn">S${s}</span><span class="nm">${esc(r.name)}</span><span class="meta">${esc(r.set)}<br>${esc(r.num)}</span><span class="px">${usd(r.price)}</span></div>`;
    else if (next && next.p === P && next.s === s) slots += `<div class="slot open next"><span class="sn">S${s}</span>Next open</div>`;
    else slots += `<div class="slot open"><span class="sn">S${s}</span>Open</div>`;
  }
  const pageVal = Object.values(onPage).reduce((a,r) => a + r.total, 0);
  const pages = Array.from({length: Math.min(40, maxP + 1)}, (_, i) => i + 1).map(p => {
    const n = c.filter(r => r.page === p).length;
    return `<button type="button" data-page="${p}" aria-current="${p === P}" class="${n === 9 ? "full" : ""}" aria-label="Page ${p}, ${n} of 9 filled">${p}</button>`;
  }).join("");
  return `<section class="panel">
    <div class="pager">
      <div><div class="eyebrow">Vault X 9-pocket binder</div><div class="pg">Page ${P}</div></div>
      <div style="display:flex;gap:6px"><button class="btn" type="button" data-page="${Math.max(1,P-1)}" ${P <= 1 ? "disabled" : ""}>← Prev</button><button class="btn" type="button" data-page="${Math.min(40,P+1)}" ${P >= 40 ? "disabled" : ""}>Next →</button></div>
    </div>
    <p class="note" style="margin:6px 0 0">${Object.keys(onPage).length} of 9 pockets filled · ${usd(pageVal)} on this page · ${used} of 360 slots used${next ? ` · next card goes in <b>P${next.p} S${next.s}</b>` : ""}</p>
    <div class="sheet" role="list" aria-label="Binder page ${P}">${slots}</div>
    <div class="pages" aria-label="Binder pages">${pages}</div>
    ${secErr("storage","Next open slot")}
  </section>`;
}

function viewGrading(){
  const g = S.data.grading;
  if (!g) return `<section class="panel"><h2>Grading</h2>${secErr("grading","Grading tab") || '<p class="note">Loading…</p>'}</section>`;
  if (!g.length) return `<section class="panel"><h2>Grading</h2><p class="note">No cards are flagged for grading yet. Cards worth $20 or more show up here automatically.</p></section>`;
  const pill = r => r === "GRADE" ? "p-grade" : r === "GAMBLE" ? "p-gamble" : "p-skip";
  const sign = n => `<span class="${n >= 0 ? "pos" : "neg"}">${n >= 0 ? "+" : "−"}${usd(Math.abs(n))}</span>`;
  return `<p class="note" style="margin:0">GRADE pays even at a PSA 9. GAMBLE only pays at a PSA 10, so send it only if it looks flawless. Net figures are after the PSA fee, shipping and selling fees.</p>
  ${secErr("grading","Grading")}
  <div class="grid2">${g.map(x => { const r = findCard(x.name, x.num, x.set); return `
    <article class="gcard${r ? ` tap" data-i="${r.i}" tabindex="0` : ""}">
      <div class="gtop"><div style="display:flex;gap:10px;min-width:0"><span class="thumb"${picAttrs(r || {tier:"top", name:x.name, set:x.set, num:x.num})}></span><div><h3 style="font-size:16px">${esc(x.name)}</h3><div class="note">${esc(x.set)} · ${esc(x.num)} · <span class="pin t-top"><i></i>${esc(x.housing)}</span></div></div></div><span class="pill ${pill(x.rec)}">${esc(x.rec || "—")}</span></div>
      <div class="gtbl">
        <div><div class="k">Raw NM</div><div class="v">${usd(x.raw)}</div></div>
        <div><div class="k">PSA 10</div><div class="v">${usd(x.p10)}</div></div>
        <div><div class="k">PSA 9</div><div class="v">${usd(x.p9)}</div></div>
        <div><div class="k">Net at 10</div><div class="v">${sign(x.net10)}</div></div>
        <div><div class="k">Net at 9</div><div class="v">${sign(x.net9)}</div></div>
        <div><div class="k">PSA 8</div><div class="v">${usd(x.p8)}</div></div>
      </div>
      <div class="steps"><span>Send: <b>${esc(x.send || "—")}</b></span>${x.ai ? `<span>AI screen: ${esc(x.ai)}</span>` : ""}${x.hands ? `<span>Hands-on: ${esc(x.hands)}</span>` : ""}${x.step ? `<span>Step: ${esc(x.step)}</span>` : ""}${x.grade ? `<span>Grade: <b>${esc(x.grade)}</b></span>` : ""}</div>
    </article>`; }).join("")}</div>`;
}

function viewStorage(){
  const st = S.data.storage;
  const {c, t} = stats();
  const ns = c.filter(r => r.sleeve);
  const colorFor = u => /binder/i.test(u) ? "c-binder" : /bulk/i.test(u) ? "c-bulk" : /top/i.test(u) ? "c-top" : /sealed/i.test(u) ? "c-sealed" : "c-other";
  const units = st ? st.units.map(u => {
    const pct = u.max ? Math.min(100, u.count / u.max * 100) : 0;
    return `<div class="unit"><span class="l">${esc(u.unit)}</span><span class="r">${int(u.count)} / ${int(u.max)}</span><span class="s">${esc(u.spec)} · ${esc(u.rule)}</span><span class="t"><span class="${colorFor(u.unit)}" style="width:${pct.toFixed(1)}%"></span></span></div>`;
  }).join("") : "";
  const spots = st && st.spots.length ? `<div class="spots">${st.spots.map(s => `<div class="spot"><div class="eyebrow">${esc(s.label)}</div><div class="v">${esc(s.loc)}</div></div>`).join("")}</div>` : "";
  return `${spots ? `<section class="panel"><h2>Next open spots</h2>${spots}</section>` : ""}
  <section class="panel"><h2>Storage capacity</h2>${secErr("storage","Storage tab")}<div class="units">${units || '<p class="note">Loading…</p>'}</div></section>
  <section class="panel"><h2>Needs a penny sleeve</h2>
    <p class="note" style="margin-top:0">Holos and reverse holos in Bulk Row 1 should be sleeved even under $2. ${int(ns.reduce((a,r)=>a+r.qty,0))} cards across ${ns.length} rows are still raw.</p>
    <ul class="hits">${ns.sort((a,b)=>a.loc.localeCompare(b.loc)).map(r => `<li><span class="nm">${esc(r.name)}</span><span class="px">×${int(r.qty)}</span><span class="meta"><span class="pin"><i></i>${esc(r.loc)}</span></span></li>`).join("") || '<li class="muted">Everything is sleeved.</li>'}</ul>
  </section>`;
}

/* ---------- scan cards ---------- */
/* "Scan" in the header: take a photo → the Apps Script (Scan.gs) asks Claude to read the cards and looks up
   prices → you check the list → "Add" writes the rows to this app's sheet with the same storage rules as the chat skill.
   The Claude API key never comes to the phone; it stays in Apps Script. The phone only keeps the passcode. */
const PASS_KEY = CFG.store + "-pass";
const SC = {step:"pick", cards:[], photo:"", err:"", note:"", cost:0, result:null, added:false, batch:""};
const getPass = () => { try { return localStorage.getItem(PASS_KEY) || ""; } catch(e) { return ""; } };
const setPass = p => { try { p ? localStorage.setItem(PASS_KEY, p) : localStorage.removeItem(PASS_KEY); } catch(e) {} };

async function scanCall(body, ms){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 60000);
  try {
    // Sent as plain text so the browser doesn't need Apps Script's permission first (no CORS preflight).
    const res = await fetch(API, {method:"POST", body:JSON.stringify(Object.assign({pass:getPass()}, body)), signal:ctl.signal});
    if (!res.ok) throw new Error("The scanner answered with error " + res.status + ".");
    const d = await res.json().catch(() => { throw new Error("The scanner isn't set up yet. Scan.gs needs to be added in Apps Script and deployed as a new version."); });
    if (d && d.error) { const e = new Error(d.error); e.code = d.code; throw e; }
    return d;
  } catch(e) {
    if (e && e.name === "AbortError") throw new Error("That took too long. Check your connection, or try a photo with fewer cards.");
    if (e instanceof TypeError) throw new Error("Couldn't reach the scanner. Check your connection and try again.");
    throw e;
  } finally { clearTimeout(timer); }
}

// Shrinks the photo on the phone first (long side 2576px, the most Claude reads) so it uploads quickly.
function shrinkPhoto(file){
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const max = 2576, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error("That photo couldn't be opened. Try taking it again.")); };
    img.src = url;
  });
}

// Where a card will go, from its price (the exact slot is decided when it's added).
function routeOf(c){
  const p = parseFloat(c.price);
  if (c.kind === "sealed" || c.category === "Sealed") return {tier:"sealed", text:"Sealed shelf"};
  if (!isFinite(p) || String(c.price ?? "").trim() === "") return {tier:"other", text:"Needs a price"};
  if (p >= 20) return {tier:"top", text:"Top loader · next buffer #"};
  if (p >= 2) return {tier:"binder", text:"Binder · next open slot"};
  if (c.foil) return {tier:"bulk", text:"Bulk Row 1 Back · sleeved"};
  if (c.category === "Trainer") return {tier:"bulk", text:"Bulk Row 3 · Trainers"};
  if (c.category === "Energy" && c.basicEnergy) return {tier:"bulk", text:"Bulk Row 3 · Basic Energy"};
  return {tier:"bulk", text:"Bulk Row 2 · " + c.set};
}

function openScan(){
  const d = $("scan");
  SC.err = "";
  if (SC.step === "done" || SC.step === "working" || SC.step === "adding") resetScan();
  SC.step = getPass() ? (SC.cards.length ? "review" : "pick") : "pass";
  renderScan();
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
}
function resetScan(){ Object.assign(SC, {step:"pick", cards:[], photo:"", err:"", note:"", cost:0, result:null, batch:""}); }
function closeScan(){
  const d = $("scan");
  if (d.close) d.close(); else d.removeAttribute("open");
  if (SC.added) { SC.added = false; loadAll(); } // show the new rows
}

function renderScan(){
  const d = $("scan");
  const head = `<div class="dhead shead"><h2>Scan cards</h2><button class="btn" type="button" id="sclose">Close</button></div>`;
  const err = SC.err ? `<div class="secerr" role="alert">${esc(SC.err)}</div>` : "";
  let body = "";
  if (SC.step === "pass") {
    body = `<p class="note" style="margin:0">Enter the scanner passcode once on this phone. It's set in Apps Script, so only people you give it to can scan into “${esc(CFG.sheetName)}”.</p>
      ${err}
      <label class="field"><span>Passcode</span><input id="spass" type="password" autocomplete="current-password" enterkeyhint="go"></label>
      <button class="btn primary big" type="button" id="sunlock">Unlock scanner</button>`;
  } else if (SC.step === "pick") {
    body = `${err}
      <label class="btn primary big" for="scam">Take a photo</label>
      <input id="scam" type="file" accept="image/*" capture="environment" hidden>
      <label class="btn big" for="slib">Choose from photos</label>
      <input id="slib" type="file" accept="image/*" hidden>
      <ul class="tips">
        <li>Up to 9 cards, flat on a plain background, in rows like a binder page.</li>
        <li>Good light and no glare on the bottom corners, where the set number is.</li>
        <li>Nothing is added until you check the list and tap Add.</li>
      </ul>
      <p class="note" style="margin:0">Saves to “${esc(CFG.sheetName)}”. <button class="linkbtn" type="button" id="sforget">Forget passcode on this phone</button></p>`;
  } else if (SC.step === "working" || SC.step === "adding") {
    body = `${SC.photo ? `<img class="sphoto" src="${SC.photo}" alt="Your photo">` : ""}
      <p class="sbusy"><span class="spin" aria-hidden="true"></span> ${SC.step === "working" ? "Reading your cards and looking up prices…" : "Adding to “" + esc(CFG.sheetName) + "”…"}</p>
      <p class="note" style="margin:0;text-align:center">${SC.step === "working" ? "This usually takes 15–40 seconds." : ""}</p>`;
  } else if (SC.step === "review") {
    const keep = SC.cards.filter(c => !c.skip);
    const missing = keep.filter(c => !isFinite(parseFloat(c.price)) || String(c.price ?? "").trim() === "");
    body = `${SC.photo ? `<img class="sphoto sm" src="${SC.photo}" alt="Your photo">` : ""}
      ${SC.note ? `<div class="secerr">${esc(SC.note)}</div>` : ""}${err}
      ${SC.cards.length ? `<p class="note" style="margin:0">Found ${SC.cards.length} ${SC.cards.length === 1 ? "item" : "items"}. Check each one, fix anything that's off, then add.</p>` : `<p class="note" style="margin:0">No cards were found in that photo. Try again closer up, with good light.</p>`}
      <div class="scards">${SC.cards.map(scanCardView).join("")}</div>
      <p class="note warn" id="smissing" style="margin:0"${missing.length ? "" : " hidden"}>${missingText(missing)}</p>
      <div class="sbar">
        <button class="btn" type="button" id="sretake">Retake</button>
        <button class="btn primary" type="button" id="sadd" ${!keep.length || missing.length ? "disabled" : ""}>Add ${keep.length} to sheet</button>
      </div>
      ${SC.cost ? `<p class="note" style="margin:0;text-align:center">This scan cost about ${SC.cost < 0.01 ? "under 1¢" : Math.round(SC.cost * 100) + "¢"}.</p>` : ""}`;
  } else if (SC.step === "done") {
    const r = SC.result || {added:[], next:{}};
    body = `<div class="sdone"><h3>Added ${r.added.length} ${r.added.length === 1 ? "row" : "rows"} to “${esc(CFG.sheetName)}”</h3>
      <ol class="sacts">${r.added.map(a => `<li class="t-${tierOf(a.loc)}"><b>${esc(a.name)}</b>${a.qty > 1 ? " ×" + int(a.qty) : ""} <span class="muted">${usd(a.price)}</span><div>${esc(a.action)}</div></li>`).join("")}</ol>
      ${r.grading ? `<p class="note" style="margin:0">${r.grading === 1 ? "1 card is" : r.grading + " cards are"} on the Grading tab. Add PSA prices there to get the grade-or-skip verdict.</p>` : ""}
      <div class="spots"><div class="spot"><div class="eyebrow">Next binder slot</div><div class="v">${esc(r.next.binder || "–")}</div></div><div class="spot"><div class="eyebrow">Next buffer</div><div class="v">${esc(r.next.buffer || "–")}</div></div></div>
      </div>
      <div class="sbar"><button class="btn" type="button" id="sfinish">Done</button><button class="btn primary" type="button" id="smore">Scan more</button></div>`;
  }
  d.innerHTML = head + `<div class="dbody sbody">${body}</div>`;
  wireScan();
}

function scanCardView(c, k){
  const r = routeOf(c), conf = c.confidence === "low" ? "Check this one" : c.confidence === "medium" ? "Fairly sure" : "";
  const tcg = priceUrl({name:c.name, num:c.number, tier:c.kind === "sealed" ? "sealed" : "binder"});
  const others = (c.others || []).map(o => `${esc(o.label)} ${usd(o.price)}`).join(" · ");
  return `<article class="scard${c.skip ? " skip" : ""} t-${r.tier}" data-k="${k}">
    <div class="stop">
      <span class="thumb">${c.image ? `<img src="${esc(c.image)}" alt="" loading="lazy">` : ""}</span>
      <div class="sinfo">
        <div class="nm">${esc(c.name)} ${conf ? `<span class="flag${c.confidence === "low" ? " bad" : ""}">${conf}</span>` : ""}</div>
        <div class="meta">${esc(c.set)}${c.number ? " · " + esc(c.number) : ""}${c.rarity ? " · " + esc(c.rarity) : ""}</div>
      </div>
      <button class="btn" type="button" data-skip="${k}" aria-label="${c.skip ? "Include" : "Leave out"} ${esc(c.name)}">${c.skip ? "Include" : "Leave out"}</button>
    </div>
    ${c.skip ? "" : `
    <div class="sflds">
      <label class="field"><span>Price $</span><input data-f="price" data-k="${k}" inputmode="decimal" value="${c.price == null ? "" : esc(c.price)}" placeholder="0.00"></label>
      <label class="field"><span>Qty</span><input data-f="qty" data-k="${k}" type="number" min="1" max="99" inputmode="numeric" value="${esc(c.qty)}"></label>
      <label class="field"><span>Condition</span><select data-f="condition" data-k="${k}">${["NM","LP","MP","HP","DMG"].map(x => `<option${x === c.condition ? " selected" : ""}>${x}</option>`).join("")}</select></label>
    </div>
    <div class="sdest"><span class="pin t-${r.tier}"><i></i>${esc(r.text)}</span>${tcg ? `<a href="${tcg}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ""}</div>
    <ul class="snotes">
      ${c.priceNote ? `<li>${esc(c.priceNote)}${others ? " Other versions: " + others + "." : ""}</li>` : ""}
      ${c.note ? `<li>${esc(c.note)}</li>` : ""}
      ${(c.checks || []).map(x => `<li class="warn">${esc(x)}</li>`).join("")}
    </ul>
    <details class="sfix"><summary>Fix name, set or number</summary>
      <label class="field"><span>Name</span><input data-f="name" data-k="${k}" value="${esc(c.name)}"></label>
      <label class="field"><span>Set</span><input data-f="set" data-k="${k}" value="${esc(c.set)}"></label>
      <div class="sflds">
        <label class="field"><span>Card #</span><input data-f="number" data-k="${k}" value="${esc(c.number)}"></label>
        <label class="field"><span>Rarity</span><input data-f="rarity" data-k="${k}" value="${esc(c.rarity)}"></label>
      </div>
      <label class="check"><input type="checkbox" data-f="foil" data-k="${k}"${c.foil ? " checked" : ""}> Has foil (holo or reverse holo)</label>
    </details>`}
  </article>`;
}

function wireScan(){
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on("sclose", closeScan);
  on("sfinish", closeScan);
  on("smore", () => { resetScan(); renderScan(); });
  on("sretake", () => { resetScan(); renderScan(); });
  on("sforget", () => { setPass(""); SC.step = "pass"; renderScan(); });
  on("sunlock", unlockScan);
  const pi = $("spass");
  if (pi) { pi.onkeydown = e => { if (e.key === "Enter") unlockScan(); }; setTimeout(() => pi.focus(), 50); }
  ["scam", "slib"].forEach(id => { const el = $(id); if (el) el.onchange = () => el.files && el.files[0] && runScan(el.files[0]); });
  on("sadd", addScan);
  document.querySelectorAll("#scan [data-skip]").forEach(b => b.onclick = () => { const c = SC.cards[+b.dataset.skip]; c.skip = !c.skip; renderScan(); });
  document.querySelectorAll("#scan [data-f]").forEach(el => {
    const upd = () => {
      const c = SC.cards[+el.dataset.k], f = el.dataset.f;
      c[f] = el.type === "checkbox" ? el.checked : el.value;
      if (f === "price" || f === "foil") refreshScanCard(+el.dataset.k);
      if (f !== "price" && f !== "qty") return;
      updateAddButton();
    };
    el.oninput = upd; el.onchange = upd;
  });
}
// Updates one card's "where it goes" and the Add button without redrawing (keeps the keyboard open while typing).
function refreshScanCard(k){
  const c = SC.cards[k], el = document.querySelector(`#scan .scard[data-k="${k}"]`);
  if (!el) return;
  const r = routeOf(c);
  el.className = `scard t-${r.tier}`;
  const pin = el.querySelector(".sdest .pin");
  if (pin) { pin.className = `pin t-${r.tier}`; pin.innerHTML = `<i></i>${esc(r.text)}`; }
  updateAddButton();
}
const missingText = m => m.length ? "Enter a price for " + esc(m.map(c => c.name).join(", ")) + " to add " + (m.length === 1 ? "it" : "them") + "." : "";
function updateAddButton(){
  const b = $("sadd");
  if (!b) return;
  const keep = SC.cards.filter(c => !c.skip);
  const missing = keep.filter(c => !isFinite(parseFloat(c.price)) || String(c.price ?? "").trim() === "");
  b.disabled = !keep.length || missing.length > 0;
  const m = $("smissing");
  if (m) { m.innerHTML = missingText(missing); m.hidden = !missing.length; }
}

async function unlockScan(){
  const p = ($("spass") || {}).value || "";
  if (!p.trim()) { SC.err = "Type the passcode first."; renderScan(); return; }
  setPass(p.trim());
  const btn = $("sunlock"); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Checking'; }
  try {
    const d = await scanCall({action:"check"}, 30000);
    if (d.sheetId && d.sheetId !== SHEET_ID) { setPass(""); throw new Error("This app's data link points at a different sheet. Nothing was saved."); }
    SC.err = ""; SC.step = "pick";
  } catch(e) {
    if (e.code === "pass" || e.code === "locked") setPass("");
    SC.err = e.message;
  }
  renderScan();
}

async function runScan(file){
  SC.err = ""; SC.step = "working"; SC.photo = ""; renderScan();
  try {
    SC.photo = await shrinkPhoto(file);
    renderScan();
    const d = await scanCall({action:"identify", image:SC.photo.split(",")[1], mediaType:"image/jpeg"}, 120000);
    SC.cards = (d.cards || []).map(c => Object.assign({skip:false}, c));
    SC.note = d.photoNote || ""; SC.cost = d.cost || 0;
    SC.batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    SC.step = "review";
  } catch(e) {
    if (e.code === "pass" || e.code === "locked") { setPass(""); SC.step = "pass"; }
    else SC.step = "pick";
    SC.err = e.message;
  }
  renderScan();
}

async function addScan(){
  const keep = SC.cards.filter(c => !c.skip);
  if (!keep.length) return;
  SC.err = ""; SC.step = "adding"; renderScan();
  try {
    const cards = keep.map(c => ({name:c.name, set:c.set, number:c.number, rarity:c.rarity, category:c.kind === "sealed" ? "Sealed" : c.category,
      condition:c.condition, qty:c.qty, price:c.price, foil:!!c.foil, basicEnergy:!!c.basicEnergy}));
    SC.result = await scanCall({action:"add", cards, batch:SC.batch}, 90000);
    SC.added = true; SC.step = "done"; SC.cards = [];
  } catch(e) {
    if (e.code === "pass" || e.code === "locked") setPass("");
    SC.step = "review"; SC.err = e.message;
  }
  renderScan();
}

function initScan(){
  if (!$("refresh") || $("scanBtn")) return;
  const b = document.createElement("button");
  b.className = "btn primary"; b.id = "scanBtn"; b.type = "button";
  b.setAttribute("aria-label", "Scan cards with the camera");
  b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Scan';
  b.onclick = openScan;
  $("refresh").before(b);
  const d = document.createElement("dialog");
  d.id = "scan"; d.setAttribute("aria-label", "Scan cards");
  d.addEventListener("cancel", e => { if (SC.step === "working" || SC.step === "adding") e.preventDefault(); else { e.preventDefault(); closeScan(); } });
  document.body.appendChild(d);
}

/* ---------- events ---------- */
function wire(){
  document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => {
    if (b.dataset.filter) { S.filter = b.dataset.filter; S.q = ""; }
    if (b.dataset.sort) { S.sort = b.dataset.sort; S.filter = "all"; S.q = ""; }
    setTab(b.dataset.go);
  });
  document.querySelectorAll("[data-page]").forEach(b => b.onclick = () => { S.page = +b.dataset.page; render(); });
  if (S.tab === "collection") {
    const q = $("q");
    q.oninput = () => { S.q = q.value; updateList(); };
    document.querySelectorAll(".chip").forEach(b => b.onclick = () => { S.filter = b.dataset.filter; updateList(); });
    const so = $("sort"); so.value = S.sort; so.onchange = () => { S.sort = so.value; updateList(); };
    updateList();
  }
}
function setTab(t){
  S.tab = t;
  try { localStorage.setItem(TAB_KEY, t); } catch(e) {}
  $("main").dataset.view = "";
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach(b => b.onclick = () => setTab(b.dataset.tab));
$("main").addEventListener("click", e => { const t = e.target.closest("[data-i]"); if (t && !e.target.closest("button")) openDetail(+t.dataset.i); });
$("main").addEventListener("keydown", e => { const t = e.target.closest("[data-i]"); if (t && e.key === "Enter") openDetail(+t.dataset.i); });
$("refresh").onclick = () => loadAll(true);
setInterval(() => { if (!S.busy) $("stamp").textContent = ago(S.at.collection); }, 60000);
initScan();
boot();
