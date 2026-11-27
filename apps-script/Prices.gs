// Prices.gs — price checks run by Apps Script itself on timers (not Claude scheduled tasks).
// The same file goes in every tracker's Apps Script project, next to Code*.gs and Scan.gs (it uses Scan.gs's
// TCGdex lookups, web search and scanSheetId_, so each project only ever touches its own sheet).
//
// Every morning (dailyPriceCheck, free): each single card on the Collection tab is looked up in TCGdex and gets its
//   TCGplayer market price. Changes go on Price History and the Grading tab's Raw NM.
// Every Sunday (weeklyPriceCheck): sealed product, Poké Ball / Master Ball pattern singles (TCGdex has no prices for
//   either) and the Grading tab's PSA 10/9/8 prices are found by web search
//   (Claude Haiku on Script Property ANTHROPIC_API_KEY, a few cents a week; skipped without a key), a Price & Value
//   Logs row is added, and the week's changes are emailed to Script Property REPORT_EMAIL (separate several with commas).
// "(count)" bulk rows keep their set price.
//
// One-time setup: run setupPriceChecks once from the Apps Script editor (it asks for permission to send email and
// run on a timer). Running dailyPriceCheck or weeklyPriceCheck by hand does a check right away.

const PRICE_RUN_MINUTES = 5;   // Apps Script stops a run at 6 minutes; cards not reached are named in the email
const PRICE_PATTERN = /pok[eé] ?ball|master ?ball/i;   // Rarity of a Poké Ball / Master Ball pattern single
const PRICE_PATTERN_SYSTEM = [
  'You find the current US market price of one Poké Ball pattern or Master Ball pattern Pokémon TCG card for a collection tracker.',
  'Search the web for the exact card (same name, set and number) in the stated pattern. TCGplayer lists each pattern as its own product, such as "Leafeon (Master Ball Pattern)". Use its Near Mint TCGplayer market price (what it has recently sold for) from tcgplayer.com or a site that shows it, such as pricecharting.com or scrydex.com. If none is listed, use recent eBay sold prices.',
  'Never use the price of the regular card or of the other pattern.'
].concat(SCAN_WEB_RULES, [
  '{"price": 12.34, "source": "e.g. TCGplayer market price via PriceCharting", "note": ""}',
  'Use "price": null if you can\'t find a trustworthy current price for this pattern.'
]).join('\n');
const PRICE_PSA_SYSTEM = [
  'You find recent sold prices of one PSA-graded Pokémon TCG card for a collection tracker.',
  'Search the web for the exact card (same name, set and number). Use recent sold prices for PSA 10, PSA 9 and PSA 8 copies from pricecharting.com, PSA\'s auction prices, or eBay sold listings.',
  'Never use asking prices or a single outlier sale.'
].concat(SCAN_WEB_RULES, [
  '{"psa10": 123.45, "psa9": 50.00, "psa8": 30.00, "source": "e.g. PriceCharting", "note": ""}',
  'Use null for any grade without a trustworthy recent price.'
]).join('\n');

function setupPriceChecks() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['dailyPriceCheck', 'weeklyPriceCheck'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyPriceCheck').timeBased().everyDays(1).atHour(6).inTimezone(SCAN_TZ).create();
  ScriptApp.newTrigger('weeklyPriceCheck').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(8).inTimezone(SCAN_TZ).create();
}

