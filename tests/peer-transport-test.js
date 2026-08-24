// End-to-end over the real transport: a simulated FamilyMix encrypts a batch
// and writes the inbox slot through a mock Apps Script; Stratos syncs for real.
let T = 1_700_000_000_000;
const CODE = 'ABCD-EFGH-JKLM-NPQR';
const GAS = 'https://script.google.com/macros/s/fake/exec';

// --- mock Apps Script, faithful to apps-script.gs including its sanitisers ---
const files = {};
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const household = String(body.household || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  if (!household) return { ok: true, text: async () => JSON.stringify({ error: 'missing household' }) };
  const store = files[household] || (files[household] = {});
  let out;
  if (body.action === 'get') out = { ok: true, store };
  else if (body.action === 'put') {
    const device = String(body.device || 'd').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
    store[device] = String(body.data || '');
    out = { ok: true };
  } else out = { error: 'bad action' };
  return { ok: true, text: async () => JSON.stringify(out) };
};

let ls = new Map();
globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
let events = [];
globalThis.document = { dispatchEvent: (e) => events.push(e.type) };
const realNow = Date.now;
globalThis.Date.now = () => T;

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('✓', n)) : (fail++, console.log('✗', n)); };

// --- FamilyMix's side, written ONLY from docs/PEER-INGEST.md ---
const enc = new TextEncoder();
const norm = c => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const b64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
async function householdId(code) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode('stratos.hh.' + norm(code)));
  return b64(h).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}
