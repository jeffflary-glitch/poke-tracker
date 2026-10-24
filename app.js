/* Shared dashboard code for every tracker. Each app page (index.html for Jeff, max/index.html for Max)
   sets window.PKT before loading this file:
     sheetName  "Pokemon tracker Jeff"         → shown in the app
     sheetId    Google Sheet ID                → the app only accepts data from this sheet
     photos     "sealed/"                      → folder holding photos.json and your own photos
     store      "pkt" / "pkt-max"              → prefix for what the app saves on the phone (keeps apps apart)
     api        Apps Script /exec link         → optional: this tracker's own data link (default: Jeff's) */
const CFG = Object.assign({sheetName:"Pokemon tracker Jeff", sheetId:"", photos:"sealed/", store:"pkt"}, window.PKT || {});
const SHEET_ID = CFG.sheetId;
const SHEET_URL = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/edit";
// The Apps Script web app: "?data=1" returns the sheet as data; POSTs scan cards and save bulk counts.
// A page can use its own Apps Script link (api) — Max's tracker has one — otherwise Jeff's is used.
const API = CFG.api || "https://script.google.com/macros/s/AKfycbwPHBji0cPxwD9_-YTLs3W25WNh9dL4M6P6rw5exU3hSZjCoGwA4DFxm9zxOVUFcEILaw/exec";
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
const money = v => { const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, "")); return isFinite(n) ? n : 0; };
const usd = n => n.toLocaleString("en-US", {style:"currency", currency:"USD"});
const int = n => Math.round(n).toLocaleString("en-US");
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
  const q = (base + (r.tier !== "sealed" && num && !/mixed/i.test(num) ? " " + num : "")).replace(/[[\]]/g, " ").replace(/\s+/g, " ").trim();
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
      <div id="drm"></div>
    </div>`;
  $("dclose").onclick = () => d.close();
  d.onclick = e => { if (e.target === d) d.close(); };
  Object.assign(RM, {r, open:false, qty:1, reason:"", price:"", note:"", busy:false, err:"", done:null, batch:""});
  renderRemove();
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
  hydrate(d);
}

/* ---------- remove ---------- */
// Takes some or all of a row out of the sheet (Scan.gs, action "remove"), behind the same passcode as scanning,
// and logs why on the sheet's "Sold & Opened" tab. Reasons must match SCAN_REASONS in Scan.gs.
const RM = {r:null, open:false, qty:1, reason:"", price:"", note:"", pw:"", busy:false, err:"", done:null, batch:""};
const RM_REASONS = [
  {k:"opened", label:"Opened", sealed:true, note:"What was in it? (optional)"},
  {k:"sold", label:"Sold", note:"Who bought it, where (optional)"},
  {k:"traded", label:"Traded", note:"Traded for… (optional)"},
  {k:"gave", label:"Gave away", note:"Gave it to… (optional)"},
  {k:"mistake", label:"Added by mistake"}
];
const rmSealed = r => r.tier === "sealed" || /^sealed$/i.test(r.cat);
const rmCount = () => Math.max(1, Math.min(RM.r.qty, Math.round(+RM.qty) || 1));
function rmWhat(){
  const r = RM.r, n = rmCount();
  const what = n < r.qty ? `Qty goes from ${int(r.qty)} to ${int(r.qty - n)}.`
    : `Deletes this row from “${esc(CFG.sheetName)}”.` + (/^Binder/i.test(r.loc) ? ` ${esc(r.loc)} opens up for the next binder card.`
    : /^Buffer/i.test(r.loc) ? ` ${esc(r.loc)} opens up, and its Grading row is removed too.` : "");
  return what + (!RM.reason ? "" : RM.reason === "mistake" ? " Not logged anywhere." : " Logged on the “Sold &amp; Opened” tab.");
}
function removeView(){
  const r = RM.r, d = RM.done;
  if (d) return `<p class="rmdone">${esc(d.reason || "Removed")} ${int(d.removed)} × ${esc(d.name)}${d.sold !== "" && d.sold != null ? ` for ${usd(+d.sold)} each` : ""}${d.left ? ` · ${int(d.left)} left` : ""}.</p>
    ${!d.left && /^(Binder|Buffer)/i.test(d.loc) ? `<p class="note" style="margin:0">${esc(d.loc)} is open now. The next ${/^Buffer/i.test(d.loc) ? "top loader card" : "binder card"} goes there.${d.grading ? " Its Grading row was removed too." : ""}</p>` : ""}
    ${d.reason ? `<p class="note" style="margin:0">Logged on the “Sold &amp; Opened” tab.</p>` : ""}
    ${d.reason === "Opened" ? `<button class="btn primary big" type="button" id="rmpulls">Scan what you pulled</button>` : ""}`;
  if (!RM.open) return `<button class="btn big rmbtn" type="button" id="rmopen">Remove from collection</button>`;
  const why = RM_REASONS.find(x => x.k === RM.reason);
  return `<div class="rmbox">
    <h3>Remove ${esc(r.name)}?</h3>
    <div class="rmwhy" role="radiogroup" aria-label="Why is it leaving?">${RM_REASONS.filter(x => !x.sealed || rmSealed(r)).map(x =>
      `<button type="button" role="radio" class="chip" aria-checked="${x.k === RM.reason}" data-why="${x.k}">${x.label}</button>`).join("")}</div>
    ${r.qty > 1 ? `<label class="field"><span>How many (you have ${int(r.qty)})</span><input id="rmqty" type="number" inputmode="numeric" min="1" max="${r.qty}" value="${esc(RM.qty)}"></label>` : ""}
    ${RM.reason === "sold" ? `<label class="field"><span>Sold for, each ($)</span><input id="rmprice" inputmode="decimal" placeholder="${esc(r.price.toFixed(2))}" value="${esc(RM.price)}"></label>` : ""}
    ${why && why.note ? `<label class="field"><span>Note</span><input id="rmnote" maxlength="200" placeholder="${esc(why.note)}" value="${esc(RM.note)}"></label>` : ""}
    <p class="note" id="rmwhat" style="margin:0">${rmWhat()}</p>
    ${getPass() ? "" : `<label class="field"><span>Scanner passcode</span><input id="rmpass" type="password" autocomplete="current-password" value="${esc(RM.pw)}"></label>`}
    ${RM.err ? `<div class="secerr" role="alert">${esc(RM.err)}</div>` : ""}
    <div class="rmbar"><button class="btn" type="button" id="rmcancel">Cancel</button><button class="btn rmgo" type="button" id="rmgo"${RM.busy || !RM.reason ? " disabled" : ""}>${RM.busy ? '<span class="spin" aria-hidden="true"></span> Removing' : "Remove"}</button></div>
  </div>`;
}
function renderRemove(){
  const box = $("drm");
  if (!box || !RM.r) return;
  box.innerHTML = removeView();
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on("rmopen", () => { Object.assign(RM, {open:true, err:"", batch:Date.now().toString(36) + Math.random().toString(36).slice(2, 8)}); renderRemove(); $("drm").scrollIntoView({block:"end", behavior:"smooth"}); });
  on("rmcancel", () => { Object.assign(RM, {open:false, err:"", qty:1, reason:"", price:"", note:""}); renderRemove(); });
  on("rmgo", doRemove);
  on("rmpulls", () => { $("detail").close(); openScan(); });
  box.querySelectorAll("[data-why]").forEach(b => b.onclick = () => { RM.reason = b.dataset.why; RM.err = ""; renderRemove(); });
  const keep = (id, k, after) => { const el = $(id); if (el) el.oninput = () => { RM[k] = el.value; if (after) after(); }; };
  keep("rmqty", "qty", () => { $("rmwhat").innerHTML = rmWhat(); });
  keep("rmprice", "price");
  keep("rmnote", "note");
  keep("rmpass", "pw");
}
async function doRemove(){
  if (!RM.reason) return;
  if ($("rmpass")) {
    if (!RM.pw.trim()) { RM.err = "Type the scanner passcode first."; renderRemove(); return; }
    setPass(RM.pw.trim());
  }
  const r = RM.r;
  Object.assign(RM, {busy:true, err:""}); renderRemove();
  try {
    RM.done = await scanCall({action:"remove", item:{name:r.name, set:r.set, number:r.num, loc:r.loc}, qty:rmCount(), batch:RM.batch,
      why:{reason:RM.reason, price:RM.reason === "sold" ? RM.price : "", note:RM.reason === "mistake" ? "" : RM.note}}, 45000);
    loadAll(); // the list behind updates while this message shows
  } catch(e) {
    if (e.code === "pass" || e.code === "locked") { setPass(""); RM.pw = ""; }
    RM.err = e.message === "Unknown request." ? "Removing needs the newest Scan.gs: paste it into Apps Script and deploy a new version." : e.message;
  }
  RM.busy = false; renderRemove();
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

/* ---------- loading creatures ---------- */
// Original drawings (not any game's characters). While the sheet refreshes, a phoenix flips, casts a fireball
// that writes "Refreshing" in fire, the word burns to ash, and it casts again (one 3.6s loop, timed in app.css).
// A raiju, the lightning beast of Japanese folklore, gallops while a scan runs. Reduce Motion stills both.
const PHOENIX = `<svg class="phx" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <linearGradient id="phxBody" gradientUnits="userSpaceOnUse" x1="86" y1="22" x2="10" y2="84"><stop offset="0" stop-color="#FFD45C"/><stop offset=".4" stop-color="#F59A22"/><stop offset=".75" stop-color="#E0461F"/><stop offset="1" stop-color="#B8321F"/></linearGradient>
    <radialGradient id="phxWingF" gradientUnits="userSpaceOnUse" cx="60" cy="44" r="56"><stop offset="0" stop-color="#E0461F"/><stop offset=".4" stop-color="#F59A22"/><stop offset=".75" stop-color="#FFC83D"/><stop offset="1" stop-color="#FFF3C4"/></radialGradient>
    <radialGradient id="phxWingB" gradientUnits="userSpaceOnUse" cx="57" cy="42" r="52"><stop offset="0" stop-color="#8E1F12"/><stop offset=".5" stop-color="#C8321F"/><stop offset="1" stop-color="#F28A1E"/></radialGradient>
    <radialGradient id="phxPlume" gradientUnits="userSpaceOnUse" cx="38" cy="66" r="56"><stop offset="0" stop-color="#FFC83D"/><stop offset=".35" stop-color="#F28A1E"/><stop offset=".8" stop-color="#D6402B"/><stop offset="1" stop-color="#8E1F12"/></radialGradient>
    <linearGradient id="phxCrest" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#F28A1E"/><stop offset="1" stop-color="#FFF3C4"/></linearGradient>
    <filter id="phxBlur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.2"/></filter>
    <clipPath id="phxClip"><path d="M70 23 C77 21 83 25 84 31 C84 35 81 38 79 40 C76 46 70 50 65 55 C57 63 46 70 34 74 C26 77 18 79 12 82 C17 74 22 70 27 66 C21 67 17 67 13 68 C21 59 30 55 40 52 C50 48 57 41 61 33 C63 27 66 24 70 23 Z"/></clipPath>
  </defs>
  <g class="phx-ember"><circle cx="24" cy="82" r="1.6" fill="#FFC83D"/><circle cx="12" cy="74" r="1.2" fill="#F28A1E"/><circle cx="32" cy="88" r="1" fill="#FFF3C4"/><circle cx="18" cy="90" r="1.3" fill="#FFC83D"/><circle cx="6" cy="84" r=".9" fill="#FFF3C4"/></g>
  <g class="phx-flip">
    <path class="phx-aura" d="M70 23 C77 21 83 25 84 31 C84 35 81 38 79 40 C76 46 70 50 65 55 C57 63 46 70 34 74 C26 77 18 79 12 82 C17 74 22 70 27 66 C21 67 17 67 13 68 C21 59 30 55 40 52 C50 48 57 41 61 33 C63 27 66 24 70 23 Z" fill="#FF7A1A" filter="url(#phxBlur)" opacity=".4"/>
    <g class="phx-rib r1"><path d="M36.3 63.1 C22.7 65.9 16.8 82.1 3.4 86 C18.5 85 25.4 70.6 39.7 68.9 Z" fill="url(#phxPlume)"/><path d="M3.4 86 Q8.3 79.2 10.9 81.7 Q11.7 85.1 3.4 86 Z" fill="#FFC83D"/><circle cx="8.6" cy="83" r="1.2" fill="#B8321F"/><path d="M37.9 62 C19.9 57.4 2.5 71.2 -16 67.9 C2.7 75.2 20.1 63.8 38.1 70 Z" fill="url(#phxPlume)"/><path d="M-14.8 67.8 Q-7.3 64.2 -6.2 67.5 Q-7 71 -14.8 67.8 Z" fill="#FFC83D"/><circle cx="-8.8" cy="67.6" r="1.2" fill="#B8321F"/><path d="M39.4 63.1 C28.9 53.1 11.6 56.9 0.3 47.6 C10.2 59.8 26.6 57.7 36.6 68.9 Z" fill="url(#phxPlume)"/><path d="M0.4 47.7 Q8.8 48 8.2 51.5 Q5.8 54.1 0.4 47.7 Z" fill="#FFC83D"/><circle cx="5.9" cy="50.3" r="1.2" fill="#B8321F"/></g>
    <g class="phx-rib r2"><path d="M37 62.3 C23.5 73 5.4 66.6 -8.4 78.4 C6.3 70.2 25 78.8 39 69.7 Z" fill="url(#phxPlume)"/><path d="M-7.7 78.3 Q-1.2 73 0.7 76 Q0.6 79.5 -7.7 78.3 Z" fill="#FFC83D"/><circle cx="-1.9" cy="76.7" r="1.2" fill="#B8321F"/><path d="M38.7 62.5 C21.4 64.6 7.1 52.5 -10.9 55.6 C6.4 56 20.2 70.3 37.3 69.5 Z" fill="url(#phxPlume)"/><path d="M-10.1 55.8 Q-1.9 54 -1.6 57.6 Q-3.3 60.7 -10.1 55.8 Z" fill="#FFC83D"/><circle cx="-4.2" cy="57" r="1.2" fill="#B8321F"/></g>
    <g transform="translate(-3 1) rotate(-10 57 42)"><g class="phx-wing back">
    <path d="M55.7 37.4 Q38.6 33 24.4 35.2 Q38.3 40.6 55.4 44.3 Z" fill="url(#phxWingB)"/>
    <path d="M55.6 40.9 Q38.5 37.2 27.5 36.2" stroke="#FF9A4A" stroke-width=".6" fill="none" opacity="0.35"/>
    <path d="M54.5 36 Q34.8 27.2 17.3 25.6 Q33 34.6 52.8 42.7 Z" fill="url(#phxWingB)"/>
    <path d="M53.7 39.4 Q33.8 31.2 20.8 27.4" stroke="#FF9A4A" stroke-width=".6" fill="none" opacity="0.35"/>
    <path d="M53.3 34.8 Q33.1 20.8 14.1 14.4 Q29.8 27.6 50.3 41 Z" fill="url(#phxWingB)"/>
    <path d="M51.8 37.9 Q31.3 24.5 17.7 17.2" stroke="#FF9A4A" stroke-width=".6" fill="none" opacity="0.35"/>
    <path d="M52 33.7 Q33.6 14.5 15 3.4 Q28.9 20.5 47.8 39.2 Z" fill="url(#phxWingB)"/>
    <path d="M49.9 36.4 Q31.1 17.8 18.2 7" stroke="#FF9A4A" stroke-width=".6" fill="none" opacity="0.35"/>
    <path d="M50.7 32.8 Q36.6 10.2 20.8 -4.6 Q30.8 15 45.4 37.2 Z" fill="url(#phxWingB)"/>
    <path d="M48 35 Q33.5 12.8 23.2 -0.4" stroke="#FF9A4A" stroke-width=".6" fill="none" opacity="0.35"/>
    <path d="M49.2 31.9 Q41.1 8.7 29.5 -7.6 Q34.4 12.2 43.1 35.1 Z" fill="url(#phxWingB)"/>
    <path d="M46.1 33.5 Q37.5 10.6 30.7 -3.3" stroke="#FF9A4A" stroke-width=".6" fill="none" opacity="0.35"/>
    <path d="M47.6 31.1 Q45.6 10.6 38.5 -4.6 Q38.3 12.7 40.9 33 Z" fill="url(#phxWingB)"/>
    <path d="M44.2 32 Q41.6 11.7 38.6 -0.8" stroke="#FF9A4A" stroke-width=".6" fill="none" opacity="0.35"/>
    <path d="M55.8 37.5 Q45.8 30.9 35.8 30.4 Q43.6 37.1 53.8 43.1 Z" fill="#B8321F" opacity=".9"/>
    <path d="M54.5 36.3 Q44.6 26.9 33.8 23.6 Q41.2 32.5 51.4 41.4 Z" fill="#B8321F" opacity=".9"/>
    <path d="M53.1 35.2 Q44.6 23.2 34 17.1 Q40.1 27.9 49 39.5 Z" fill="#B8321F" opacity=".9"/>
    <path d="M51.6 34.2 Q45.8 20.7 36.7 12.5 Q40.4 24.4 46.7 37.6 Z" fill="#B8321F" opacity=".9"/>
    <path d="M50.1 33.3 Q47.6 19.9 40.7 10.9 Q41.5 22.3 44.5 35.5 Z" fill="#B8321F" opacity=".9"/>
    <path d="M48.3 32.4 Q49.1 21 44.6 12.5 Q42.6 22.1 42.5 33.5 Z" fill="#B8321F" opacity=".9"/>
    <path d="M58.8 37.1 Q51.3 27.9 40.6 28.1 Q45.7 37.5 53.7 45.8 Z" fill="#D6402B"/>
    <path d="M57.1 38.6 Q52.6 32.6 46.2 31.8 Q49.2 37.6 54 43.2 Z" fill="#F28A1E" opacity=".85"/>
    </g></g>
    <g class="phx-flick"><path d="M52 46 q-3 -6 -1 -11 q1 4 4 6 q1 -3 0 -6 q4 4 2 11 Z" fill="#F28A1E"/><path d="M58 41 q-3 -6 -1 -11 q1 4 4 6 q1 -3 0 -6 q4 4 2 11 Z" fill="#FFC83D"/><path d="M46 50 q-3 -6 -1 -11 q1 4 4 6 q1 -3 0 -6 q4 4 2 11 Z" fill="#D6402B"/><path d="M63 35 q-3 -6 -1 -11 q1 4 4 6 q1 -3 0 -6 q4 4 2 11 Z" fill="#F59A22"/></g>
    <path d="M70 23 C77 21 83 25 84 31 C84 35 81 38 79 40 C76 46 70 50 65 55 C57 63 46 70 34 74 C26 77 18 79 12 82 C17 74 22 70 27 66 C21 67 17 67 13 68 C21 59 30 55 40 52 C50 48 57 41 61 33 C63 27 66 24 70 23 Z" fill="url(#phxBody)"/>
    <path d="M36 56 q2 2.4 4 0 M40.6 53.4 q2 2.4 4 0 M45.2 50.8 q2 2.4 4 0 M49.8 48.2 q2 2.4 4 0 M54.4 45.6 q2 2.4 4 0 M59 43 q2 2.4 4 0 M63.6 40.4 q2 2.4 4 0 M68.2 37.8 q2 2.4 4 0 M72.8 35.2 q2 2.4 4 0 M38.2 59.6 q2 2.4 4 0 M42.8 57 q2 2.4 4 0 M47.4 54.4 q2 2.4 4 0 M52 51.8 q2 2.4 4 0 M56.6 49.2 q2 2.4 4 0 M61.2 46.6 q2 2.4 4 0 M65.8 44 q2 2.4 4 0 M70.4 41.4 q2 2.4 4 0 M75 38.8 q2 2.4 4 0 M40.4 63.2 q2 2.4 4 0 M45 60.6 q2 2.4 4 0 M49.6 58 q2 2.4 4 0 M54.2 55.4 q2 2.4 4 0 M58.8 52.8 q2 2.4 4 0 M63.4 50.2 q2 2.4 4 0 M68 47.6 q2 2.4 4 0 M72.6 45 q2 2.4 4 0 M77.2 42.4 q2 2.4 4 0 M42.6 66.8 q2 2.4 4 0 M47.2 64.2 q2 2.4 4 0 M51.8 61.6 q2 2.4 4 0 M56.4 59 q2 2.4 4 0 M61 56.4 q2 2.4 4 0 M65.6 53.8 q2 2.4 4 0 M70.2 51.2 q2 2.4 4 0 M74.8 48.6 q2 2.4 4 0 M79.4 46 q2 2.4 4 0 M44.8 70.4 q2 2.4 4 0 M49.4 67.8 q2 2.4 4 0 M54 65.2 q2 2.4 4 0 M58.6 62.6 q2 2.4 4 0 M63.2 60 q2 2.4 4 0 M67.8 57.4 q2 2.4 4 0 M72.4 54.8 q2 2.4 4 0 M77 52.2 q2 2.4 4 0 M81.6 49.6 q2 2.4 4 0" clip-path="url(#phxClip)" fill="none" stroke="#FFE08A" stroke-width=".55" opacity=".55"/>
    <path class="phx-core" d="M72 28 C76 29 78 32 77 36 C74 44 64 52 51 59 C43 63 35 67 27 73 C36 62 47 54 57 46 C63 40 67 31 72 28 Z" fill="#FFF3C4" opacity=".7"/>
    <g class="phx-crest" fill="url(#phxCrest)">
      <path d="M69 24 C64 17 63 10 66 3 C67 9 69 13 72 16 Z"/>
      <path d="M72 23 C70 15 72 8 78 3 C76 9 77 13 79 17 Z"/>
      <path d="M75 23 C76 16 81 11 88 9 C84 13 82 17 82 21 Z"/>
      <path d="M78 24 C81 19 87 17 94 18 C89 20 86 23 84 26 Z"/>
    </g>
    <path d="M71 26 C74 23.5 79 23 82 25 C79 24.8 76 25.5 73.5 27.5 Z" fill="#B8321F"/>
    <path d="M83 29 C88 28.6 92.5 31 94.5 34.5 C91 34 88 35 84 36.5 Z" fill="#B5521B"/>
    <path d="M83 29 C87 29 90.5 30.4 92.5 32.4 C89 31.2 86 31 83 31.2 Z" fill="#FFD45C"/>
    <circle cx="86.6" cy="31.2" r=".5" fill="#5A1A0E"/>
    <path d="M74 29.2 C75.8 27.2 79 27.2 80.6 29.2 C79 31 75.8 31 74 29.2 Z" fill="#FFC83D"/>
    <circle cx="77.6" cy="29.2" r="1.3" fill="#3A0E06"/><circle cx="78.2" cy="28.5" r=".55" fill="#FFF"/>
    <path d="M78 33 C80 34 82 34 84 33" stroke="#B8321F" stroke-width=".7" fill="none" stroke-linecap="round"/>
    <g class="phx-wing front">
    <path d="M58.6 39 Q40 34.2 24.6 36.6 Q39.7 42.5 58.3 46.5 Z" fill="url(#phxWingF)"/>
    <path d="M58.4 42.8 Q39.9 38.7 28 37.7" stroke="#FFF3C4" stroke-width=".6" fill="none" opacity="0.7"/>
    <path d="M57.3 37.5 Q35.9 27.9 16.8 26.2 Q33.9 35.9 55.5 44.8 Z" fill="url(#phxWingF)"/>
    <path d="M56.4 41.2 Q34.8 32.3 20.7 28.1" stroke="#FFF3C4" stroke-width=".6" fill="none" opacity="0.7"/>
    <path d="M56 36.2 Q34.1 20.9 13.4 14 Q30.4 28.3 52.7 42.9 Z" fill="url(#phxWingF)"/>
    <path d="M54.3 39.6 Q32.1 25 17.3 17" stroke="#FFF3C4" stroke-width=".6" fill="none" opacity="0.7"/>
    <path d="M54.6 35 Q34.6 14.2 14.4 2 Q29.5 20.7 50 40.9 Z" fill="url(#phxWingF)"/>
    <path d="M52.3 38 Q31.8 17.7 17.9 6" stroke="#FFF3C4" stroke-width=".6" fill="none" opacity="0.7"/>
    <path d="M53.1 34 Q37.9 9.4 20.6 -6.7 Q31.6 14.7 47.4 38.8 Z" fill="url(#phxWingF)"/>
    <path d="M50.2 36.4 Q34.4 12.3 23.2 -2.1" stroke="#FFF3C4" stroke-width=".6" fill="none" opacity="0.7"/>
    <path d="M51.5 33 Q42.7 7.8 30.1 -10 Q35.5 11.6 44.9 36.5 Z" fill="url(#phxWingF)"/>
    <path d="M48.2 34.8 Q38.8 9.9 31.4 -5.3" stroke="#FFF3C4" stroke-width=".6" fill="none" opacity="0.7"/>
    <path d="M49.7 32.1 Q47.6 9.8 39.9 -6.7 Q39.7 12.1 42.5 34.2 Z" fill="url(#phxWingF)"/>
    <path d="M46.1 33.2 Q43.3 11.1 40.1 -2.5" stroke="#FFF3C4" stroke-width=".6" fill="none" opacity="0.7"/>
    <path d="M58.7 39.1 Q47.8 32 37 31.4 Q45.4 38.7 56.5 45.2 Z" fill="#E0461F" opacity=".9"/>
    <path d="M57.3 37.8 Q46.6 27.6 34.8 24 Q42.8 33.6 53.9 43.3 Z" fill="#E0461F" opacity=".9"/>
    <path d="M55.8 36.6 Q46.5 23.5 35 16.9 Q41.6 28.7 51.3 41.3 Z" fill="#E0461F" opacity=".9"/>
    <path d="M54.2 35.5 Q47.9 20.8 38 12 Q41.9 24.8 48.8 39.2 Z" fill="#E0461F" opacity=".9"/>
    <path d="M52.5 34.5 Q49.8 20 42.3 10.1 Q43.1 22.6 46.4 37 Z" fill="#E0461F" opacity=".9"/>
    <path d="M50.6 33.6 Q51.4 21.2 46.5 12 Q44.4 22.4 44.2 34.7 Z" fill="#E0461F" opacity=".9"/>
    <path d="M62 38.6 Q53.8 28.6 42.2 28.9 Q47.7 39.1 56.5 48.1 Z" fill="#F59A22"/>
    <path d="M60.1 40.3 Q55.2 33.8 48.2 32.9 Q51.5 39.3 56.7 45.3 Z" fill="#FFD45C" opacity=".85"/>
    </g>
  </g>
