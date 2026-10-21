// Jeff's Pokémon Tracker — Google Apps Script web app (Jeff's own project)
// Serves "Pokemon tracker Jeff" to Jeff's home-screen app on GitHub Pages (/poke-tracker/):
//   GET  .../exec?data=1  → the sheet as data
//   POST .../exec         → scanning cards and bulk counts (Scan.gs, which sits in this same project)

const SHEET_ID = '143nfwKic9pxbT8e3BtbWnm3pWjFA7IvGOD8aVY8ILy0'; // Pokemon tracker Jeff

function doGet(e) {
  if (e && e.parameter && e.parameter.data) {
    return ContentService
      .createTextOutput(JSON.stringify(getData()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutput("<p>Jeff's Pokémon Tracker data link. Open the app at https://jeffflary-glitch.github.io/poke-tracker/</p>");
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