/* ---------- every day: singles from TCGdex ---------- */
function dailyPriceCheck() {
  const started = Date.now();
  const ss = SpreadsheetApp.openById(scanSheetId_());
  const col = ss.getSheetByName('Collection');
  const last = scanFirstEmptyRow_(col) - 1;
  const date = priceToday_();
  const rows = last >= 2 ? col.getRange(2, 1, last - 1, 10).getValues() : [];
  const changes = [], missed = [], skipped = [];
  let checked = 0;
  rows.forEach((r, i) => {
    const [name, set, number, rarity, category, , qty, price] = r;
    if (!name || category === 'Sealed' || /\(count\)\s*$/i.test(name) || !number) return;
    if (Date.now() - started > PRICE_RUN_MINUTES * 60000) { skipped.push(name); return; }
    if (PRICE_PATTERN.test(rarity)) return;   // priced by web search on Sundays
    let card = null;
    try { card = scanFindCard_({name: name, set: set, number: String(number)}); } catch (e) {}
    const now = card ? pricePick_(scanPrices_(card), rarity, Number(price)) : null;
    if (now == null) { missed.push(name + ' · ' + set + ' ' + number); return; }
    checked++;
    const old = Number(price) || 0;
    if (Math.abs(now - old) < 0.005) return;
    col.getRange(i + 2, 8).setValue(now);
    changes.push({name: name, set: set, number: String(number), old: old, now: now, qty: Number(qty) || 1});
  });
  priceLog_(ss, date, changes);
  priceGradingRaw_(ss, changes);
  SpreadsheetApp.flush();
  PropertiesService.getScriptProperties().setProperty('PRICE_LAST_DAILY',
    JSON.stringify({date: date, checked: checked, missed: missed.slice(0, 40), skipped: skipped.slice(0, 40)}));
}

// Which TCGplayer price fits the card: reverse holo rows use the reverse price; otherwise the
// holo or normal price, whichever is closer to the last one (so a holo isn't swapped for its normal print).
function pricePick_(prices, rarity, old) {
  const reverse = /reverse/i.test(rarity || '');
  const keys = (reverse ? SCAN_VARIANTS.reverse : SCAN_VARIANTS.holo.concat(SCAN_VARIANTS.normal)).filter(k => prices[k] != null);
  if (!keys.length) {
    const all = Object.keys(prices);
    return all.length === 1 ? prices[all[0]] : null;
  }
  if (!(old > 0)) return prices[keys[0]];
  return keys.map(k => prices[k]).sort((a, b) => Math.abs(a - old) - Math.abs(b - old))[0];
}

/* ---------- every Sunday: sealed, pattern singles, PSA prices, log row and email ---------- */
function weeklyPriceCheck() {
  const started = Date.now();
  const ss = SpreadsheetApp.openById(scanSheetId_());
  const col = ss.getSheetByName('Collection');
  const date = priceToday_();
  const web = !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  const missed = [];
  let cost = 0;
  if (web) {
    cost += priceWeb_(ss, col, date, missed, started);
    cost += pricePsa_(ss, missed, started);
  }
  SpreadsheetApp.flush();

  const last = scanFirstEmptyRow_(col) - 1;
  const rows = last >= 2 ? col.getRange(2, 1, last - 1, 15).getDisplayValues() : [];
  const vals = last >= 2 ? col.getRange(2, 7, last - 1, 6).getValues() : [];
  let items = 0, value = 0;
  vals.forEach((r, i) => { if (rows[i][0]) { items += Number(r[0]) || 0; value += Number(r[5]) || 0; } });
  value = Math.round(value * 100) / 100;
  const log = ss.getSheetByName('Price & Value Logs');
  let before = null;
  if (log) {
    const lr = scanFirstEmptyRow_(log);
    if (lr > 2) before = Number(log.getRange(lr - 1, 3).getValue());
    const daily = priceLastDaily_();
    const note = 'Weekly check: ' + (daily ? daily.checked + ' singles priced daily' : 'no daily check yet') + (web ? ', sealed, pattern and PSA prices by web search (about '
      + Math.max(1, Math.round(cost * 100)) + '¢)' : '') + '.';
    scanWriteRows_(log, lr, [[date, items, value, note]], {dateCol: 1});
  }
  const toMove = rows.filter(r => r[0] && /^⚠ (Move|No storage|Unknown)/.test(r[14])).map(r => r[0] + ' (' + (r[9] || 'no spot') + '): ' + r[14].replace(/^⚠ /, ''));
  priceEmail_(ss, date, items, value, before, priceWeekChanges_(ss, date), toMove, missed, web);
}

