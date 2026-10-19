// Max's Pokémon Tracker — Google Apps Script web app (Max's own project)
// Reads the "Pokemon tracker Max" sheet for Max's dashboard on GitHub Pages (/poke-tracker/max/).
//   .../exec?data=1  → the sheet as data
//   .../exec         → a short note, or the old page if this project has an Index.html file
// Scanning cards (POST from the app) is in Scan.gs, which must sit in this same Apps Script project.

const SHEET_ID = '1iVcqwyHTghB8xhSzd1u59n703hd90oqGQTrHxeiBMnM'; // Pokemon tracker Max

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.data) {
    return ContentService
      .createTextOutput(JSON.stringify(getData()))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var output = HtmlService.createHtmlOutputFromFile('Index');
    output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    output.setTitle("Max's Pokémon Tracker");
    output.addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
    return output;
  } catch (err) {
    return HtmlService.createHtmlOutput("<p>Max's Pokémon Tracker data link. Open the app at https://jeffflary-glitch.github.io/poke-tracker/max/</p>");
  }
}

// Returns each tab as a grid of the values you see in the sheet.
function getData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const read = (name) => {
    const sh = ss.getSheetByName(name);
    return sh ? sh.getDataRange().getDisplayValues() : null;
  };
  return {
    sheetId: SHEET_ID, // lets Max's app check it got his sheet
    collection: read('Collection'),
    storage: read('Storage'),
    grading: read('Grading'),
    log: read('Price & Value Logs'),
    history: read('Price History'), // per-card old → new prices from the Sunday price check
    at: Date.now()
  };
}

// Which sheet "Scan cards" writes to in this project (used by Scan.gs): always Max's.
function scanSheetId_() { return SHEET_ID; }
