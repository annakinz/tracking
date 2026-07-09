/**
 * Stratos household sync — Google Apps Script backend.
 *
 * Setup (once, ~5 min):
 *   1. Go to https://script.google.com  →  New project.
 *   2. Delete the sample code, paste ALL of this file, and Save.
 *   3. Deploy → New deployment → type "Web app".
 *        - Execute as: Me (your own account)
 *        - Who has access: Anyone
 *      Deploy, authorize when asked, and COPY the Web app URL
 *      (it ends in /exec).
 *   4. In Stratos → Settings → sync, paste that URL, pick a household code,
 *      and share the same code with the other person.
 *
 * It stores one small encrypted file per household in a "Stratos Sync" folder
 * in YOUR Google Drive. The app encrypts everything before sending, so this
 * script only ever sees ciphertext.
 */

function doPost(e) {
  var out;
  try {
    var body = JSON.parse(e.postData.contents);
    var household = String(body.household || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
    if (!household) throw new Error('missing household');
    var file = getFile_(household);
    var store = {};
    if (file) { try { store = JSON.parse(file.getBlob().getDataAsString()) || {}; } catch (e2) { store = {}; } }

    if (body.action === 'get') {
      out = { ok: true, store: store };
    } else if (body.action === 'put') {
      var device = String(body.device || 'd').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
      store[device] = String(body.data || '');
      writeFile_(household, JSON.stringify(store));
      out = { ok: true };
    } else {
      throw new Error('bad action');
    }
  } catch (err) {
    out = { error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, ping: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function folder_() {
  var it = DriveApp.getFoldersByName('Stratos Sync');
  return it.hasNext() ? it.next() : DriveApp.createFolder('Stratos Sync');
}
function getFile_(household) {
  var f = folder_().getFilesByName(household + '.json');
  return f.hasNext() ? f.next() : null;
}
function writeFile_(household, content) {
  var existing = getFile_(household);
  if (existing) existing.setContent(content);
  else folder_().createFile(household + '.json', content, 'text/plain');
}