// Sealed product and Poké Ball / Master Ball pattern singles: web prices, 10 at a time. Returns the cost in dollars.
function priceWeb_(ss, col, date, missed, started) {
  const last = scanFirstEmptyRow_(col) - 1;
  const rows = last >= 2 ? col.getRange(2, 1, last - 1, 8).getValues() : [];
  const changes = [], jobs = [];
  rows.forEach((r, i) => {
    const [name, set, number, rarity, category, , , price] = r;
    const sealed = category === 'Sealed';
    if (!name || !(sealed || (number && PRICE_PATTERN.test(rarity) && !/\(count\)\s*$/i.test(name)))) return;
    const old = Number(price) || 0;
    const job = {
      label: name + (sealed ? ' (sealed)' : ' · ' + set + ' ' + number + ' (pattern)'),
      system: sealed ? SCAN_SEALED_SYSTEM : PRICE_PATTERN_SYSTEM,
      question: sealed ? scanWebQuestion_({kind: 'sealed', name: name, set: set})
        : 'Card: ' + name + '\nSet: ' + set + '\nNumber: ' + number + '\nPattern: ' + (/master/i.test(rarity) ? 'Master Ball pattern' : 'Poké Ball pattern'),
      done: content => {
        const a = scanWebAnswer_(content);
        if (!a || a.price == null) return;
        job.priced = true;
        if (Math.abs(a.price - old) < 0.005) return;
        col.getRange(i + 2, 8).setValue(a.price);
        changes.push({name: name, set: set, number: sealed ? '' : String(number), old: old, now: a.price});
      }
    };
    jobs.push(job);
  });
  let cost = 0;
  for (let i = 0; i < jobs.length; i += 10) {
    const group = jobs.slice(i, i + 10);
    if (Date.now() - started > PRICE_RUN_MINUTES * 60000) { group.forEach(j => missed.push(j.label + ' (not reached)')); continue; }
    cost += scanWebAsk_(group);
    group.filter(j => !j.priced).forEach(j => missed.push(j.label));
  }
  priceLog_(ss, date, changes);
  priceGradingRaw_(ss, changes);
  return cost;
}

// Grading tab: PSA 10 / 9 / 8 sold prices (E–G) for every card on it. Returns the cost in dollars.
function pricePsa_(ss, missed, started) {
  const g = ss.getSheetByName('Grading');
  const gLast = g ? scanFirstEmptyRow_(g) - 1 : 1;
  if (gLast < 2 || Date.now() - started > PRICE_RUN_MINUTES * 60000) return 0;
  const rows = g.getRange(2, 1, gLast - 1, 7).getValues();
  const jobs = [];
  rows.forEach((r, i) => {
    if (!r[0]) return;
    jobs.push({
      system: PRICE_PSA_SYSTEM,
      question: 'Card: ' + r[0] + '\nSet: ' + r[1] + '\nNumber: ' + r[2],
      done: content => {
        const a = pricePsaAnswer_(content);
        if (!a) { missed.push(r[0] + ' (PSA prices)'); return; }
        const cur = rows[i].slice(4, 7);
        g.getRange(i + 2, 5, 1, 3).setValues([[a.psa10 != null ? a.psa10 : cur[0], a.psa9 != null ? a.psa9 : cur[1], a.psa8 != null ? a.psa8 : cur[2]]]);
      }
    });
  });
  let cost = 0;
  for (let i = 0; i < jobs.length; i += 10) {
    if (Date.now() - started > PRICE_RUN_MINUTES * 60000) break;
    cost += scanWebAsk_(jobs.slice(i, i + 10));
  }
  return cost;
}
function pricePsaAnswer_(content) {
  const text = (content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const found = text.match(/\{[^{}]*"psa10"[^{}]*\}/g);
  if (!found) return null;
  let r;
  try { r = JSON.parse(found[found.length - 1]); } catch (e) { return null; }
  const p = v => (v != null && v !== '' && isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v) * 100) / 100 : null);
  const out = {psa10: p(r.psa10), psa9: p(r.psa9), psa8: p(r.psa8)};
  return out.psa10 == null && out.psa9 == null && out.psa8 == null ? null : out;
}

