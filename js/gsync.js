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
let tokenLoaded = false;

// Persist the access token (the user's own, ~1h lived) so a reload doesn't
// sign them out and force a fresh popup every session.
function loadToken() {
  if (tokenLoaded) return;
  tokenLoaded = true;
  const c = syncConfig();
  if (c.tok && c.tok.exp > Date.now() + 5000) { accessToken = c.tok.access; tokenExpiry = c.tok.exp; }
}
function saveToken() {
  const c = syncConfig();
  c.tok = { access: accessToken, exp: tokenExpiry };
  save();
}

export function onSyncStatus(fn) { onStatus = fn; }
export function isSignedIn() { loadToken(); return !!accessToken && Date.now() < tokenExpiry; }
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
// Warm the scripts up early (as soon as Settings opens) so that when the user
// taps Connect the popup opens *inside* the tap gesture. Loading them for the
// first time during the tap loses the gesture on mobile Safari and the sign-in
// popup gets blocked — the #1 cause of "sign-in failed" on a first connect.
export function preloadLibs() { return ensureLibs().catch(() => {}); }

// turn GIS/OAuth error codes into something a human can act on
function friendlyError(code) {
  const c = String(code || '');
  if (/popup_failed_to_open|popup.*block/i.test(c))
    return 'The Google popup was blocked. Allow pop-ups for this site, then tap Connect again.';
  if (/popup_closed|cancel/i.test(c))
    return 'Sign-in was closed before it finished — tap Connect and complete the Google screen.';
  if (/access_denied|admin_policy|org_internal/i.test(c))
    return 'Google blocked access. Add this Google account as a Test user in your Cloud project (console.cloud.google.com/auth/audience), then retry.';
  if (/idpiframe|origin|redirect|invalid_client/i.test(c))
    return 'This Google account/project isn’t set up for this site yet (origin or client-ID mismatch). Check the OAuth client’s Authorized JavaScript origin is https://annakinz.github.io.';
  return c || 'unknown error';
}

// ---- OAuth: full-page redirect (implicit) flow ----
// Popups are blocked on iOS home-screen web apps and often in mobile Safari,
// which is why "Connect" kept failing. Instead we send the whole page to
// Google and it bounces back with the token in the URL — works everywhere,
// no popup. The redirect URL must be registered as an Authorized redirect URI
// on the OAuth client (the app's own directory URL).
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export function redirectUri() {
  return location.origin + location.pathname.replace(/[^/]*$/, ''); // the app's directory, e.g. …/tracking/
}

export function connect() {
  const cfg = syncConfig();
  if (!cfg.clientId) throw new Error('Add your Google client ID in Settings first.');
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem('stratos.oauthState', nonce); // checked on the way back
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    state: nonce,
    prompt: 'consent',
  });
  location.href = AUTH_ENDPOINT + '?' + params.toString();
  return new Promise(() => {}); // page is navigating away; never resolves here
}

// On load: if we came back from Google with a token in the URL fragment, store
// it (and scrub it out of the address bar). Returns true if we just connected.
export function handleRedirect() {
  const h = location.hash || '';
  if (h.indexOf('access_token=') < 0 && h.indexOf('error=') < 0) return false;
  const p = new URLSearchParams(h.replace(/^#/, ''));
  const saved = localStorage.getItem('stratos.oauthState');
  localStorage.removeItem('stratos.oauthState');
  history.replaceState(null, '', location.pathname + location.search); // never leave the token in history
  const cfg = syncConfig();
  const err = p.get('error');
  if (err) { cfg.lastError = 'Google sign-in: ' + friendlyError(err); save(); return false; }
  const token = p.get('access_token'), state = p.get('state');
  if (!token || !state || state !== saved) { cfg.lastError = 'Sign-in response didn’t match — tap Connect again.'; save(); return false; }
  accessToken = token;
  tokenExpiry = Date.now() + (parseInt(p.get('expires_in') || '3600', 10) - 60) * 1000;
  cfg.tok = { access: token, exp: tokenExpiry };
  cfg.everConnected = true;
  cfg.lastError = null;
  save();
  return true;
}

// Sync uses this — it must never navigate away or pop up. It reuses the stored
// token; if it's gone/expired the user reconnects via the Connect button.
async function ensureToken() {
  loadToken();
  if (isSignedIn()) return;
  throw new Error('Google sign-in expired — open Settings and tap Connect Google to reconnect.');
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
  await ensureToken();
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  // a silently-dropped write is the classic "my items never reach the other
  // person" bug — surface it with a plain-language cause
  if (!res.ok) {
    const t = (await res.text().catch(() => '')).slice(0, 140);
    if (res.status === 404) throw new Error("can't reach the household file — it isn't shared with this Google account. Tap “Leave household”, have the other person Invite you, then Join again.");
    if (res.status === 403) throw new Error("read-only access to the household file — the person who created it must Invite you as an editor.");
    throw new Error('write ' + res.status + ' ' + t);
  }
  return res;
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
  if (!res.ok) throw new Error('invite ' + res.status + ' ' + (await res.text().catch(() => '')).slice(0, 140));
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
  if (id) { cfg.householdFileId = id; cfg.lastError = null; save(); }
  return id;
}
// forget the current household file so Create/Join come back (to re-join a
// correctly-shared file). Local items are untouched.
export function leaveHousehold() {
  const cfg = syncConfig();
  cfg.householdFileId = null;
  cfg.lastError = null;
  cfg.lastSharedCount = undefined;
  save();
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
      try { remote = await readFile(cfg.householdFileId); }
      catch (e) { if (!/ 404\b/.test(e.message)) throw e; } // 404 = brand-new file is fine; 403 etc must surface
      changed = applySync('shared', remote) || changed;
      const snap = syncSnapshot('shared', state.profile);
      await writeFile(cfg.householdFileId, snap);
      cfg.lastSharedCount = Object.keys(snap.items).length; // how many shared items we put in the file
    }
    // private backup file in this person's own Drive
    if (cfg.privateBackup !== false) {
      let pid = cfg.privateFileId || await findOwnFile(PRIVATE_NAME);
      if (!pid) pid = await createFile(PRIVATE_NAME, syncSnapshot('private', state.profile));
      else { const r = await readFile(pid).catch(() => null); changed = applySync('private', r) || changed; await writeFile(pid, syncSnapshot('private', state.profile)); }
      cfg.privateFileId = pid;
    }
    cfg.lastSync = Date.now();
    cfg.lastError = null;
    save();
    onStatus('ok');
    if (changed) document.dispatchEvent(new CustomEvent('stratos:changed'));
  } catch (e) {
    cfg.lastError = e.message; save();
    console.warn('sync failed:', e.message);
    onStatus('error:' + e.message);
  } finally {
    syncing = false;
  }
}
