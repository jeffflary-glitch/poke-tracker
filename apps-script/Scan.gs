// Scan.gs — "Scan cards" for the tracker apps. The same file goes in BOTH Apps Script projects
// (Jeff's next to Code.gs, Max's next to Code-max.gs). Each project's main file says which sheet
// scans are written to (scanSheetId_), so a scan from Max's app can only ever touch Max's sheet.
//
// How a scan works:
//   1. The app sends a photo with the passcode → Claude (Sonnet 5.5, medium effort) reads every card.
//   2. Each card is looked up in TCGdex (free card database) to confirm it and get its TCGplayer market price.
//      Claude Haiku then searches the web for anything TCGdex can't settle: sealed product, cards with
//      no price or not found, and cards that are unsure or don't match. It confirms the card and its price.
//   3. You check the list in the app, fix anything, then tap Add → rows are written to Collection (A–K)
//      using the same storage rules as the chat skill, and $20+ cards also get a Grading row.
//      Cheap commons/uncommons can instead be added to their set's bulk count row.
// Bulk counts (no photo, no AI): "add 40 Journey Together non-foil" adds to that set's count row,
// or starts one, e.g. "Journey Together non-foil bulk (count)" in Bulk Row 2 – Journey Together.
//
// Settings live in Project Settings → Script Properties (never in the app or on GitHub):
//   ANTHROPIC_API_KEY  your Claude API key (sk-ant-…)
//   SCAN_PASSCODE      the passcode typed into the app once per phone

const SCAN_MODEL = 'claude-sonnet-5-5';
const SCAN_EFFORT = 'medium';
const SCAN_PRICE = {input: 2, output: 10};   // $ per million tokens for SCAN_MODEL, for the cost note in the app
const SCAN_TCG = 'https://api.tcgdex.net/v2/en';
const SCAN_TZ = 'America/Chicago';
const SCAN_BINDER_SLOTS = 360;

/* ---------- web entry ---------- */
// The app POSTs JSON as plain text: {action:"check"|"identify"|"add", pass, ...}
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    scanCheckPass_(req.pass);
    if (req.action === 'check') out = {ok: true, sheetId: scanSheetId_()};
    else if (req.action === 'identify') out = scanIdentify_(req.image, req.mediaType);
    else if (req.action === 'add') out = scanAdd_(req.cards, req.batch);
    else if (req.action === 'bulk') out = scanBulkOnly_(req.entries, req.batch);
    else throw new Error('Unknown request.');
  } catch (err) {
    out = {error: String((err && err.message) || err), code: (err && err.code) || ''};
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- passcode ---------- */
// Wrong passcodes are counted; after 10 in an hour, scanning is locked for the rest of that hour.
function scanCheckPass_(pass) {
  const want = PropertiesService.getScriptProperties().getProperty('SCAN_PASSCODE');
  if (!want) throw new Error('Scanning is not set up yet: add SCAN_PASSCODE in Apps Script → Project Settings → Script Properties.');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('scan-fails') || 0);
  if (fails >= 10) throw scanErr_('Too many wrong passcodes. Scanning is locked for up to an hour.', 'locked');
  if (String(pass || '') !== want) {
    cache.put('scan-fails', String(fails + 1), 3600);
    throw scanErr_('Wrong passcode.', 'pass');
  }
}
function scanErr_(msg, code) { const e = new Error(msg); e.code = code; return e; }

/* ---------- 1. identify ---------- */
function scanIdentify_(image, mediaType) {
  if (!image || typeof image !== 'string') throw new Error('No photo was sent.');
  if (image.length > 9500000) throw new Error('The photo is too large. Try again with a smaller photo.');
  mediaType = /^image\/(jpeg|png|webp)$/.test(mediaType) ? mediaType : 'image/jpeg';

  const known = scanSheetSets_();
  const ai = scanAskClaude_(image, mediaType, known.names);
  const cards = (ai.result.cards || []).map(c => scanEnrich_(c, known));
  const webCost = scanWebCheck_(cards.filter(scanNeedsWeb_));
  cards.forEach(scanChecks_);
  return {
    cards: cards,
    photoNote: ai.result.photoNote || '',
    cost: Math.round((ai.cost + webCost) * 10000) / 10000
  };
}

// Sealed product, no price, not found, unsure, or a set/name that didn't match (the only checks so far).
const scanNeedsWeb_ = c => c.kind === 'sealed' || c.price == null || c.confidence !== 'high' || c.checks.length > 0;