</svg>`;
const RAIJU = `<svg class="rju" viewBox="0 0 160 96" aria-hidden="true">
  <defs>
    <linearGradient id="rjuBody" gradientUnits="userSpaceOnUse" x1="0" y1="22" x2="0" y2="74"><stop offset="0" stop-color="#7CC4FF"/><stop offset=".45" stop-color="#2F6FE4"/><stop offset="1" stop-color="#2647A8"/></linearGradient>
    <linearGradient id="rjuGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF6D6"/><stop offset=".5" stop-color="#FFC83D"/><stop offset="1" stop-color="#F29A1E"/></linearGradient>
    <radialGradient id="rjuShade" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#1E3F9E" stop-opacity=".55"/><stop offset="1" stop-color="#1E3F9E" stop-opacity="0"/></radialGradient>
    <filter id="rjuBlur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="rjuGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="rjuClip"><path d="M38 52 C40 44 52 40 70 41 C84 42 96 42 104 40 C109 37 112 31 118 27 C123 21 132 21 138 26 L148 32 C144 35 138 36 132 36 C127 37 123 40 120 44 C117 51 115 57 110 60 C98 63 80 61 66 60 C56 60 46 60 40 57 Z"/></clipPath>
  </defs>
  <g class="rju-wind" stroke-linecap="round" stroke-width="2.2"><path d="M8 44 H28" stroke="#FFC83D"/><path d="M16 58 H34" stroke="#5FD4FF"/><path d="M6 70 H20" stroke="#FFC83D"/><path d="M22 34 H36" stroke="#5FD4FF"/></g>
  <g class="rju-bob">
    <path class="rju-aura" d="M38 52 C40 44 52 40 70 41 C84 42 96 42 104 40 C109 37 112 31 118 27 C123 21 132 21 138 26 L148 32 C144 35 138 36 132 36 C127 37 123 40 120 44 C117 51 115 57 110 60 C98 63 80 61 66 60 C56 60 46 60 40 57 Z" fill="#5FD4FF" filter="url(#rjuBlur)" opacity=".45"/>
    <g class="rju-tail" filter="url(#rjuGlow)">
      <path d="M41 51 L28 47 L32 44 L16 38 L23 36 L6 28 L30 34 L24 37 L38 41 L33 43 Z" fill="#5FD4FF" stroke="#2F6FE4" stroke-width="1" stroke-linejoin="round"/>
      <path d="M40 48 L24 40 L29 37 L12 26 L20 25 L2 12 L28 24 L22 26 L36 34 L31 36 Z" fill="url(#rjuGold)" stroke="#2F6FE4" stroke-width="1.4" stroke-linejoin="round"/>
      <path class="rju-flick" d="M38 46 L26 38 L30 36 L16 26 L22 25 L8 15" fill="none" stroke="#FFFFFF" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>
    </g>
    <g class="rju-leg back far"><path d="M44 50 C42 58 46 64 44 70 L41 80 C40 83 45 84 47 83 L45 80 L49 70 C53 62 54 56 54 50 Z" fill="#2A4FB8"/><path d="M40.0 76.0 l-3 -2 l2.6 -.6 l-2.4 -3 l3.6 1.6 l1 -2.6 l1.8 3.4 Z" fill="#8FD0FF" opacity=".9"/><path d="M41.0 82.5 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M43.2 82.5 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M45.4 82.5 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path class="rju-paw" d="M39.0 85.5 l-4 1 l3 1.2 l-3.4 2.4" fill="none" stroke="#FFC83D" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></g><g class="rju-leg front far"><path d="M104 52 C103 60 105 68 106 74 L106 82 C106 85 111 85 113 84 L110 81 L110 74 C111 66 112 58 112 52 Z" fill="#2A4FB8"/><path d="M105.5 77.0 l-3 -2 l2.6 -.6 l-2.4 -3 l3.6 1.6 l1 -2.6 l1.8 3.4 Z" fill="#8FD0FF" opacity=".9"/><path d="M106.5 84.0 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M108.7 84.0 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M110.9 84.0 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path class="rju-paw" d="M104.5 87.0 l-4 1 l3 1.2 l-3.4 2.4" fill="none" stroke="#FFC83D" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></g>
    <path d="M38 52 C40 44 52 40 70 41 C84 42 96 42 104 40 C109 37 112 31 118 27 C123 21 132 21 138 26 L148 32 C144 35 138 36 132 36 C127 37 123 40 120 44 C117 51 115 57 110 60 C98 63 80 61 66 60 C56 60 46 60 40 57 Z" fill="url(#rjuBody)"/>
    <g clip-path="url(#rjuClip)">
      <ellipse cx="52" cy="54" rx="13" ry="10" fill="url(#rjuShade)"/>
      <ellipse cx="102" cy="52" rx="10" ry="9" fill="url(#rjuShade)"/>
      <path d="M50 44 C66 41 86 42 102 41" stroke="#B8E3FF" stroke-width="1.6" fill="none" opacity=".6"/>
    </g>
    <path d="M60.0 42.0 L62.0 40.2 L67.0 41.8 L69.0 40.0 L74.0 41.6 L76.0 39.8 L81.0 41.4 L83.0 39.6 L88.0 41.2 L90.0 39.4 L95.0 41.0 L97.0 39.2 L102.0 40.8 Z" fill="#8FD0FF" opacity=".55"/>
    <path d="M58.0 59.6 L59.4 62.1 L63.8 59.8 L65.1 62.3 L69.5 60.0 L70.9 62.6 L75.2 60.3 L76.6 62.8 L81.0 60.5 L82.4 63.0 L86.8 60.7 L88.1 63.2 L92.5 61.0 L93.9 63.5 L98.2 61.2 L99.6 63.7 L104.0 61.4 Z" fill="#2647A8"/>
    <g class="rju-vein" fill="none" stroke="#FFC83D" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" filter="url(#rjuGlow)">
      <path d="M62 47 L68 50 L66 52 L74 55"/>
      <path d="M80 45 L86 49 L84 51 L92 54"/>
    </g>
    <g class="rju-leg back near"><path d="M46 50 C44 58 49 64 47 71 L44 81 C43 84 48 85 50 84 L48 81 L52 71 C56 63 58 56 58 50 Z" fill="url(#rjuBody)"/><path d="M43.0 77.0 l-3 -2 l2.6 -.6 l-2.4 -3 l3.6 1.6 l1 -2.6 l1.8 3.4 Z" fill="#8FD0FF" opacity=".9"/><path d="M44.0 83.5 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M46.2 83.5 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M48.4 83.5 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path class="rju-paw" d="M42.0 86.5 l-4 1 l3 1.2 l-3.4 2.4" fill="none" stroke="#FFC83D" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></g><g class="rju-leg front near"><path d="M101 52 C100 60 102 68 103 75 L103 83 C103 86 108 86 110 85 L107 82 L107 75 C108 67 109 59 109 52 Z" fill="url(#rjuBody)"/><path d="M102.5 78.0 l-3 -2 l2.6 -.6 l-2.4 -3 l3.6 1.6 l1 -2.6 l1.8 3.4 Z" fill="#8FD0FF" opacity=".9"/><path d="M103.5 85.0 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M105.7 85.0 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path d="M107.9 85.0 l1.4 2.6 l.6 -2.6 Z" fill="#F2FBFF"/><path class="rju-paw" d="M101.5 88.0 l-4 1 l3 1.2 l-3.4 2.4" fill="none" stroke="#FFC83D" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></g>
    <path d="M108 44 L104 47 L109 48 L103 52 L109 52 L104 57 L111 55 L108 60 L114 55 L117 47 Z" fill="#E4F4FF"/>
    <path d="M120 27 L114 8 L127 23 Z" fill="#2A4FB8"/>
    <path d="M124 25 L122 5 L133 24 Z" fill="#2F6FE4"/><path d="M125.5 21 L124.5 10 L130 22 Z" fill="#FFC83D"/>
    <path d="M124.2 22 L122.4 17 L126.4 21 L125.4 15 L128 21.4" fill="none" stroke="#FFF6D6" stroke-width=".6"/>
    <path d="M122 36 L114 38 L119 39.5 L113 42 L120 42 L116 46 L123 42 Z" fill="#E4F4FF"/>
    <path d="M128 25 C131 23 136 23 139 25" stroke="#2647A8" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    <path d="M134 31 C140 30 145 31 148 32" stroke="#B8E3FF" stroke-width="1" fill="none" opacity=".8"/>
    <path d="M130.5 28 C133 25.8 137 25.8 139.5 28 C137 30 133 30 130.5 28 Z" fill="#FFC83D" filter="url(#rjuGlow)"/>
    <ellipse cx="135.4" cy="28" rx=".7" ry="1.7" fill="#1B2A55"/><circle cx="136.5" cy="27.2" r=".45" fill="#FFF"/>
    <path d="M141 34.6 C143 35.4 145.5 35.2 147 34.2" stroke="#1B2A55" stroke-width=".8" fill="none" stroke-linecap="round"/>
    <circle cx="148" cy="32" r="1.6" fill="#1B2A55"/>
    <g class="rju-whisk" stroke="#5FD4FF" stroke-width=".7" fill="none" stroke-linecap="round"><path d="M143 33 l5 -2 l-2 2 l6 -1"/><path d="M143 34.5 l5 1 l-2 .6 l6 1.6"/></g>
    <g class="rju-mane" fill="none" stroke-linejoin="round" stroke-linecap="round" filter="url(#rjuGlow)">
      <path d="M121 24 L113 28 L117 29 L106 34 L110 35 L96 40" stroke="#FFC83D" stroke-width="2.2"/>
      <path d="M120 30 L110 34 L114 36 L100 41 L104 42 L88 45" stroke="#5FD4FF" stroke-width="2"/>
      <path d="M119 21 L112 22 L115 24 L104 27 L108 28 L98 32" stroke="#FFF6D6" stroke-width="1.4"/>
      <path d="M118 34 L108 39 L112 40 L96 46 L99 47 L84 50" stroke="#FFC83D" stroke-width="1.6"/>
    </g>
  </g>
  <g class="rju-spark" stroke-linejoin="round" stroke-width="1">
    <path d="M96 10 l-5 8 h4 l-3 7 l8 -10 h-4 l3 -5z" fill="#FFC83D" stroke="#F29A1E"/>
    <path d="M70 18 l-4 6 h3 l-2 5 l6 -7 h-3 l2 -4z" fill="#5FD4FF" stroke="#2F6FE4"/>
    <path d="M150 48 l-4 6 h3 l-2 5 l6 -7 h-3 l2 -4z" fill="#FFC83D" stroke="#F29A1E"/>
    <path d="M28 78 l-4 6 h3 l-2 5 l6 -7 h-3 l2 -4z" fill="#5FD4FF" stroke="#2F6FE4"/>
    <path d="M128 6 l-3 5 h2.4 l-1.6 4 l5 -6 h-2.6 l1.6 -3z" fill="#FFF6D6" stroke="#5FD4FF"/>
  </g>
</svg>`;

/* ---------- loading ---------- */
/* Fetches every tab in one request to Code.gs (doGet with ?data=1). Keeps the last good copy if a refresh fails. */
async function fetchData(){
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(API + "?data=1&t=" + Date.now(), {cache:"no-store", signal:ctl.signal});
    if (!res.ok) throw new Error("The sheet answered with error " + res.status + ".");
    const d = await res.json();
    if (d && d.error) throw new Error(d.error);
    if (!rightSheet(d)) { const e = new Error(""); e.code = "wrong_sheet"; throw e; }
    return d;
  } finally { clearTimeout(timer); }
}
// Never show another tracker's cards: the Apps Script says which sheet it read.
// Data without that tag (an older Code.gs) is still accepted, since each app has its own data link.
function rightSheet(d){
  return !!d && (!d.sheetId || d.sheetId === SHEET_ID);
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
// quiet: the 5-minute background refresh, which doesn't show the phoenix.
function loadAll(quiet){
  if (S.busy) return;
  S.busy = true; S.fx = !quiet; render();
  fetchData().then(d => {
    S.busy = false;
    apply(d);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch(e) {}
    render();
  }).catch(e => {
    S.busy = false;
    const err = {code: (e && e.code) || "error", message: e && e.name === "AbortError" ? "The sheet took too long to answer." : ((e && e.message) || "")};
    KEYS.forEach(k => S.err[k] = err);
    if (!S.data.collection) S.mode = "error";
    render();
  });
}
function boot(){
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); if (c && rightSheet(c)) apply(c); } catch(e) {}
  render();
  loadAll();
  // Refresh every 5 minutes while the app is on screen, and when you come back to it.
  setInterval(() => { if (!document.hidden) loadAll(true); }, 300000);
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
  $("loadfx").hidden = !(S.busy && S.fx);

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
  if (e.code === "wrong_sheet") return msg("Wrong sheet", "This app's data link answered with a different sheet than “" + CFG.sheetName + "”. Check that the app points at its own Apps Script link.", "Try again");
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
  const t = {}; TIERS.concat([{k:"other"}]).forEach(x => t[x.k] = {qty:0, value:0});
  let qty = 0, value = 0;
  for (const r of c) { qty += r.qty; value += r.total; const b = t[r.tier]; b.qty += r.qty; b.value += r.total; }
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
  document.querySelectorAll(".chip[data-filter]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.filter === S.filter)));
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
  const {c} = stats();
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
const SC = {step:"pick", cards:[], photo:"", err:"", note:"", cost:0, result:null, added:false, batch:"", lines:[], bmode:"add"};
/* Bulk counts: one count row per set and type, like "Journey Together non-foil bulk (count)".
   Trainers and basic Energy each share one row (Bulk Row 3 has no set dividers). Must match Scan.gs (SCAN_BULK). */
const BULK = {
  nonfoil: {label:"Commons & uncommons", row:"non-foil bulk", where:"Bulk Row 2", price:0.15},
  reverse: {label:"Reverse holos (C/U)", row:"reverse holo bulk", where:"Bulk Row 1 Back", price:0.25},
  holo: {label:"Holo rares", row:"holo rare bulk", where:"Bulk Row 1 Back", price:0.20},
  trainer: {label:"Trainers", fixed:"Trainer bulk (count)", where:"Bulk Row 3 – Trainers", price:0.10},
  energy: {label:"Basic Energy", fixed:"Basic Energy (count)", where:"Bulk Row 3 – Basic Energy", price:0.05}
};
const bulkName = (set, kind) => BULK[kind].fixed || (String(set || "").trim() + " " + BULK[kind].row + " (count)");
function bulkNow(set, kind){
  const n = normName(bulkName(set, kind));
  const r = (S.data.collection || []).find(x => normName(x.name) === n);
  return r ? r.qty : null;
}
// Which scanned cards default to "add to the bulk count": cheap commons/uncommons (normal or reverse holo), as Jeff counts those per set.
const bulkByDefault = c => c.kind !== "sealed" && /^(common|uncommon)/i.test(c.rarity || "") && (c.finish === "normal" || c.finish === "reverse")
  && isFinite(parseFloat(c.price)) && parseFloat(c.price) < 2;
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
  if (c.bulk && p < 2) return {tier:"bulk", text:"Add to " + (c.category === "Trainer" ? "Trainer bulk" : c.category === "Energy" && c.basicEnergy ? "Basic Energy"
    : c.set + (c.finish === "reverse" || /reverse/i.test(c.rarity || "") ? " reverse holo" : c.foil ? " holo rare" : " non-foil")) + " count"};
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
  SC.step = getPass() ? (SC.cards.length ? "review" : SC.step === "bulk" ? "bulk" : "pick") : "pass";
  renderScan();
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
}
function resetScan(){ Object.assign(SC, {step:"pick", cards:[], photo:"", err:"", note:"", cost:0, result:null, batch:"", lines:[], bmode:"add"}); }
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
      <button class="btn big" type="button" id="sbulk">Add bulk counts <span class="muted">· no photo</span></button>
      <ul class="tips">
        <li>Up to 9 cards, flat on a plain background, in rows like a binder page.</li>
        <li>Good light and no glare on the bottom corners, where the set number is.</li>
        <li>Nothing is added until you check the list and tap Add.</li>
      </ul>
      <p class="note" style="margin:0">Saves to “${esc(CFG.sheetName)}”. <button class="linkbtn" type="button" id="sforget">Forget passcode on this phone</button></p>`;
  } else if (SC.step === "working" || SC.step === "adding") {
    body = `${SC.photo ? `<img class="sphoto" src="${SC.photo}" alt="Your photo">` : ""}
      <div class="sbusy">${RAIJU}<p>${SC.step === "working" ? "Reading your cards and looking up prices…" : "Adding to “" + esc(CFG.sheetName) + "”…"}</p></div>
      <p class="note" style="margin:0;text-align:center">${SC.step === "working" ? "This usually takes 15–60 seconds." : ""}</p>`;
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
  } else if (SC.step === "bulk") {
    if (!SC.lines.length) SC.lines.push({kind:"nonfoil", set:"", qty:"", price:""});
    const sets = [...new Set((S.data.collection || []).map(r => String(r.set || "").replace(/\s*\(.*\)\s*$/, "").trim()).filter(x => x && !/^mixed$/i.test(x)))].sort();
    body = `${err}
      <p class="note" style="margin:0">Count cards you've sorted into the bulk box. Each line adds to that set's count row in “${esc(CFG.sheetName)}”, or starts one.</p>
      <datalist id="bsets">${sets.map(x => `<option value="${esc(x)}">`).join("")}</datalist>
      <div class="blines">${SC.lines.map(bulkLineView).join("")}</div>
      <button class="btn" type="button" id="badd" style="align-self:flex-start">+ Add another line</button>
      <fieldset class="bmode"><legend class="note">Quantities</legend>
        <label class="check"><input type="radio" name="bmode" value="add"${SC.bmode === "add" ? " checked" : ""}> Add to what's already counted</label>
        <label class="check"><input type="radio" name="bmode" value="set"${SC.bmode === "set" ? " checked" : ""}> Replace the total (after a recount)</label>
      </fieldset>
      <div class="sbar">
        <button class="btn" type="button" id="sback">Back</button>
        <button class="btn primary" type="button" id="bsave" disabled>Save counts</button>
      </div>`;
  } else if (SC.step === "done") {
    const r = SC.result || {added:[], next:{}};
    const counts = r.added.filter(a => a.bulk).length, rows = r.added.length - counts;
    const title = r.bulkOnly ? `Updated ${counts} ${counts === 1 ? "count" : "counts"}` : `Added ${rows} ${rows === 1 ? "row" : "rows"}${counts ? ` and updated ${counts} ${counts === 1 ? "count" : "counts"}` : ""}`;
    body = `<div class="sdone"><h3>${title} in “${esc(CFG.sheetName)}”</h3>
      <ol class="sacts">${r.added.map(a => `<li class="t-${tierOf(a.loc)}"><b>${esc(a.name)}</b>${a.bulk ? ` <span class="muted">+${int(a.qty)}</span>` : `${a.qty > 1 ? " ×" + int(a.qty) : ""} <span class="muted">${usd(a.price)}</span>`}<div>${esc(a.action)}</div></li>`).join("")}</ol>
      ${r.grading ? `<p class="note" style="margin:0">${r.grading === 1 ? "1 card is" : r.grading + " cards are"} on the Grading tab. Add PSA prices there to get the grade-or-skip verdict.</p>` : ""}
      ${r.next ? `<div class="spots"><div class="spot"><div class="eyebrow">Next binder slot</div><div class="v">${esc(r.next.binder || "–")}</div></div><div class="spot"><div class="eyebrow">Next buffer</div><div class="v">${esc(r.next.buffer || "–")}</div></div></div>` : ""}
      </div>
      <div class="sbar"><button class="btn" type="button" id="sfinish">Done</button><button class="btn primary" type="button" id="smore">${r.bulkOnly ? "More counts" : "Scan more"}</button></div>`;
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
    ${c.kind !== "sealed" ? `<label class="check sbulk"${parseFloat(c.price) < 2 ? "" : " hidden"}><input type="checkbox" data-f="bulk" data-k="${k}"${c.bulk ? " checked" : ""}> Add to the bulk count instead of its own row</label>` : ""}
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
  on("smore", () => { const bulk = SC.result && SC.result.bulkOnly; resetScan(); if (bulk) SC.step = "bulk"; renderScan(); });
  on("sretake", () => { resetScan(); renderScan(); });
  on("sforget", () => { setPass(""); SC.step = "pass"; renderScan(); });
  on("sunlock", unlockScan);
  const pi = $("spass");
  if (pi) { pi.onkeydown = e => { if (e.key === "Enter") unlockScan(); }; setTimeout(() => pi.focus(), 50); }
  ["scam", "slib"].forEach(id => { const el = $(id); if (el) el.onchange = () => el.files && el.files[0] && runScan(el.files[0]); });
  on("sadd", addScan);
  on("sbulk", () => { SC.err = ""; SC.step = "bulk"; renderScan(); });
  on("sback", () => { SC.err = ""; SC.step = "pick"; renderScan(); });
  on("badd", () => { const last = SC.lines[SC.lines.length - 1] || {}; SC.lines.push({kind:last.kind || "nonfoil", set:BULK[last.kind] && !BULK[last.kind].fixed ? last.set || "" : "", qty:"", price:""}); renderScan(); const q = document.querySelectorAll("#scan [data-bf=qty]"); if (q.length) q[q.length - 1].focus(); });
  on("bsave", saveBulk);
  document.querySelectorAll("#scan [data-bdel]").forEach(b => b.onclick = () => { SC.lines.splice(+b.dataset.bdel, 1); renderScan(); });
  document.querySelectorAll("#scan input[name=bmode]").forEach(r => r.onchange = () => { SC.bmode = r.value; SC.lines.forEach((_, i) => bulkHint(i)); });
  document.querySelectorAll("#scan [data-bf]").forEach(el => {
    const upd = () => {
      const i = +el.closest("[data-b]").dataset.b, f = el.dataset.bf;
      SC.lines[i][f] = el.value;
      if (f === "kind") { renderScan(); return; }
      bulkHint(i);
    };
    el.oninput = upd; el.onchange = upd;
  });
  if (SC.step === "bulk") SC.lines.forEach((_, i) => bulkHint(i));
  document.querySelectorAll("#scan [data-skip]").forEach(b => b.onclick = () => { const c = SC.cards[+b.dataset.skip]; c.skip = !c.skip; renderScan(); });
  document.querySelectorAll("#scan [data-f]").forEach(el => {
    const upd = () => {
      const c = SC.cards[+el.dataset.k], f = el.dataset.f;
      c[f] = el.type === "checkbox" ? el.checked : el.value;
      if (f === "price" || f === "foil" || f === "bulk") refreshScanCard(+el.dataset.k);
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
  const bl = el.querySelector(".sbulk");
  if (bl) bl.hidden = !(parseFloat(c.price) < 2);
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
    SC.cards = (d.cards || []).map(c => Object.assign({skip:false}, c, {bulk:bulkByDefault(c)}));
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
      condition:c.condition, qty:c.qty, price:c.price, foil:!!c.foil, basicEnergy:!!c.basicEnergy, finish:c.finish, bulk:!!c.bulk && parseFloat(c.price) < 2}));
    SC.result = await scanCall({action:"add", cards, batch:SC.batch}, 90000);
    SC.added = true; SC.step = "done"; SC.cards = [];
  } catch(e) {
    if (e.code === "pass" || e.code === "locked") setPass("");
    SC.step = "review"; SC.err = e.message;
  }
  renderScan();
}

