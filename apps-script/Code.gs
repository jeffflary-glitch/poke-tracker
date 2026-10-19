// Jeff's Pokémon Tracker — Google Apps Script web app
// Reads the tracker sheets for the dashboards on GitHub Pages.
//   .../exec?data=1          → "Pokemon tracker Jeff" as data (Jeff's app)
//   .../exec?data=1&who=max  → "Pokemon tracker Max" as data (Max's app, /poke-tracker/max/)
//   .../exec                 → the old all-in-one page (Index.html), kept as a backup
// Only the sheets listed below can be read.
// Scanning cards (POST from the app) is in Scan.gs, which must sit in this same Apps Script project.
// Scans from Jeff's app always go to "Pokemon tracker Jeff" (see scanSheetId_ below).

const SHEETS = {
  jeff: '143nfwKic9pxbT8e3BtbWnm3pWjFA7IvGOD8aVY8ILy0', // Pokemon tracker Jeff
  max:  '1iVcqwyHTghB8xhSzd1u59n703hd90oqGQTrHxeiBMnM'  // Pokemon tracker Max
};

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.data) {
    const id = SHEETS[String(p.who || 'jeff').toLowerCase()];
    const out = id ? getData(id) : {error: 'Unknown tracker.'};
    return ContentService
      .createTextOutput(JSON.stringify(out))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var output = HtmlService.createHtmlOutputFromFile('Index');
  output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  output.setTitle("Jeff's Pokémon Tracker");
  output.addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  output.addMetaTag('apple-mobile-web-app-capable', 'yes');
  output.addMetaTag('mobile-web-app-capable', 'yes');
  return output;
}

// Returns each tab as a grid of the values you see in the sheet.
function getData(id) {
  const ss = SpreadsheetApp.openById(id);
  const read = (name) => {
    const sh = ss.getSheetByName(name);
    return sh ? sh.getDataRange().getDisplayValues() : null;
  };
  return {
    sheetId: id, // lets each app check it got its own sheet
    collection: read('Collection'),
    storage: read('Storage'),
    grading: read('Grading'),
    log: read('Price & Value Logs'),
    history: read('Price History'), // per-card old → new prices from the Sunday price check (optional)
    at: Date.now()
  };
}

// Which sheet "Scan cards" writes to in this project (used by Scan.gs).
function scanSheetId_() { return SHEETS.jeff; }