const SCAN_SYSTEM = [
  'You identify Pokémon TCG cards and sealed products in a photo for a collection tracker.',
  'List every card that is fully or mostly in frame, in reading order: left to right, top to bottom. Photos are often a 3×3 grid matching one binder page. Skip cards that are mostly out of frame. Never invent cards that are not in the photo.',
  '',
  'For each card:',
  '- name: exactly as printed, including "ex", "V", "VMAX", "VSTAR" and owner prefixes such as "Team Rocket\'s" or "Iono\'s".',
  '- set: the full English set name as TCGplayer and TCGdex write it, e.g. "Stellar Crown", "Journey Together", "Destined Rivals", "Prismatic Evolutions", "SWSH Black Star Promos", "Scarlet & Violet Black Star Promos". Read it from the printed set code and the number\'s total (the "/084" part), not from the artwork. Sets already in this collection are listed below; use one of those names when the code and total fit it.',
  '- setCode: the 3-letter set code printed next to the card number, exactly as printed (e.g. "PBL", "JTG"). Not the single regulation-mark letter. "" if no code is printed (older cards).',
  '- number: exactly as printed in the bottom corner, e.g. "053/159", "SWSH085", "TG05/TG30", "129".',
  '- rarity: one of Common, Uncommon, Rare, Holo Rare, Double Rare, Ultra Rare, Illustration Rare, Special Illustration Rare, Hyper Rare, ACE SPEC Rare, Shiny Rare, Promo, or the closest older rarity name. Do not add "(Reverse Holo)" here; use finish instead.',
  '- category: "Pokémon", "Trainer", "Energy", or "Sealed".',
  '- basicEnergy: true only for basic Energy cards.',
  '',
  'Finish (decide it yourself from the foil pattern):',
  '- Foil only inside the art window = "holo". Foil everywhere except the art window = "reverse". No foil = "normal".',
  '- Full-art, textured, ex, V, Illustration Rare and higher cards are "holo" (that is their only printing) unless the card clearly shows a reverse-holo frame.',
  '- Prismatic Evolutions reverse holos come in three patterns: standard (cobblestone background with the type symbol) = "reverse", Poké Ball pattern (repeated Poké Ball outlines) = "pokeball", Master Ball pattern (cracked-ice foil with a Master Ball print on the lower half) = "masterball". Trainers there use a brushed foil with Poké Ball outlines as their standard reverse.',
  '- foil: true if the card has any foil at all (holo, reverse, pokeball, masterball, full art), otherwise false.',
  '',
  'Condition: assume "NM" unless the photo shows whitening, creases, scratches or bends; then use "LP", "MP", "HP" or "DMG".',
  'confidence: "high", "medium" or "low". note: one short line on anything uncertain (e.g. "could be the reverse holo", "number partly hidden by glare"). Empty if nothing is uncertain.',
  'Sealed products (packs, tins, boxes, bundles): kind "sealed", name like "Destined Rivals Elite Trainer Box", set = the set it belongs to, number "", rarity "", category "Sealed", finish "normal".',
  'photoNote: one short line if the photo itself is a problem (blurry, glare, too far away), otherwise "".',
  'Do not estimate prices.'
].join('\n');

const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: {type: 'string', enum: ['card', 'sealed']},
          name: {type: 'string'},
          set: {type: 'string'},
          setCode: {type: 'string'},
          number: {type: 'string'},
          rarity: {type: 'string'},
          category: {type: 'string', enum: ['Pokémon', 'Trainer', 'Energy', 'Sealed']},
          basicEnergy: {type: 'boolean'},
          finish: {type: 'string', enum: ['normal', 'holo', 'reverse', 'pokeball', 'masterball']},
          foil: {type: 'boolean'},
          condition: {type: 'string', enum: ['NM', 'LP', 'MP', 'HP', 'DMG']},
          confidence: {type: 'string', enum: ['high', 'medium', 'low']},
          note: {type: 'string'}
        },
        required: ['kind', 'name', 'set', 'setCode', 'number', 'rarity', 'category', 'basicEnergy', 'finish', 'foil', 'condition', 'confidence', 'note'],
        additionalProperties: false
      }
    },
    photoNote: {type: 'string'}
  },
  required: ['cards', 'photoNote'],
  additionalProperties: false
};

function scanAskClaude_(image, mediaType, setNames) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('Scanning is not set up yet: add ANTHROPIC_API_KEY in Apps Script → Project Settings → Script Properties.');
  const body = {
    model: SCAN_MODEL,
    max_tokens: 8000,
    system: SCAN_SYSTEM + (setNames.length ? '\n\nSets already in this collection: ' + setNames.join(', ') + '.' : ''),
    output_config: {effort: SCAN_EFFORT, format: {type: 'json_schema', schema: SCAN_SCHEMA}},
    messages: [{role: 'user', content: [
      {type: 'image', source: {type: 'base64', media_type: mediaType, data: image}},
      {type: 'text', text: 'Identify every Pokémon card and sealed product in this photo.'}
    ]}]
  };
  let res;
  try {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {'x-api-key': key, 'anthropic-version': '2023-06-01'},
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (err) {
    throw new Error(/timed? ?out|timeout/i.test(String(err)) ? 'Claude took too long. Try a photo with fewer cards.' : 'Could not reach Claude: ' + err);
  }
  const code = res.getResponseCode();
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) {}
  if (code !== 200) {
    const m = (data.error && data.error.message) || ('error ' + code);
    if (code === 401) throw new Error('The Claude API key was rejected. Check ANTHROPIC_API_KEY in Script Properties.');
    if (code === 429 || code === 529) throw new Error('Claude is busy right now. Try again in a minute.');
    if (/credit balance/i.test(m)) throw new Error('Your Claude API credit has run out. Add credit in the Claude Console (Billing).');
    throw new Error('Claude answered with an error: ' + m);
  }
  if (data.stop_reason === 'refusal') throw new Error('Claude could not read this photo. Try another one.');
  if (data.stop_reason === 'max_tokens') throw new Error('Too many cards for one photo. Try 9 or fewer.');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let result;
  try { result = JSON.parse(text); } catch (e) { throw new Error('Claude\'s answer could not be read. Try again.'); }
  const u = data.usage || {};
  const tokensIn = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const cost = (tokensIn * SCAN_PRICE.input + (u.output_tokens || 0) * SCAN_PRICE.output) / 1e6;
  return {result: result, cost: Math.round(cost * 10000) / 10000};
}

