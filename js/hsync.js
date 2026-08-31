// Household sync — no per-user sign-in.
//
// A tiny Google Apps Script (see apps-script.gs) runs as its owner and keeps a
// small file in the owner's Google Drive. Both phones POST to that script's
// URL; the script never signs anyone in. Everyone in the household shares one
// secret CODE, which is the AES key: data is encrypted on the phone before it
// is sent, so the script (and Drive, and anyone who finds the URL) only ever
// sees ciphertext. Each device writes only its own slot in the file, so there
// is no clobbering — the merge (store.js applySync) happens on the phone.

import { state, save, syncConfig, syncSnapshot, applySync, isPeerInboxSlot, ingestPeerItems, pruneSyncMaps } from './store.js';

let syncing = false;
let onStatus = () => {};
export function onSyncStatus(fn) { onStatus = fn; }
export function syncConfigured() { const c = syncConfig(); return !!(c.gasUrl && c.code); }

// ---------- crypto: AES-GCM, key derived from the household code ----------
const te = new TextEncoder(), td = new TextDecoder();
function b64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function unb64(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

// normalize so "abcd-efgh", "ABCD EFGH", "ABCDEFGH" all mean the same
// household — a mismatched-looking code is the #1 way two phones miss each other
function normCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

async function keyFromCode(code) {
  const base = await crypto.subtle.importKey('raw', te.encode(normCode(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode('stratos.household.v1'), iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptJSON(code, obj) {
  const key = await keyFromCode(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  return 'v1:' + b64(out);
}
async function decryptJSON(code, blob) {
  if (!blob || typeof blob !== 'string' || blob.slice(0, 3) !== 'v1:') return null;
  const key = await keyFromCode(code);
  const raw = unb64(blob.slice(3));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(td.decode(pt));
}
// a non-secret id for the household so the script can key the file without
// knowing the code (the code stays on the phones as the encryption key)
async function householdId(code) {
  const h = await crypto.subtle.digest('SHA-256', te.encode('stratos.hh.' + normCode(code)));
  return b64(h).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}
function deviceId() {
  const c = syncConfig();
  if (!c.deviceId) { c.deviceId = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); save(); }
  return c.deviceId;
}

// a friendly code to hand the other person: 4 groups, no ambiguous chars
export function makeCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(16));
  let s = ''; for (let i = 0; i < 16; i++) { if (i && i % 4 === 0) s += '-'; s += abc[r[i] % abc.length]; }
  return s;
}

// ---------- transport: simple text/plain POST (no CORS preflight) ----------
async function gasCall(cfg, body) {
  let res;
  try {
    res = await fetch(cfg.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // "simple" request → no preflight
      body: JSON.stringify(body),
      redirect: 'follow',
    });
  } catch (e) { throw new Error('Could not reach the sync script — check the URL and your connection.'); }
  if (!res.ok) throw new Error('script ' + res.status + ' — is it deployed to “Anyone”?');
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error('The script URL didn’t return sync data — make sure it ends in /exec and is deployed as a Web app.'); }
  if (j.error) throw new Error('script: ' + j.error);
  return j;
}

// ---------- the sync loop: pull everyone's slot, merge, push mine ----------
export async function syncNow() {
  const cfg = syncConfig();
  if (!syncConfigured() || syncing) return;
  syncing = true; onStatus('syncing');
  let changed = false;
  // Pin the code and URL for the whole run. syncNow awaits half a dozen times,
  // and the household id is derived from the code — so re-reading cfg.code
  // later means that editing the code mid-sync encrypts with the NEW key and
  // writes it into the OLD household's file, which no phone on either code can
  // then read. Everything below uses these locals.
  const code = cfg.code;
  const conn = { gasUrl: cfg.gasUrl };
  let codeWarning = null;
  try {
    const hid = await householdId(code);
    const dev = deviceId();
    const got = await gasCall(conn, { action: 'get', household: hid });
    const store = got.store || {};
    let peers = 0, readable = 0;
    const inboxes = [];                       // ingested after the merge, see below
    const apps = [];                          // one status line per connected app
    // Every slot in the file, so "nothing arrived" can be answered with what
    // DID arrive instead of a shrug.
    const slots = [];
    for (const [d, blob] of Object.entries(store)) {
      let remote = null;
      try { remote = await decryptJSON(code, blob); } catch (e) { /* wrong code for this slot */ }
      slots.push({ name: d, mine: d === dev, readable: !!remote });
      if (d === dev) continue;
      // An inbox payload written to a slot that is NOT named inbox* is treated
      // as another phone's snapshot and merged — which, with the empty items
      // and deleted maps the contract requires, is a silent no-op. Catch it by
      // its payload rather than its name and say so.
      if (remote && remote.kind === 'inbox' && !isPeerInboxSlot(d)) {
        apps.push({ name: d, bad: 'wrote to a slot named “' + d + '” — the slot name must start with “inbox”' });
        continue;
      }
      if (isPeerInboxSlot(d)) {
        // A peer app's inbox, not a phone: it must not count as "another
        // device linked", and it is ingested rather than merged.
        //
        // An inbox we cannot DECRYPT used to vanish here without a trace —
        // not counted, not reported — which looks from the outside exactly
        // like the app never wrote anything. It is the likeliest failure in
        // the whole integration (the app is using a different household code),
        // so it has to be the loudest.
        if (remote) inboxes.push([d, remote]);
        else apps.push({ name: d.replace(/^inbox/i, '') || d, bad: 'unreadable' });
        continue;
      }
      peers++;
      if (remote) { readable++; changed = applySync('shared', remote) || changed; }
    }
    // The single most common setup mistake, and it has to stay loud: other
    // phones are publishing but not one of their slots decrypts, so the code on
    // this phone is wrong. Excluding inbox slots above is what lets this test
    // stay honest — a connected app is not a phone, and its unreadable slot
    // must neither raise this nor mask it.
    //
    // Reported, NOT thrown. Aborting here would also skip peer ingest, the
    // prune, and publishing this phone's own slot — so a single unreadable
    // device slot (a corrupt write, a phone left behind by a code rotation)
    // would silently freeze everything else too. Refusing to publish cannot
    // make a wrong code right; saying so plainly can.
    if (peers > 0 && readable === 0) {
      codeWarning = 'The household code on this phone doesn’t match the other phone. Use the exact same code on both.';
    }

    // Ingest peer inboxes. We deliberately do NOT write these slots: the
    // inbox is single-writer (the peer), and a client blanking it would
    // silently destroy any batch that arrived between the read and the write —
    // the Apps Script has no compare-and-swap to prevent that. A watermark
    // inside ingestPeerItems consumes each batch exactly once instead.
    //
    // The SLOT NAME is the peer's identity — not the `peer` field inside the
    // payload, which the peer writes itself and could set to anything.
    let ingested = 0, dropped = 0, reason = null;
    for (const [d, box] of inboxes) {
      const name = d.replace(/^inbox/i, '') || d;
      if (box.kind !== 'inbox') {
        apps.push({ name, bad: 'not an inbox payload (kind must be "inbox")' });
        reason = reason || d + ': not an inbox payload';
        continue;
      }
      const r = ingestPeerItems(d, box.inbox, box.at);
      ingested += r.added + r.updated;
      dropped += r.dropped;
      // Say what happened to THIS app's batch, every sync. "Already consumed"
      // is the normal steady state and is not an error, but it still has to be
      // visible: without it, an app that is working perfectly and an app that
      // is not writing at all look identical from the Settings screen.
      apps.push({
        name,
        n: r.added + r.updated,
        sent: Array.isArray(box.inbox) ? box.inbox.length : 0,
        at: Number(box.at) || 0,
        bad: r.reason && r.reason !== 'already consumed' ? r.reason : null,
        idle: r.reason === 'already consumed',
      });
      if (r.reason && r.reason !== 'already consumed') reason = reason || d + ': ' + r.reason;
      if (r.added || r.updated) changed = true;
    }
    cfg.peerApps = apps;
    cfg.slots = slots;
    // Not a secret (it is a hash of the code, and the script keys the file by
    // it) — and it is the fastest way to settle "are we even writing to the
    // same file?" with whoever is on the other end.
    cfg.householdId = hid;
    if (ingested || dropped || reason) cfg.lastIngest = { at: Date.now(), n: ingested, dropped, reason };
    // Tombstones, seen-news keys and adoption records age out inside applySync,
    // which only runs for OTHER devices' slots — so a household with one phone
    // would never prune at all. Do it here, where every sync passes.
    pruneSyncMaps();
    cfg.peerInboxes = apps.length;      // reported separately from real devices
    cfg.peerCount = peers; // other devices in this household — 0 means you're alone (check the code matches!)
    // Announce what already landed BEFORE the push. The merge and the ingest
    // are done and saved by this point; if the upload then fails, the delivery
    // is still on this phone — and because ingest is watermarked and the merge
    // is idempotent, no later sync would ever raise the event again. The screen
    // would sit there stale until something else happened to redraw it.
    if (changed) { document.dispatchEvent(new CustomEvent('stratos:changed')); changed = false; }
    const snap = syncSnapshot('shared', state.profile);
    // The code can have been edited while we were away; writing our snapshot
    // now would put it in the wrong household's file under the wrong key.
    if (cfg.code !== code) throw new Error('Household code changed mid-sync — nothing was written. Tap Sync now.');
    await gasCall(conn, { action: 'put', household: hid, device: dev, data: await encryptJSON(code, snap) });
    cfg.lastSharedCount = Object.keys(snap.items).length;
    cfg.lastSync = Date.now();
    cfg.lastError = codeWarning;
    save();
    onStatus(codeWarning ? 'error:' + codeWarning : 'ok');
  } catch (e) {
    // Report first, save second: save() can itself throw on a full quota, and
    // when it did, it took the error report down with it and the family saw
    // nothing at all.
    console.warn('sync failed:', e.message);
    onStatus('error:' + e.message);
    cfg.lastError = e.message;
    try { save(); } catch (e2) { /* nothing left to do — the status is already out */ }
    if (changed) document.dispatchEvent(new CustomEvent('stratos:changed'));
  } finally {
    syncing = false;
  }
}
