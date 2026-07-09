// Google Drive sync — no backend. Signs in with Google (client-side OAuth,
// narrow drive.file scope), keeps a shared "household" JSON file both people
// can read/write, plus a private file in each person's own Drive as backup.
// Merge is per-item newest-wins (see store.js applySync/syncSnapshot).

import {
  state, save, syncConfig, syncSnapshot, applySync,
} from './store.js';

const SHARED_NAME = 'stratos-household.json';
const PRIVATE_NAME = 'stratos-private.json';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
let libsReady = null;
let syncing = false;
let onStatus = () => {};

export function onSyncStatus(fn) { onStatus = fn; }
export function isSignedIn() { return !!accessToken && Date.now() < tokenExpiry; }
export function syncConfigured() {
  const c = syncConfig();
  return !!(c.clientId && (c.householdFileId || c.privateFileId || c.everConnected));
}

// ---- load Google's scripts on demand (only when the user turns sync on) ----
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
    document.head.appendChild(s);
  });
}
function ensureLibs() {
  if (!libsReady) {
    libsReady = Promise.all([
      loadScript('https://accounts.google.com/gsi/client'),
      loadScript('https://apis.google.com/js/api.js'),
    ]).then(() => new Promise((res) => window.gapi.load('picker', res)));
  }
  return libsReady;
}

// ---- OAuth ----
// One token request. `prompt:''` tries silently (reuses an existing Google
// session); error_callback is essential — without it a closed/blocked popup
// or a failed silent request just hangs, which looks like a dead button.
function requestToken(cfg, prompt) {
  return new Promise((res, rej) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPES,
      prompt,
      callback: (resp) => {
        if (resp && resp.access_token) {
          accessToken = resp.access_token;
          tokenExpiry = Date.now() + (resp.expires_in - 60) * 1000;
          res();
        } else {
          rej(new Error(resp && resp.error ? resp.error : 'no access token'));
        }
      },
      error_callback: (err) => rej(new Error((err && (err.message || err.type)) || 'sign-in was cancelled')),
    });
    try { tokenClient.requestAccessToken(); } catch (e) { rej(e); }
  });
}

export async function connect() {
  const cfg = syncConfig();
  if (!cfg.clientId) throw new Error('Add your Google client ID in Settings first.');
  await ensureLibs();
  // Try silent first if we've connected before; if that fails (expired
  // session, mobile Safari blocking third-party cookies, …), fall back to the
  // interactive consent popup so the button always does *something*.
  try {
    await requestToken(cfg, cfg.everConnected ? '' : 'consent');
  } catch (e) {
    await requestToken(cfg, 'consent');
  }
  cfg.everConnected = true;
  save();
}
async function ensureToken() {
  if (isSignedIn()) return;
  await connect();
}

// ---- Drive REST ----
async function drive(path, opts = {}) {
  await ensureToken();
  const res = await fetch('https://www.googleapis.com/drive/v3/' + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + accessToken, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error('Drive ' + res.status + ' ' + (await res.text()).slice(0, 120));
  return res;
}
async function readFile(id) {
  const res = await drive('files/' + id + '?alt=media');
  return res.json();
}
async function writeFile(id, obj) {
  await fetch('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
}
async function createFile(name, obj) {
  await ensureToken();
  const boundary = 'stratos' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify(obj) +
    `\r\n--${boundary}--`;
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error('create ' + res.status);
  return (await res.json()).id;
}

// find a drive.file-owned file by exact name (files this app created)
async function findOwnFile(name) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const res = await drive('files?q=' + q + '&spaces=drive&fields=files(id,name)');
  const files = (await res.json()).files || [];
  return files[0]?.id || null;
}

// ---- household file: create + invite, or join via the Picker ----
export async function createHousehold() {
  const cfg = syncConfig();
  const id = await createFile(SHARED_NAME, syncSnapshot('shared', state.profile));
  cfg.householdFileId = id;
  save();
  return id;
}
export async function invite(email) {
  const cfg = syncConfig();
  if (!cfg.householdFileId) throw new Error('Create the household first.');
  await ensureToken();
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + cfg.householdFileId + '/permissions?sendNotificationEmail=true',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
    });
  if (!res.ok) throw new Error('invite ' + res.status);
}
export async function joinHousehold() {
  const cfg = syncConfig();
  await ensureToken();
  const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
    .setMimeTypes('application/json').setMode(window.google.picker.DocsViewMode.LIST);
  const id = await new Promise((res) => {
    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(cfg.apiKey)
      .setCallback((data) => {
        if (data.action === window.google.picker.Action.PICKED) res(data.docs[0].id);
        else if (data.action === window.google.picker.Action.CANCEL) res(null);
      })
      .build();
    picker.setVisible(true);
  });
  if (id) { cfg.householdFileId = id; save(); }
  return id;
}

// ---- the sync loop: pull → merge → push, for shared + private files ----
export async function syncNow() {
  const cfg = syncConfig();
  if (!cfg.clientId || syncing) return;
  syncing = true; onStatus('syncing');
  let changed = false;
  try {
    await ensureToken();
    // shared household file
    if (cfg.householdFileId) {
      let remote = null;
      try { remote = await readFile(cfg.householdFileId); } catch (e) { /* first read may 404 */ }
      changed = applySync('shared', remote) || changed;
      await writeFile(cfg.householdFileId, syncSnapshot('shared', state.profile));
    }
    // private backup file in this person's own Drive
    if (cfg.privateBackup !== false) {
      let pid = cfg.privateFileId || await findOwnFile(PRIVATE_NAME);
      if (!pid) pid = await createFile(PRIVATE_NAME, syncSnapshot('private', state.profile));
      else { const r = await readFile(pid).catch(() => null); changed = applySync('private', r) || changed; await writeFile(pid, syncSnapshot('private', state.profile)); }
      cfg.privateFileId = pid;
    }
    cfg.lastSync = Date.now();
    save();
    onStatus('ok');
    if (changed) document.dispatchEvent(new CustomEvent('stratos:changed'));
  } catch (e) {
    console.warn('sync failed:', e.message);
    onStatus('error:' + e.message);
  } finally {
    syncing = false;
  }
}