/* ---------- TCGdex: confirm the card and get its price ---------- */
const scanNorm_ = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const scanNormSet_ = s => scanNorm_(String(s || '').replace(/\(.*?\)/g, ''));
const scanNumKey_ = n => { const x = String(n || '').split('/')[0].trim().toLowerCase().replace(/\s+/g, ''); return /^\d+$/.test(x) ? String(+x) : x; };
const scanCardName_ = n => String(n || '').replace(/\(.*?\)/g, '').trim();

function scanGetJSON_(url) {
  const r = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
  if (r.getResponseCode() !== 200) return null;
  try { return JSON.parse(r.getContentText()); } catch (e) { return null; }
}
// Saved for a few hours so a scan only fetches what it needs.
function scanCached_(key, hours, fn) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const v = fn();
  if (v) { try { cache.put(key, JSON.stringify(v), Math.round(hours * 3600)); } catch (e) {} }
  return v;
}
function scanSets_() {
  return scanCached_('tcg-setlist', 6, () => {
    const list = scanGetJSON_(SCAN_TCG + '/sets');
    if (!list) return null;
    const m = {};
    for (const s of list) {
      const k = scanNormSet_(s.name);
      if (k && !m[k]) m[k] = [s.id, (s.cardCount && s.cardCount.official) || 0, s.name];
    }
    return m;
  }) || {};
}
// One set's printed code (e.g. "PBL") and its cards by number.
function scanSetInfo_(id) {
  return scanCached_('tcg-setinfo-' + id, 12, () => {
    const s = scanGetJSON_(SCAN_TCG + '/sets/' + encodeURIComponent(id));
    if (!s) return null;
    const cards = {};
    for (const c of s.cards || []) cards[scanNumKey_(c.localId)] = c.id;
    return {code: String((s.abbreviation && s.abbreviation.official) || '').toUpperCase(), cards: cards};
  }) || {code: '', cards: {}};
}
const scanTotal_ = n => +(String(n || '').split('/')[1] || '').replace(/\D/g, '') || 0;
// The set whose printed code and total match the card (PBL + /084 → Pitch Black), or '' if none does.
// The code on the card decides, so a set newer than Claude's training can't be swapped for an older one.
function scanSetByCode_(code, total) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,4}$/.test(code) || !total) return '';
  const sets = scanSets_();
  for (const k in sets) {
    if (sets[k][1] === total && scanSetInfo_(sets[k][0]).code === code) return sets[k][2];
  }
  return '';
}
const scanOfficial_ = card => (card && card.set && card.set.cardCount && card.set.cardCount.official) || 0;

// Finds the card in TCGdex. A card only counts as found when its name matches and its set has the printed
// total (the "/084" in 045/084), so a wrong set name from the photo can't pick a different card.
function scanFindCard_(c) {
  const sets = scanSets_();
  const nk = scanNumKey_(c.number), name = scanCardName_(c.name), total = scanTotal_(c.number);
  if (!name || !nk) return null;
  const fits = card => !!card && scanNorm_(scanCardName_(card.name)) === scanNorm_(name)
    && (!total || !scanOfficial_(card) || scanOfficial_(card) === total);
  // 1. The set read from the photo
  let st = sets[scanNormSet_(c.set)];
  if (!st && /blackstarpromos$/.test(scanNormSet_(c.set))) st = sets[scanNormSet_(c.set).replace(/blackstarpromos$/, 'pblackstarpromos')];
  if (st) {
    const id = scanSetInfo_(st[0]).cards[nk];
    const card = id && scanGetJSON_(SCAN_TCG + '/cards/' + encodeURIComponent(id));
    if (fits(card)) return card;
  }
  // 2. The same name and number in any set
  const list = scanGetJSON_(SCAN_TCG + '/cards?name=eq:' + encodeURIComponent(name)) || [];
  for (const h of list.filter(x => scanNumKey_(x.localId) === nk).slice(0, 4)) {
    const card = scanGetJSON_(SCAN_TCG + '/cards/' + encodeURIComponent(h.id));
    if (fits(card)) return card;
  }
  return null;
}

// Sets already in the Collection tab: their names, and which set each printed total belongs to
// (e.g. 084 → Pitch Black). Used when a set is too new to be in the card database.
function scanSheetSets_() {
  const col = SpreadsheetApp.openById(scanSheetId_()).getSheetByName('Collection');
  const last = col ? scanFirstEmptyRow_(col) - 1 : 1;
  const rows = last >= 2 ? col.getRange(2, 2, last - 1, 2).getDisplayValues() : [];
  const names = {}, byTotal = {};
  for (const [set, num] of rows) {
    const name = String(set || '').replace(/\s*\(.*\)\s*$/, '').trim(), t = scanTotal_(num);
    if (!name || /^mixed$/i.test(name)) continue;
    names[name] = true;
    if (t && !/promo/i.test(name)) (byTotal[t] = byTotal[t] || {})[name] = true;
  }
  return {names: Object.keys(names).sort(), byTotal: byTotal};
}

const SCAN_VARIANTS = {
  normal: ['normal', 'unlimited'],
  holo: ['holofoil', 'unlimited-holofoil', 'holo'],
  reverse: ['reverse-holofoil', 'reverse', 'reverseHolofoil']
};
const SCAN_VARIANT_LABEL = {normal: 'Normal', holofoil: 'Holo', 'unlimited-holofoil': 'Holo', holo: 'Holo', unlimited: 'Normal',
  'reverse-holofoil': 'Reverse holo', reverse: 'Reverse holo', reverseHolofoil: 'Reverse holo', '1st-edition': '1st edition', '1st-edition-holofoil': '1st edition holo'};