function bulkLineView(l, i){
  const b = BULK[l.kind] || BULK.nonfoil;
  return `<div class="bline" data-b="${i}">
    <div class="bhead"><label class="field"><span>Type</span><select data-bf="kind">${Object.keys(BULK).map(k => `<option value="${k}"${k === l.kind ? " selected" : ""}>${esc(BULK[k].label)}</option>`).join("")}</select></label>
      ${SC.lines.length > 1 ? `<button class="btn" type="button" data-bdel="${i}" aria-label="Remove this line" title="Remove this line">✕</button>` : ""}</div>
    ${b.fixed ? "" : `<label class="field"><span>Set</span><input data-bf="set" list="bsets" value="${esc(l.set)}" placeholder="Start typing, e.g. Journey Together" autocomplete="off"></label>`}
    <div class="sflds b2">
      <label class="field"><span>How many</span><input data-bf="qty" type="number" min="0" max="9999" inputmode="numeric" value="${esc(l.qty)}"></label>
      <label class="field"><span>$ per card <i class="muted">optional</i></span><input data-bf="price" inputmode="decimal" value="${esc(l.price)}" placeholder="${b.price.toFixed(2)}"></label>
    </div>
    <p class="note bnow" style="margin:0"></p>
  </div>`;
}
// Shows what each line will do ("Now 86 → 100") and turns Save on when every line is complete.
function bulkHint(i){
  const l = SC.lines[i], el = document.querySelector(`#scan [data-b="${i}"] .bnow`);
  const b = BULK[l.kind], q = parseInt(l.qty, 10), needSet = !b.fixed && !String(l.set || "").trim();
  if (el) {
    if (needSet) el.textContent = "Pick a set. Goes to " + b.where + " behind that set's divider.";
    else {
      const now = bulkNow(l.set, l.kind), name = bulkName(l.set, l.kind);
      const after = isFinite(q) ? (SC.bmode === "set" ? q : (now || 0) + q) : null;
      el.textContent = (now == null ? "New count row: " + name : "Now " + int(now) + " in " + name) + (after != null ? " → " + int(after) : "") + " · " + (b.fixed ? b.where : b.where + " – " + l.set.trim());
    }
  }
  const okLine = x => { const n = parseInt(x.qty, 10); return (BULK[x.kind].fixed || String(x.set || "").trim()) && isFinite(n) && (SC.bmode === "set" ? n >= 0 : n > 0); };
  const btn = $("bsave");
  if (btn) btn.disabled = !SC.lines.length || !SC.lines.every(okLine);
}
async function saveBulk(){
  const entries = SC.lines.map(l => ({set:BULK[l.kind].fixed ? "" : String(l.set || "").trim(), kind:l.kind, qty:parseInt(l.qty, 10) || 0, mode:SC.bmode, price:String(l.price || "").trim()}));
  SC.err = ""; SC.step = "adding"; renderScan();
  try {
    SC.result = await scanCall({action:"bulk", entries, batch:Date.now().toString(36) + Math.random().toString(36).slice(2, 8)}, 60000);
    SC.added = true; SC.step = "done"; SC.lines = [];
  } catch(e) {
    if (e.code === "pass" || e.code === "locked") { setPass(""); SC.step = "pass"; }
    else SC.step = "bulk";
    SC.err = e.message;
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
$("refresh").onclick = () => loadAll();
document.body.insertAdjacentHTML("beforeend", `<div class="loadfx" id="loadfx" role="status" hidden>${PHOENIX}<span class="fx-word" aria-hidden="true"><i class="fx-ball"></i>${[..."Refreshing"].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}${[[12, 0], [38, .15], [62, .3], [86, .45]].map(([x, d]) => `<i class="fx-ash" style="--x:${x}%;--d:${d}s"></i>`).join("")}</span><span class="sr">Refreshing</span></div>`);
setInterval(() => { if (!S.busy) $("stamp").textContent = ago(S.at.collection); }, 60000);
initScan();
boot();
