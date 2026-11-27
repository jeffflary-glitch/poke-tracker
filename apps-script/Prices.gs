// Prices.gs — weekly price check run by Apps Script itself on a timer (not a Claude scheduled task).
// Used by Gavin's tracker in place of the Claude scheduled task. It sits in the same Apps Script
// project as Code-gavin.gs and Scan.gs (it uses Scan.gs's TCGdex lookups and scanSheetId_).
//
// Every Sunday morning it:
//   1. Looks up each single card on the Collection tab in TCGdex (free) and writes its new TCGplayer market price.
//      Sealed product isn't in TCGdex, so Claude Haiku searches the web for it (Scan.gs's web check,
//      about 1–3¢ per item on the API key in Script Property ANTHROPIC_API_KEY; skipped without a key).
//      "(count)" bulk rows are left alone.
//   2. Logs every change on Price History, adds a weekly row to Price & Value Logs, updates Raw NM on Grading.
//   3. Emails a short report to the address in Script Property REPORT_EMAIL.
//
// One-time setup: run setupWeeklyPrices once from the Apps Script editor (it asks for permission to
// send email and run on a timer). Running weeklyPriceCheck by hand does a check right away.

const PRICE_RUN_MINUTES = 5;   // Apps Script stops a run at 6 minutes; cards not reached are named in the email

function setupWeeklyPrices() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'weeklyPriceCheck')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('weeklyPriceCheck').timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(8).inTimezone(SCAN_TZ).create();
}

function weeklyPriceCheck() {
  const started = Date.now();
  const ss = SpreadsheetApp.openById(scanSheetId_());
  const col = ss.getSheetByName('Collection');
  const last = scanFirstEmptyRow_(col) - 1;
  const date = Utilities.formatDate(new Date(), SCAN_TZ, 'yyyy-MM-dd');
  const rows = last >= 2 ? col.getRange(2, 1, last - 1, 10).getValues() : [];

  const changes = [], missed = [], skipped = [], sealed = [];
  let checked = 0, cost = 0;
  rows.forEach((r, i) => {
    const [name, set, number, rarity, category, , qty, price, , loc] = r;
    if (!name || /\(count\)\s*$/i.test(name)) return;
    if (Date.now() - started > PRICE_RUN_MINUTES * 60000) { skipped.push(name); return; }
    if (category === 'Sealed') { sealed.push({row: i + 2, name: name, set: set, price: Number(price) || 0, qty: Number(qty) || 1, loc: String(loc || '')}); return; }
    if (!number) return;
    if (/pok[eé] ?ball|master ?ball/i.test(rarity)) { missed.push(name + ' (Poké Ball / Master Ball pattern)'); return; }
    let card = null;
    try { card = scanFindCard_({name: name, set: set, number: String(number)}); } catch (e) {}
    const now = card ? pricePick_(scanPrices_(card), rarity, Number(price)) : null;
    if (now == null) { missed.push(name + ' · ' + set + ' ' + number); return; }
    checked++;
    const old = Number(price) || 0;
    if (Math.abs(now - old) < 0.005) return;
    col.getRange(i + 2, 8).setValue(now);
    changes.push({name: name, set: set, number: String(number), old: old, now: now, qty: Number(qty) || 1, loc: String(loc || '')});
  });
  const webKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (webKey) cost = priceSealed_(col, sealed, changes, missed, skipped, started);

  // Price History: one row per changed card
  const hist = ss.getSheetByName('Price History');
  if (hist && changes.length) {
    scanWriteRows_(hist, scanFirstEmptyRow_(hist), changes.map(c => [date, c.name, c.set, c.number, c.old, c.now]), {numCol: 4, dateCol: 1});
  }
  // Grading: keep Raw NM in step with the Collection price
  const g = ss.getSheetByName('Grading');
  const gLast = g ? scanFirstEmptyRow_(g) - 1 : 1;
  if (gLast >= 2 && changes.length) {
    const gRows = g.getRange(2, 1, gLast - 1, 3).getDisplayValues();
    const key = (n, s, x) => [n, s, x].map(scanNorm_).join('|');
    const byKey = {};
    changes.forEach(c => { byKey[key(c.name, c.set, c.number)] = c.now; });
    gRows.forEach((r, i) => { const p = byKey[key(r[0], r[1], r[2])]; if (p != null) g.getRange(i + 2, 4).setValue(p); });
  }
  SpreadsheetApp.flush();

  // Weekly totals, from the sheet after the new prices are in
  const after = last >= 2 ? col.getRange(2, 1, last - 1, 12).getValues() : [];
  let items = 0, value = 0;
  after.forEach(r => { if (r[0]) { items += Number(r[6]) || 0; value += Number(r[11]) || 0; } });
  value = Math.round(value * 100) / 100;
  const log = ss.getSheetByName('Price & Value Logs');
  let before = null;
  if (log) {
    const lr = scanFirstEmptyRow_(log);
    if (lr > 2) before = Number(log.getRange(lr - 1, 3).getValue());
    const note = 'Weekly re-price: ' + checked + ' cards checked, ' + changes.length + ' changed, ' + missed.length + ' not found'
      + (skipped.length ? ', ' + skipped.length + ' not reached' : '') + (cost ? ', web search about ' + Math.max(1, Math.round(cost * 100)) + '¢' : '') + '.';
    scanWriteRows_(log, lr, [[date, items, value, note]], {dateCol: 1});
  }
  priceEmail_(ss, date, items, value, before, changes, missed, skipped, !!webKey);
}