function scanPrices_(card) {
  const t = card && card.pricing && card.pricing.tcgplayer;
  const out = {};
  if (!t) return out;
  for (const k in t) {
    const v = t[k];
    if (!v || typeof v !== 'object') continue;
    const p = [v.marketPrice, v.midPrice, v.lowPrice].find(x => typeof x === 'number' && x > 0);
    if (p) out[k] = Math.round(p * 100) / 100;
  }
  return out;
}

function scanPad3_(s) { return /^\d+$/.test(s) && s.length < 3 ? ('00' + s).slice(-3) : s; }

// Turns Claude's reading into a row ready to check in the app: confirmed name/set/number, price and warnings.
function scanEnrich_(c, known) {
  const out = {
    kind: c.kind === 'sealed' || c.category === 'Sealed' ? 'sealed' : 'card',
    name: String(c.name || '').trim(),
    set: String(c.set || '').trim(),
    setCode: String(c.setCode || '').trim().toUpperCase(),
    number: String(c.number || '').trim().toUpperCase(),
    rarity: String(c.rarity || '').trim(),
    category: ['Pokémon', 'Trainer', 'Energy', 'Sealed'].find(x => x.toLowerCase() === String(c.category || '').toLowerCase()) || 'Pokémon',
    basicEnergy: !!c.basicEnergy,
    finish: c.finish || 'normal',
    foil: !!c.foil || (c.finish && c.finish !== 'normal'),
    condition: c.condition || 'NM',
    confidence: c.confidence || 'medium',
    note: c.note || '',
    qty: 1,
    price: null,
    priceNote: '',
    others: [],
    image: '',
    checks: []
  };
  if (out.kind === 'sealed') {
    out.category = 'Sealed'; out.number = ''; out.rarity = ''; out.foil = false;
    out.priceNote = 'No price found online. Enter the TCGplayer price.';   // replaced when the web search finds one
    return out;
  }
  let card = null;
  try {
    const bySet = scanSetByCode_(out.setCode, scanTotal_(out.number));
    if (bySet && scanNormSet_(bySet) !== scanNormSet_(out.set)) {
      out.checks.push('Set changed from ' + out.set + ' to ' + bySet + ' to match the printed code ' + out.setCode + '.');
      out.set = bySet;
    }
    card = scanFindCard_(out);
  } catch (e) {}
  if (card) {
    if (card.set && card.set.name) out.set = card.set.name;
    if (card.image) out.image = card.image + '/low.webp';
    // Card number as the sheet writes it: "053/159"; promos and other codes stay as printed
    const off = card.set && card.set.cardCount && card.set.cardCount.official;
    if (out.number.indexOf('/') < 0 && /^\d+$/.test(String(card.localId)) && off && !/promo/i.test(out.set)) {
      out.number = scanPad3_(String(card.localId)) + '/' + scanPad3_(String(off));
    }
    if (scanNorm_(scanCardName_(card.name)) !== scanNorm_(scanCardName_(out.name))) {
      out.checks.push('The card database lists ' + out.number + ' in ' + out.set + ' as "' + card.name + '". Check the name and number.');
      out.confidence = 'low';
    }
    const prices = scanPrices_(card);
    const keys = SCAN_VARIANTS[out.finish] || [];
    let key = keys.find(k => prices[k] != null);
    const all = Object.keys(prices);
    if (!key && all.length === 1 && (out.finish === 'holo' || out.finish === 'normal' || out.finish === 'reverse')) {
      key = all[0];
      if (out.finish === 'reverse' && !/reverse/i.test(key)) out.priceNote = 'No reverse holo price listed; using the ' + (SCAN_VARIANT_LABEL[key] || key) + ' price.';
    }
    if (key) {
      out.price = prices[key];
      out.priceNote = out.priceNote || 'TCGplayer market price (' + (SCAN_VARIANT_LABEL[key] || key) + ').';
    } else {
      out.priceNote = out.finish === 'pokeball' || out.finish === 'masterball'
        ? 'Poké Ball / Master Ball pattern prices aren\'t in the database. Enter the TCGplayer price.'
        : 'No price found. Enter the TCGplayer price.';
    }
    out.others = all.filter(k => k !== key).map(k => ({label: SCAN_VARIANT_LABEL[k] || k, price: prices[k]}));
  } else {
    // Too new for the card database: if the printed total belongs to exactly one set in the sheet, use that set.
    const sets = Object.keys(known.byTotal[scanTotal_(out.number)] || {});
    if (sets.length === 1 && scanNormSet_(sets[0]) !== scanNormSet_(out.set)) {
      out.checks.push('Set changed from ' + out.set + ' to ' + sets[0] + ' to match the printed number ' + out.number + '.');
      out.set = sets[0];
    }
    out.priceNote = 'Card not found in the database. Check the set and number, and enter the TCGplayer price.';
    out.confidence = out.confidence === 'high' ? 'medium' : out.confidence;
  }
  if (out.finish === 'reverse' && !/reverse/i.test(out.rarity)) out.rarity = (out.rarity ? out.rarity + ' ' : '') + '(Reverse Holo)';
  if (out.finish === 'pokeball' && !/pok/i.test(out.rarity)) out.rarity = (out.rarity ? out.rarity + ' ' : '') + '(Poké Ball Reverse Holo)';
  if (out.finish === 'masterball' && !/master/i.test(out.rarity)) out.rarity = (out.rarity ? out.rarity + ' ' : '') + '(Master Ball Reverse Holo)';
  return out;
}