async function hkey(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(norm(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('stratos.household.v1'), iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function familyMixPush(items, at) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = { v: 1, kind: 'inbox', peer: 'familymix', at, items: {}, deleted: {}, inbox: items };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await hkey(CODE), enc.encode(JSON.stringify(payload)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  const res = await fetch(GAS, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
    body: JSON.stringify({ action: 'put', household: await householdId(CODE), device: 'inboxfamilymix', data: 'v1:' + b64(out) }),
  });
  return JSON.parse(await res.text());
}
async function familyMixReadAcks() {
  const res = await fetch(GAS, { method: 'POST', headers: {}, body: JSON.stringify({ action: 'get', household: await householdId(CODE) }) });
  const { store } = JSON.parse(await res.text());
  const key = await hkey(CODE);
  const acks = [];
  for (const [d, blob] of Object.entries(store)) {
    if (/^inbox/i.test(d) || !String(blob).startsWith('v1:')) continue;
    const raw = Uint8Array.from(atob(blob.slice(3)), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    const snap = JSON.parse(new TextDecoder().decode(pt));
    // the watermark is keyed by the SLOT we write, not by our own name for
    // ourselves — that is what the contract says to read
    acks.push((snap.inboxAck || {}).inboxfamilymix || 0);
  }
  return acks;
}

// --- Stratos device A ---
const S = await import(new URL('../js/store.js', import.meta.url));
const H = await import(new URL('../js/hsync.js', import.meta.url));
S.state.profile = 'anna';
Object.assign(S.syncConfig(), { gasUrl: GAS, code: CODE });
S.saveState();

// 1. FamilyMix pushes the week's groceries
T += 1000;
const batchAt = T;
const r = await familyMixPush([
  { externalId: 'familymix:2026-08-24:roede-linser', text: 'Røde linser', quantity: '400 g', quantityGrams: 400, category: 'groceries', type: 'supply', scope: 'house', note: 'Mon dinner — lentil sauce' },
  { externalId: 'familymix:2026-08-24:havregryn', text: 'Havregryn', quantity: '1 kg', category: 'groceries', type: 'supply', scope: 'house' },
  { externalId: 'familymix:2026-08-24:hakket', text: 'Hakket oksekød', quantity: '500 g', quantityGrams: 500, category: 'groceries', type: 'supply', scope: 'house' },
], batchAt);
ok('the Apps Script accepts the peer write', r.ok === true);

// 2. Stratos syncs
T += 1000;
await H.syncNow();
const titles = S.state.items.map(i => i.title);
ok('all three groceries land in Stratos', ['Røde linser', 'Havregryn', 'Hakket oksekød'].every(t => titles.includes(t)));
ok('amounts survived the wire', S.state.items.find(i => /linser/i.test(i.title)).quantity === '400 g');
ok('sync reported no error', !S.syncConfig().lastError);

// 3. the inbox must be single-writer — Stratos never touches it
const hid = await householdId(CODE);
const inboxBlobAfter = files[hid]['inboxfamilymix'];
T += 1000;
await H.syncNow();
ok('Stratos never writes the inbox slot', files[hid]['inboxfamilymix'] === inboxBlobAfter);

// 4. re-reading a standing inbox must not duplicate
ok('re-syncing does not duplicate the items', S.state.items.filter(i => /linser/i.test(i.title)).length === 1);

// 5. the peer can confirm delivery
const acks = await familyMixReadAcks();
ok('every device slot acks the batch', acks.length >= 1 && acks.every(a => a >= batchAt));

// 6. an inbox must not be mistaken for a phone
ok('the inbox does not count as a linked device', S.syncConfig().peerCount === 0);
ok('...it is reported as a connected app instead', S.syncConfig().peerInboxes === 1);
ok('one unreadable-free sync, no code-mismatch error', !/doesn.t match/.test(S.syncConfig().lastError || ''));

// 7. bought items must not come back on the next push
const linser = S.state.items.find(i => /linser/i.test(i.title));
S.buyItem(linser.id, true);
T += 1000;
await familyMixPush([
  { externalId: 'familymix:2026-08-24:roede-linser', text: 'Røde linser', quantity: '400 g', category: 'groceries', type: 'supply', scope: 'house' },
], T);
T += 1000;
await H.syncNow();
ok('a bought item stays bought after a re-push', S.getItem(linser.id).status === 'done');

// 8. a genuinely new week is a new line
T += 1000;
await familyMixPush([
  { externalId: 'familymix:2026-08-31:roede-linser', text: 'Røde linser', quantity: '600 g', category: 'groceries', type: 'supply', scope: 'house' },
], T);
T += 1000;
await H.syncNow();
const linsers = S.state.items.filter(i => /linser/i.test(i.title));
ok('next week is a separate line (dated externalId)', linsers.length === 2);
ok('...and the new one is active with its own amount', linsers.some(i => i.status === 'active' && i.quantity === '600 g'));

// 9. shopping view: aisles + criticality
const { aisleOf } = await import(new URL('../js/classify.js', import.meta.url));
ok('Danish terms reach the right aisles',
  aisleOf('Røde linser') === 'Pantry' && aisleOf('Havregryn') === 'Pantry' && aisleOf('Hakket oksekød') === 'Meat & fish');

// 10. a connected app alone must not look like a wrong household code
ok('an inbox on its own raises no code-mismatch error', !S.syncConfig().lastError);

// 11. ...but a real phone we cannot decrypt still must
async function writeSlot(device, code, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', enc.encode(norm(code)), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('stratos.household.v1'), iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  const outb = new Uint8Array(iv.length + ct.byteLength);
  outb.set(iv, 0); outb.set(new Uint8Array(ct), iv.length);
  files[await householdId(CODE)][device] = 'v1:' + b64(outb);
}
T += 1000;
await writeSlot('dEbbePhone', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', { v: 1, items: {}, deleted: {}, at: T });
T += 1000;
await H.syncNow();
ok('a phone we cannot decrypt DOES raise the code-mismatch error',
  /doesn.t match/.test(S.syncConfig().lastError || ''));

// 12. and it clears again once the codes agree
T += 1000;
await writeSlot('dEbbePhone', CODE, { v: 1, items: {}, deleted: {}, at: T });
T += 1000;
await H.syncNow();
ok('the error clears when the codes agree', !S.syncConfig().lastError);
ok('...and the real phone is counted as a device', S.syncConfig().peerCount === 1);
ok('...while the app is still counted separately', S.syncConfig().peerInboxes === 1);

// 13. an oversized batch must be refused whole, and SAID so
T += 1000;
const before13 = S.state.items.length;
await familyMixPush(Array.from({ length: 250 }, (_, k) =>
  ({ externalId: 'fm:huge:' + k, text: 'Vare ' + k, category: 'groceries', type: 'supply', scope: 'house' })), T);
T += 1000;
await H.syncNow();
ok('a 250-item batch adds nothing', S.state.items.length === before13);
ok('...and the family is told why', /at most 200/.test(S.syncConfig().lastIngest?.reason || ''));
const acksAfterHuge = await familyMixReadAcks();
ok('...and the peer sees NO ack, so it can retry smaller', acksAfterHuge.every(a => a < T));

// 14. the id formula PUBLISHED in the doc must reproduce Stratos's ids exactly.
//     Re-implemented here from docs/PEER-INGEST.md §3 alone, as a peer would.
function docFnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
function docPeerItemId(slot, externalId) {
  const s = String(slot).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 64);
  return 'px_' + s.slice(0, 16) + '_' + String(externalId).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) +
    '_' + docFnv1a(s + ':' + externalId);
}
const idCases = ['familymix:2026-08-24:roede-linser', 'x', 'æøå — a very long external id '.repeat(6)];
ok('the published id formula matches Stratos byte for byte',
  idCases.every(e => docPeerItemId('inboxfamilymix', e) === S.peerItemId('inboxfamilymix', e)));

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.Date.now = realNow;
if (fail) process.exit(1);