// Sealed product: web prices from Scan.gs's web check, 10 at a time. Returns the cost in dollars.
function priceSealed_(col, sealed, changes, missed, skipped, started) {
  let cost = 0;
  for (let i = 0; i < sealed.length; i += 10) {
    const group = sealed.slice(i, i + 10);
    if (Date.now() - started > PRICE_RUN_MINUTES * 60000) { group.forEach(x => skipped.push(x.name)); continue; }
    const items = group.map(x => ({kind: 'sealed', name: x.name, set: x.set, price: null, priceNote: '', checks: []}));
    cost += scanWebCheck_(items);
    items.forEach((it, k) => {
      const x = group[k];
      if (it.price == null) { missed.push(x.name + ' (sealed)'); return; }
      if (Math.abs(it.price - x.price) < 0.005) return;
      col.getRange(x.row, 8).setValue(it.price);
      changes.push({name: x.name, set: x.set, number: '', old: x.price, now: it.price, qty: x.qty, loc: x.loc, sealed: true});
    });
  }
  return cost;
}

// Which TCGplayer price fits the card: reverse holo rows use the reverse price; otherwise the
// holo or normal price, whichever is closer to last week's (so a holo isn't swapped for its normal print).
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

// Where a card should live at its new price, when it's crossed a $2 or $20 line.
function priceMove_(c) {
  if (c.sealed) return '';
  const tier = p => (p >= 20 ? 'top loader' : p >= 2 ? 'binder' : 'bulk box');
  return tier(c.old) === tier(c.now) ? '' : 'move from the ' + tier(c.old) + ' to the ' + tier(c.now);
}

function priceEmail_(ss, date, items, value, before, changes, missed, skipped, sealedPriced) {
  const to = PropertiesService.getScriptProperties().getProperty('REPORT_EMAIL');
  if (!to) return;
  const usd = n => '$' + n.toFixed(2);
  const diff = before != null && isFinite(before) ? value - before : null;
  const lines = [
    'Your Pokémon cards, week of ' + date,
    '',
    'Collection value: ' + usd(value) + (diff != null ? ' (' + (diff >= 0 ? 'up ' : 'down ') + usd(Math.abs(diff)) + ' from last week)' : '') + ', ' + items + ' cards and items.',
    ''
  ];
  const movers = changes.slice().sort((a, b) => Math.abs(b.now - b.old) * b.qty - Math.abs(a.now - a.old) * a.qty).slice(0, 10);
  if (movers.length) {
    lines.push('Biggest price changes:');
    movers.forEach(c => lines.push('  ' + c.name + ' (' + (c.sealed ? 'sealed' : c.set + ' ' + c.number) + '): ' + usd(c.old) + ' → ' + usd(c.now)));
    lines.push('');
  } else lines.push('No price changes this week.', '');
  const moves = changes.filter(priceMove_);
  if (moves.length) {
    lines.push('Cards to re-sort:');
    moves.forEach(c => lines.push('  ' + c.name + ' (' + c.loc + '): ' + priceMove_(c)));
    lines.push('');
  }
  if (missed.length) lines.push('Not found in the price database (check these on TCGplayer): ' + missed.join('; ') + '.', '');
  if (skipped.length) lines.push('Ran out of time before: ' + skipped.join(', ') + '. They\'ll be checked next week.', '');
  if (!sealedPriced) lines.push('Sealed product prices aren\'t updated automatically; change them in the sheet when you check TCGplayer.', '');
  lines.push(ss.getUrl());
  MailApp.sendEmail(to, 'Pokémon cards: ' + usd(value) + (diff != null ? (diff >= 0 ? ' ▲ ' : ' ▼ ') + usd(Math.abs(diff)) : ''), lines.join('\n'));
}