// Price warnings for cards, added once the final price is known (sealed product isn't routed by price).
function scanChecks_(c) {
  const p = c.price;
  if (c.kind === 'sealed' || p == null) return;
  if (p >= 20) c.checks.push('$20+ card: confirm the price on TCGplayer before filing.');
  else if (Math.abs(p - 20) <= 1 || Math.abs(p - 2) <= 1) c.checks.push('Close to the $' + (Math.abs(p - 20) <= 1 ? 20 : 2) + ' line: confirm the price on TCGplayer.');
  if (c.condition !== 'NM') c.checks.push('Priced as Near Mint; a ' + c.condition + ' copy sells for less.');
}

/* ---------- web check: price and verify what TCGdex couldn't settle ---------- */
// One web-search request per item, all sent at once. Haiku keeps this to about 1–3¢ per item,
// most of it the 1¢ per search. If nothing usable comes back, the item stays as TCGdex left it.
const SCAN_WEB_MODEL = 'claude-haiku-5-5';
const SCAN_WEB_EFFORT = 'medium';
const SCAN_WEB_PRICE = {input: 0.10, output: 0.50, search: 0.01};   // $ per million tokens, $ per search

const SCAN_WEB_SOURCES = [
  'Never use MSRP, presale prices, a single seller\'s asking price, or the lowest listing.',
  'End your answer with exactly one line of JSON and nothing after it, in this shape:'
];

const SCAN_SEALED_SYSTEM = [
  'You find the current US market price of one sealed Pokémon TCG product for a collection tracker.',
  'Search the web. Use the TCGplayer market price (what it has recently sold for) from tcgplayer.com or a site that shows it, such as pricecharting.com or pokeinvesting.com. If none is listed, use recent eBay sold prices.',
  'Match the exact product: same set and same product type (booster pack, sleeved booster, blister, booster bundle, Elite Trainer Box, Pokémon Center Elite Trainer Box, mini tin, tin, collection box, booster box). If the name doesn\'t say which design of a tin or box it is and the designs sell for different prices, use the typical price and say so in the note.',
  'Give the price of one unit.'
].concat(SCAN_WEB_SOURCES, [
  '{"price": 12.34, "product": "the product name the price is for", "source": "e.g. TCGplayer market price via PriceCharting", "note": ""}',
  'Use "price": null if you can\'t find a trustworthy current price.'
]).join('\n');

const SCAN_CARD_SYSTEM = [
  'You verify one Pokémon TCG card for a collection tracker and find its current US market price.',
  'Another model read the card from a photo, and a card database could not fully confirm it. The reading may be wrong about the set, the number or the name.',
  'Search the web to confirm which card it is. The printed set code and the total after the slash (the "084" in 045/084) identify the set more reliably than the set name; the number identifies the card within the set. Keep the name the photo shows unless that number in that set is clearly a different card.',
  'Then find the Near Mint TCGplayer market price (what it has recently sold for) for the stated finish: Normal, Holofoil, Reverse Holofoil, Poké Ball pattern or Master Ball pattern. Use tcgplayer.com or a site that shows TCGplayer prices: pricecharting.com, scrydex.com, pokemonwizard.com, pokeinvesting.com.'
].concat(SCAN_WEB_SOURCES, [
  '{"name": "card name as printed", "set": "full English set name as TCGplayer writes it", "number": "045/084", "price": 1.23, "source": "e.g. TCGplayer market price via Scrydex (Reverse Holofoil)", "confidence": "high", "note": ""}',
  'confidence is "high" when a source clearly shows this card, set and number; "medium" when it probably is; "low" when you couldn\'t confirm it.',
  'note: one short line on anything still uncertain (e.g. "could be the Poké Ball pattern, which sells for $8"), otherwise "".',
  'Use "price": null if you can\'t find a trustworthy current price for this finish.'
]).join('\n');

const SCAN_FINISH_LABEL = {normal: 'Normal (no foil)', holo: 'Holofoil', reverse: 'Reverse Holofoil',
  pokeball: 'Poké Ball pattern reverse holo', masterball: 'Master Ball pattern reverse holo'};

// What the web check is told about one item, including why it's being checked.
function scanWebQuestion_(c) {
  if (c.kind === 'sealed') return 'Sealed product: ' + c.name + (c.set ? '\nSet: ' + c.set : '');
  const why = c.checks.slice();
  if (c.price == null) why.push(c.priceNote);
  if (c.confidence !== 'high') why.push('The photo reading was only ' + c.confidence + ' confidence.');
  return [
    'Card name: ' + c.name,
    'Set: ' + c.set,
    'Set code printed on the card: ' + (c.setCode || 'none'),
    'Number: ' + c.number,
    'Rarity: ' + (c.rarity || 'unknown'),
    'Finish: ' + (SCAN_FINISH_LABEL[c.finish] || c.finish)
  ].concat(c.note ? ['Note from reading the photo: ' + c.note] : [], ['Why it is being checked: ' + why.join(' ')]).join('\n');
}

