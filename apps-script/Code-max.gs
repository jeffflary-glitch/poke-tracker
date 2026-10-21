// Max's Pokémon Tracker — Google Apps Script web app (Max's own project)
// Serves "Pokemon tracker Max" to Max's home-screen app on GitHub Pages (/poke-tracker/max/):
//   GET  .../exec?data=1  → the sheet as data
//   POST .../exec         → scanning cards and bulk counts (Scan.gs, which sits in this same project)

const SHEET_ID = '1iVcqwyHTghB8xhSzd1u59n703hd90oqGQTrHxeiBMnM'; // Pokemon tracker Max

function doGet(e) {
  if (e && e.parameter && e.parameter.data) {
    return ContentService
      .createTextOutput(JSON.stringify(getData()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutput("<p>Max's Pokémon Tracker data link. Open the app at https://jeffflary-glitch.github.io/poke-tracker/max/</p>");
}

// Returns each tab as a grid of the values you see in the sheet.
function getData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const read = (name) => {
    const sh = ss.getSheetByName(name);
    return sh ? sh.getDataRange().getDisplayValues() : null;
  };
  return {
    sheetId: SHEET_ID, // lets the app check it got its own sheet
    collection: read('Collection'),
    storage: read('Storage'),
    grading: read('Grading'),
    log: read('Price & Value Logs'),
    history: read('Price History'), // per-card old → new prices from the Sunday price check
    at: Date.now()
  };
}

// Which sheet scans and bulk counts write to (used by Scan.gs).
function scanSheetId_() { return SHEET_ID; }
