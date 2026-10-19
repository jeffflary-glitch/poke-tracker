// Jeff's Pokémon Tracker — Google Apps Script web app
// Reads the "Pokemon tracker Jeff" sheet.
//   .../exec?data=1  → the sheet as data, used by the dashboard on GitHub Pages
//   .../exec         → the old all-in-one page (Index.html), kept as a backup

const SHEET_ID = '143nfwKic9pxbT8e3BtbWnm3pWjFA7IvGOD8aVY8ILy0';

function doGet(e) {
  if (e && e.parameter && e.parameter.data) {
    return ContentService
      .createTextOutput(JSON.stringify(getData()))
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
function getData() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const read = (name) => {
    const sh = ss.getSheetByName(name);
    return sh ? sh.getDataRange().getDisplayValues() : null;
  };
  return {
    collection: read('Collection'),
    storage: read('Storage'),
    grading: read('Grading'),
    log: read('Price & Value Logs'),
    at: Date.now()
  };
}