function scanWebCheck_(items) {
  if (!items.length) return 0;
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const request = (c, messages) => ({
    url: 'https://api.anthropic.com/v1/messages',
    method: 'post',
    contentType: 'application/json',
    headers: {'x-api-key': key, 'anthropic-version': '2023-06-01'},
    payload: JSON.stringify({
      model: SCAN_WEB_MODEL,
      max_tokens: 4000,
      system: c.kind === 'sealed' ? SCAN_SEALED_SYSTEM : SCAN_CARD_SYSTEM,
      output_config: {effort: SCAN_WEB_EFFORT},
      tools: [{type: 'web_search_20250305', name: 'web_search', max_uses: 3,
        user_location: {type: 'approximate', country: 'US', timezone: SCAN_TZ}}],
      messages: messages
    }),
    muteHttpExceptions: true
  });
  let cost = 0;
  let pending = items.map(c => ({c: c, messages: [{role: 'user', content: scanWebQuestion_(c)}]}));
  // A long search can pause partway ("pause_turn"); sending the answer so far back lets it finish.
  for (let round = 0; round < 3 && pending.length; round++) {
    let res;
    try { res = UrlFetchApp.fetchAll(pending.map(p => request(p.c, p.messages))); } catch (e) { break; }
    const again = [];
    res.forEach((r, i) => {
      if (r.getResponseCode() !== 200) return;
      let data;
      try { data = JSON.parse(r.getContentText()); } catch (e) { return; }
      const u = data.usage || {};
      cost += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)) * SCAN_WEB_PRICE.input / 1e6
        + (u.output_tokens || 0) * SCAN_WEB_PRICE.output / 1e6
        + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * SCAN_WEB_PRICE.search;
      const p = pending[i];
      if (data.stop_reason === 'pause_turn') {
        p.messages = p.messages.concat([{role: 'assistant', content: data.content}]);
        again.push(p);
        return;
      }
      const ans = scanWebAnswer_(data.content);
      if (ans) (p.c.kind === 'sealed' ? scanWebSealed_ : scanWebCard_)(p.c, ans);
    });
    pending = again;
  }
  return cost;
}

// The JSON line at the end of the answer, with its price checked (null if missing or not a real price).
function scanWebAnswer_(content) {
  const text = (content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const found = text.match(/\{[^{}]*"price"[^{}]*\}/g);
  if (!found) return null;
  let r;
  try { r = JSON.parse(found[found.length - 1]); } catch (e) { return null; }
  const price = Number(r.price);
  r.price = r.price != null && r.price !== '' && isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null;
  r.source = r.source ? ' (' + r.source + ')' : '';
  return r;
}

function scanWebSealed_(c, r) {
  if (r.price == null) return;
  c.price = r.price;
  c.priceNote = 'Web price' + (r.product ? ' for ' + r.product : '') + r.source + '. Tap TCGplayer to double-check.';
  if (r.note) c.checks.push(String(r.note));
}

const scanFmtNumber_ = n => String(n).trim().toUpperCase().split('/').map(s => scanPad3_(s.trim())).join('/');

function scanWebCard_(c, r) {
  const conf = ['high', 'medium', 'low'].indexOf(r.confidence) >= 0 ? r.confidence : 'low';
  // A sure answer replaces the database's warnings; an unsure one only adds its note.
  if (conf === 'high') c.checks = [];
  const changed = [];
  if (conf !== 'low') {
    if (r.set && scanNormSet_(r.set) !== scanNormSet_(c.set)) { changed.push('set from ' + c.set + ' to ' + r.set); c.set = String(r.set); }
    if (r.number && scanNumKey_(r.number) !== scanNumKey_(c.number)) { changed.push('number from ' + c.number + ' to ' + scanFmtNumber_(r.number)); c.number = scanFmtNumber_(r.number); }
    if (r.name && scanNorm_(scanCardName_(r.name)) !== scanNorm_(scanCardName_(c.name))) { changed.push('name from ' + c.name + ' to ' + r.name); c.name = String(r.name); }
  }
  if (changed.length) {
    // The database's picture and other-version prices belonged to the card it guessed.
    c.checks.push('Web check changed the ' + changed.join(', ') + '.');
    c.image = '';
    c.others = [];
  }
  if (r.price != null && (changed.length || c.price == null)) {
    c.price = r.price;
    c.priceNote = 'Web price' + r.source + '.';
  } else if (changed.length) {
    c.price = null;
    c.priceNote = 'No price found for the corrected card. Enter the TCGplayer price.';
  } else if (r.price != null && Math.abs(r.price - c.price) > Math.max(1, c.price * 0.25)) {
    c.checks.push('The web shows $' + r.price.toFixed(2) + r.source + ' instead of $' + c.price.toFixed(2) + '. Check TCGplayer.');
  }
  if (conf === 'high') c.priceNote += ' Card confirmed by a web search.';
  c.confidence = conf;
  if (r.note) c.checks.push(String(r.note));
}

/* ---------- 2. add to the sheet ---------- */
function scanAdd_(cards, batch) {
  if (!Array.isArray(cards) || !cards.length) throw new Error('No cards to add.');
  if (cards.length > 30) throw new Error('Too many cards at once.');
  const cache = CacheService.getScriptCache();
  if (batch) { const done = cache.get('scan-batch-' + batch); if (done) return JSON.parse(done); }

  const clean = cards.map(scanClean_);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.openById(scanSheetId_());
    const col = ss.getSheetByName('Collection');
    if (!col) throw new Error('The sheet has no Collection tab.');
    const next = scanNextSpots_(ss);
    const date = Utilities.formatDate(new Date(), SCAN_TZ, 'yyyy-MM-dd');

    // Work out every row first, so nothing is written if the binder is full.
    const rows = [], grading = [], added = [], bulk = [];
    let slot = next.binder, buffer = next.buffer;
    for (const c of clean) {
      if (c.bulk) { bulk.push({set: c.set, kind: c.bulkKind, qty: c.qty, mode: 'add', fromScan: true}); continue; }
      const base = [c.name, c.set, c.number, c.rarity, c.category, c.condition];
      const push = (qty, loc, prot, action) => {
        rows.push(base.concat([qty, c.price, date, loc, prot]));
        added.push({name: c.name, set: c.set, number: c.number, price: c.price, qty: qty, loc: loc, action: action});
      };
      if (c.category === 'Sealed') { push(c.qty, 'Sealed Shelf', 'Sealed', 'Sealed shelf'); continue; }
      if (c.price >= 20) {
        for (let i = 0; i < c.qty; i++) {
          const loc = 'Buffer #' + buffer++;
          push(1, loc, 'Penny sleeve + top loader', 'Penny sleeve + 35pt top loader → bulk box Row 1 front, ' + loc);
          grading.push([c.name, c.set, c.number, c.price]);
        }
        continue;
      }
      if (c.price >= 2) {
        for (let i = 0; i < c.qty; i++) {
          if (slot > SCAN_BINDER_SLOTS) throw new Error('The binder is full (360 slots). Nothing was added. Decide where overflow cards go, then try again.');
          const loc = 'Binder P' + Math.ceil(slot / 9) + ' S' + (((slot - 1) % 9) + 1);
          slot++;
          push(1, loc, 'Penny sleeve + binder pocket', 'Penny sleeve → ' + loc);
        }
        continue;
      }
      if (c.foil) push(c.qty, 'Bulk Row 1 Back – ' + c.set, 'Penny sleeve', 'Penny sleeve → bulk box Row 1 back, behind the ' + c.set + ' divider');
      else if (c.category === 'Trainer') push(c.qty, 'Bulk Row 3 – Trainers', 'Raw (no sleeve)', 'No sleeve → bulk box Row 3, Trainers');
      else if (c.category === 'Energy' && c.basicEnergy) push(c.qty, 'Bulk Row 3 – Basic Energy', 'Raw (no sleeve)', 'No sleeve → bulk box Row 3, Basic Energy');
      else push(c.qty, 'Bulk Row 2 – ' + c.set, 'Raw (no sleeve)', 'No sleeve → bulk box Row 2, behind the ' + c.set + ' divider');
    }

    const r0 = scanFirstEmptyRow_(col);
    scanWriteRows_(col, r0, rows, {numCol: 3, dateCol: 9});
    for (const b of scanBulk_(col, bulk, date)) added.push(b);
    if (grading.length) {
      const g = ss.getSheetByName('Grading');
      if (g) scanWriteRows_(g, scanFirstEmptyRow_(g), grading, {numCol: 3});
    }
    SpreadsheetApp.flush();
    const after = scanNextSpots_(ss);
    const out = {
      added: added,
      grading: grading.length,
      next: {binder: after.binderText, buffer: after.bufferText}
    };
    if (batch) { try { cache.put('scan-batch-' + batch, JSON.stringify(out), 3600); } catch (e) {} }
    return out;
  } finally {
    lock.releaseLock();
  }
}

