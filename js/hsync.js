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
  try {
    const hid = await householdId(cfg.code);
    const dev = deviceId();
    const got = await gasCall(cfg, { action: 'get', household: hid });
    const store = got.store || {};
    let peers = 0, readable = 0;
    const inboxes = [];                       // ingested after the merge, see below
    for (const [d, blob] of Object.entries(store)) {
      if (d === dev) continue;
      let remote = null;
      try { remote = await decryptJSON(cfg.code, blob); } catch (e) { /* wrong code for this slot */ }
      if (isPeerInboxSlot(d)) {
        // A peer app's inbox, not a phone: it must not count as "another
        // device linked", and it is ingested rather than merged.
        if (remote) inboxes.push([d, remote]);
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
    if (peers > 0 && readable === 0) {
      throw new Error('The household code on this phone doesn’t match the other phone. Use the exact same code on both.');
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
      if (box.kind !== 'inbox') { reason = reason || d + ': not an inbox payload'; continue; }
      const r = ingestPeerItems(d, box.inbox, box.at);
      ingested += r.added + r.updated;
      dropped += r.dropped;
      // Only a refusal worth acting on is worth reporting; "already consumed"
      // is the normal state of a standing inbox on every sync after the first.
      if (r.reason && r.reason !== 'already consumed') reason = reason || d + ': ' + r.reason;
      if (r.added || r.updated) changed = true;
    }
    if (ingested || dropped || reason) cfg.lastIngest = { at: Date.now(), n: ingested, dropped, reason };
    // Tombstones, seen-news keys and adoption records age out inside applySync,
    // which only runs for OTHER devices' slots — so a household with one phone
    // would never prune at all. Do it here, where every sync passes.
    pruneSyncMaps();
    cfg.peerInboxes = inboxes.length;   // reported separately from real devices
    cfg.peerCount = peers; // other devices in this household — 0 means you're alone (check the code matches!)
    const snap = syncSnapshot('shared', state.profile);
    await gasCall(cfg, { action: 'put', household: hid, device: dev, data: await encryptJSON(cfg.code, snap) });
    cfg.lastSharedCount = Object.keys(snap.items).length;
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
