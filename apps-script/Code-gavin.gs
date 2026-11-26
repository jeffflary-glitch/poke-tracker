// Gavin's Pokémon Tracker — Google Apps Script web app (Gavin's own project, in Jeff's Google account)
// Serves "Pokemon tracker Gavin" to Gavin's home-screen app on GitHub Pages (/poke-tracker/gavin/):
//   GET  .../exec?data=1  → the sheet as data
//   POST .../exec         → typed cards and bulk counts (Scan.gs); Prices.gs runs the free Sunday price check

const SHEET_ID = '1HpsaCnkQEG8fVA6-6OY5mquzTY_0RFFqA_N-cReuiIc'; // Pokemon tracker Gavin

function doGet(e) {
  if (e && e.parameter && e.parameter.data) {
    return ContentService
      .createTextOutput(JSON.stringify(getData()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutput("<p>Gavin's Pokémon Tracker data link. Open the app at https://jeffflary-glitch.github.io/poke-tracker/gavin/</p>");
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
    history: read('Price History'), // per-card old → new prices from the Sunday price check (Prices.gs)
    at: Date.now()
  };
}

// Which sheet scans and bulk counts write to (used by Scan.gs).
function scanSheetId_() { return SHEET_ID; }