// Checks one card from the app before it goes in the sheet.
function scanClean_(c) {
  c = c || {};
  const name = String(c.name || '').trim();
  if (!name) throw new Error('A card is missing its name.');
  const price = Number(String(c.price == null ? '' : c.price).replace(/[^0-9.]/g, ''));
  if (String(c.price == null ? '' : c.price).trim() === '' || !isFinite(price)) throw new Error('Enter a price for ' + name + '.');
  const cat = ['Pokémon', 'Trainer', 'Energy', 'Sealed'].find(x => x.toLowerCase() === String(c.category || '').toLowerCase()) || 'Pokémon';
  const cond = ['NM', 'LP', 'MP', 'HP', 'DMG'].indexOf(c.condition) >= 0 ? c.condition : 'NM';
  const qty = Math.max(1, Math.min(99, Math.round(Number(c.qty) || 1)));
  const set = String(c.set || '').trim();
  if (!set) throw new Error('Enter the set for ' + name + '.');
  const out = {
    name: name, set: set, number: String(c.number || '').trim(), rarity: String(c.rarity || '').trim(),
    category: cat, condition: cond, qty: qty, price: Math.round(price * 100) / 100,
    foil: !!c.foil, basicEnergy: !!c.basicEnergy, bulk: false, bulkKind: ''
  };
  // "Add to bulk count" only makes sense for cheap cards that live in the bulk box.
  if (c.bulk && cat !== 'Sealed' && out.price < 2) {
    out.bulk = true;
    out.bulkKind = cat === 'Trainer' ? 'trainer'
      : cat === 'Energy' && out.basicEnergy ? 'energy'
      : c.finish === 'reverse' || /reverse/i.test(out.rarity) ? 'reverse'
      : out.foil ? 'holo' : 'nonfoil';
  }
  return out;
}

/* ---------- bulk counts ---------- */
// One count row per set and type, written the same way as the rows already in the sheet.
const SCAN_BULK = {
  nonfoil: {label: 'non-foil bulk', rarity: 'Common/Uncommon', cat: 'Mixed', row: 'Bulk Row 2', price: 0.15},
  reverse: {label: 'reverse holo bulk', rarity: 'Common/Uncommon (Reverse Holo)', cat: 'Mixed', row: 'Bulk Row 1 Back', price: 0.25},
  holo: {label: 'holo rare bulk', rarity: 'Rare (Holo)', cat: 'Pokémon', row: 'Bulk Row 1 Back', price: 0.20},
  trainer: {label: 'trainer bulk', rarity: 'Common/Uncommon', cat: 'Trainer', loc: 'Bulk Row 3 – Trainers', price: 0.10},
  energy: {label: 'basic energy', rarity: 'Common', cat: 'Energy', loc: 'Bulk Row 3 – Basic Energy', price: 0.05}
};
function scanBulkRow_(set, kind) {
  const k = SCAN_BULK[kind];
  if (!k) throw new Error('Unknown bulk type.');
  // Trainers and basic Energy share one row each (Bulk Row 3 has no set dividers); the others are per set.
  set = k.loc ? '' : String(set || '').trim();
  const mixed = !set || /^mixed$/i.test(set);
  if (mixed && !k.loc) throw new Error('Pick a set for the ' + k.label + ' count.');
  const name = kind === 'energy' ? 'Basic Energy (count)' : kind === 'trainer' ? 'Trainer bulk (count)' : set + ' ' + k.label + ' (count)';
  return {name: name, set: mixed ? 'Mixed' : set, kind: kind, k: k, loc: k.loc || (k.row + ' – ' + set)};
}