/* ---------- shared ---------- */
const priceToday_ = () => Utilities.formatDate(new Date(), SCAN_TZ, 'yyyy-MM-dd');
const priceDate_ = v => (v instanceof Date ? Utilities.formatDate(v, SCAN_TZ, 'yyyy-MM-dd') : String(v || '').trim());
function priceLastDaily_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('PRICE_LAST_DAILY') || 'null'); } catch (e) { return null; }
}
// Price History: one row per changed card or item.
function priceLog_(ss, date, changes) {
  const hist = ss.getSheetByName('Price History');
  if (hist && changes.length) scanWriteRows_(hist, scanFirstEmptyRow_(hist), changes.map(c => [date, c.name, c.set, c.number, c.old, c.now]), {numCol: 4, dateCol: 1});
}
// Grading: keep Raw NM in step with the Collection price.
function priceGradingRaw_(ss, changes) {
  const g = ss.getSheetByName('Grading');
  const gLast = g ? scanFirstEmptyRow_(g) - 1 : 1;
  if (gLast < 2 || !changes.length) return;
  const key = (n, s, x) => [n, s, x].map(scanNorm_).join('|');
  const byKey = {};
  changes.forEach(c => { byKey[key(c.name, c.set, c.number)] = c.now; });
  g.getRange(2, 1, gLast - 1, 3).getDisplayValues().forEach((r, i) => {
    const p = byKey[key(r[0], r[1], r[2])];
    if (p != null) g.getRange(i + 2, 4).setValue(p);
  });
}
// The last 7 days of Price History, one line per card: its first old price and its latest new price.
function priceWeekChanges_(ss, date) {
  const hist = ss.getSheetByName('Price History');
  const hLast = hist ? scanFirstEmptyRow_(hist) - 1 : 1;
  if (hLast < 2) return [];
  const since = Utilities.formatDate(new Date(new Date(date + 'T12:00:00').getTime() - 7 * 86400000), SCAN_TZ, 'yyyy-MM-dd');
  const by = {};
  hist.getRange(2, 1, hLast - 1, 6).getValues().forEach(r => {
    const d = priceDate_(r[0]);
    if (!r[1] || d <= since) return;
    const k = [r[1], r[2], r[3]].join('|');
    if (!by[k]) by[k] = {name: r[1], set: r[2], number: String(r[3]), old: Number(r[4]) || 0, now: Number(r[5]) || 0};
    else by[k].now = Number(r[5]) || 0;
  });
  return Object.keys(by).map(k => by[k]).filter(c => Math.abs(c.now - c.old) >= 0.005);
}

function priceEmail_(ss, date, items, value, before, changes, toMove, missed, web) {
  const to = PropertiesService.getScriptProperties().getProperty('REPORT_EMAIL');
  if (!to) return;
  const usd = n => '$' + n.toFixed(2);
  const diff = before != null && isFinite(before) ? value - before : null;
  const daily = priceLastDaily_();
  const lines = [
    'Your Pokémon cards, week of ' + date,
    '',
    'Collection value: ' + usd(value) + (diff != null ? ' (' + (diff >= 0 ? 'up ' : 'down ') + usd(Math.abs(diff)) + ' from last week)' : '') + ', ' + items + ' cards and items.',
    ''
  ];
  const movers = changes.slice().sort((a, b) => Math.abs(b.now - b.old) - Math.abs(a.now - a.old)).slice(0, 10);
  if (movers.length) {
    lines.push('Biggest price changes this week:');
    movers.forEach(c => lines.push('  ' + c.name + ' (' + (c.number ? c.set + ' ' + c.number : 'sealed') + '): ' + usd(c.old) + ' → ' + usd(c.now)));
    lines.push('');
  } else lines.push('No price changes this week.', '');
  if (toMove.length) {
    lines.push('Cards to move (or keep where they are in the app):');
    toMove.slice(0, 20).forEach(t => lines.push('  ' + t));
    lines.push('');
  }
  const notFound = [...new Set((daily ? daily.missed : []).concat(missed))];
  if (notFound.length) lines.push('No price found (check these on TCGplayer): ' + notFound.join('; ') + '.', '');
  if (daily && daily.skipped && daily.skipped.length) lines.push('The daily check ran out of time before: ' + daily.skipped.join(', ') + '.', '');
  if (!web) lines.push('Sealed, Poké Ball / Master Ball pattern and PSA prices aren\'t updated automatically without an API key; change them in the sheet.', '');
  lines.push(ss.getUrl());
  MailApp.sendEmail(to, 'Pokémon cards: ' + usd(value) + (diff != null ? (diff >= 0 ? ' ▲ ' : ' ▼ ') + usd(Math.abs(diff)) : ''), lines.join('\n'));
}