// entries: [{set, kind, qty, mode:"add"|"set", price?}] → adds to (or sets) the matching count row, or starts one.
function scanBulk_(col, entries, date) {
  if (!entries || !entries.length) return [];
  const last = scanFirstEmptyRow_(col) - 1;
  const vals = last >= 2 ? col.getRange(2, 1, last - 1, 8).getDisplayValues() : [];
  const where = {};
  vals.forEach((r, i) => { const k = scanNorm_(r[0]); if (k && /\(count\)/i.test(r[0]) && !(k in where)) where[k] = {row: i + 2, qty: Number(String(r[6]).replace(/[^0-9.-]/g, '')) || 0}; });
  let next = last + 1;
  const out = [];
  for (const e of entries) {
    const b = scanBulkRow_(e.set, e.kind);
    const qty = Math.max(0, Math.min(9999, Math.round(Number(e.qty) || 0)));
    const mode = e.mode === 'set' ? 'set' : 'add';
    if (mode === 'add' && !qty) continue;
    const price = e.price === '' || e.price == null || !isFinite(Number(e.price)) ? null : Math.round(Number(e.price) * 100) / 100;
    const key = scanNorm_(b.name), hit = where[key];
    let now;
    if (hit) {
      now = mode === 'set' ? qty : hit.qty + qty;
      col.getRange(hit.row, 7).setValue(now);
      if (price != null && !e.fromScan) col.getRange(hit.row, 8).setValue(price);
      hit.qty = now;
    } else {
      if (mode === 'set' && !qty) continue;
      now = qty;
      scanWriteRows_(col, next, [[b.name, b.set, 'Mixed', b.k.rarity, b.k.cat, 'NM', now, price != null && !e.fromScan ? price : b.k.price, date, b.loc, 'Raw (no sleeve)']], {numCol: 3, dateCol: 9});
      where[key] = {row: next, qty: now};
      next++;
    }
    out.push({name: b.name, set: b.set, number: 'Mixed', price: price != null && !e.fromScan ? price : b.k.price, qty: qty, loc: b.loc, bulk: true,
      action: (b.k.loc ? 'No sleeve → ' + b.loc : 'Into the ' + b.set + ' ' + b.k.label + ' → ' + b.loc) + ' · count ' + (hit ? 'now ' : 'started at ') + now});
  }
  return out;
}

function scanBulkOnly_(entries, batch) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('Nothing to count.');
  if (entries.length > 40) throw new Error('Too many lines at once.');
  const cache = CacheService.getScriptCache();
  if (batch) { const done = cache.get('scan-batch-' + batch); if (done) return JSON.parse(done); }
  entries.forEach(e => scanBulkRow_(e.set, e.kind)); // check every line before writing anything
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.openById(scanSheetId_());
    const col = ss.getSheetByName('Collection');
    if (!col) throw new Error('The sheet has no Collection tab.');
    const date = Utilities.formatDate(new Date(), SCAN_TZ, 'yyyy-MM-dd');
    const added = scanBulk_(col, entries, date);
    SpreadsheetApp.flush();
    const out = {added: added, grading: 0, bulkOnly: true};
    if (batch) { try { cache.put('scan-batch-' + batch, JSON.stringify(out), 3600); } catch (e) {} }
    return out;
  } finally {
    lock.releaseLock();
  }
}

// The Storage tab's "Next binder slot" and "Next top loader buffer #" cells, found by their labels.
function scanNextSpots_(ss) {
  const st = ss.getSheetByName('Storage');
  if (!st) throw new Error('The sheet has no Storage tab.');
  const v = st.getRange(1, 1, Math.min(st.getLastRow(), 40), 2).getDisplayValues();
  let binderText = '', bufferText = '';
  for (const r of v) {
    if (/next binder/i.test(r[0])) binderText = r[1];
    else if (/next .*buffer/i.test(r[0])) bufferText = r[1];
  }
  const m = String(binderText).match(/P\s*(\d+)\s*S\s*(\d+)/i);
  const b = String(bufferText).match(/(\d+)/);
  if (!m || !b) throw new Error('Couldn\'t read the next open binder slot and buffer number on the Storage tab.');
  return {binder: (+m[1] - 1) * 9 + +m[2], buffer: +b[1], binderText: binderText, bufferText: bufferText};
}

// First row after the last filled cell in column A (the formula columns are pre-filled further down).
function scanFirstEmptyRow_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 2;
  const a = sh.getRange(1, 1, last, 1).getDisplayValues();
  let i = a.length;
  while (i > 1 && !String(a[i - 1][0]).trim()) i--;
  return i + 1;
}

function scanWriteRows_(sh, r0, rows, opts) {
  if (!rows.length) return;
  const need = r0 + rows.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need);
  if (opts.numCol) sh.getRange(r0, opts.numCol, rows.length, 1).setNumberFormat('@'); // keeps "053/159" from turning into a date
  if (opts.dateCol) sh.getRange(r0, opts.dateCol, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(r0, 1, rows.length, rows[0].length).setValues(rows);
}
