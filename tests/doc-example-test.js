// Runs the worked example EXACTLY as it appears in docs/PEER-INGEST.md §8 —
// extracted from the markdown at run time, not copied — against a faithful mock
// of apps-script.gs and the real Stratos sync. If the doc drifts from something
// that works, this fails.
import { readFileSync } from 'fs';

let T = 1_700_000_000_000;
const CODE = 'ABCD-EFGH-JKLM-NPQR';
const GAS = 'https://script.google.com/macros/s/fake/exec';

const files = {};
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const household = String(body.household || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  if (!household) return { ok: true, json: async () => ({ error: 'missing household' }), text: async () => '{"error":"missing household"}' };
  const store = files[household] || (files[household] = {});
  let out;
  if (body.action === 'get') out = { ok: true, store };
  else if (body.action === 'put') {
    const device = String(body.device || 'd').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
    store[device] = String(body.data || '');
    out = { ok: true };
  } else out = { error: 'bad action' };
  return { ok: true, json: async () => out, text: async () => JSON.stringify(out) };
};

let ls = new Map();
globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
globalThis.document = { dispatchEvent() {} };
const realNow = Date.now;
globalThis.Date.now = () => T;

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('✓', n)) : (fail++, console.log('✗', n)); };

// --- pull the js block out of §8 ---
const md = readFileSync(new URL('../docs/PEER-INGEST.md', import.meta.url), 'utf8');
const sec = md.slice(md.indexOf('## 8. A worked example'), md.indexOf('## 9. Known limits'));
const block = sec.match(/```js\n([\s\S]*?)```/);
ok('§8 contains a runnable js block', !!block);
const src = block[1];
ok('...and it defines push()', /async function push\(/.test(src));

// evaluate it, then hand back the entry point
const factory = new Function(src + '\nreturn { push, householdId };');
const doc = factory();

// --- the peer pushes exactly what §2 documents ---
T += 1000;
const batchAt = T;
const res = await doc.push(GAS, CODE, [
  { externalId: 'familymix:2026-08-24:roede-linser', text: 'Røde linser', quantity: '400 g',
    quantityGrams: 400, category: 'groceries', type: 'supply', scope: 'house',
    note: 'Mon dinner — lentil sauce', neededOn: '2026-08-25' },
]);
ok('the documented push() is accepted by the script', res && res.ok === true);

// --- and Stratos, unmodified, picks it up ---
const S = await import(new URL('../js/store.js', import.meta.url));
const H = await import(new URL('../js/hsync.js', import.meta.url));
S.state.profile = 'anna';
Object.assign(S.syncConfig(), { gasUrl: GAS, code: CODE });
S.saveState();
T += 1000;
await H.syncNow();

const landed = S.state.items.find(i => /linser/i.test(i.title));
ok('the item lands on the family list', !!landed);
ok('...with its amount', landed && landed.quantity === '400 g' && landed.quantityGrams === 400);
ok('...its note', landed && landed.notes === 'Mon dinner — lentil sauce');
ok('...its due date', landed && landed.due === '2026-08-25');
ok('...shared, active, house', landed && landed.visibility === 'shared' && landed.status === 'active' && landed.scope === 'house');
ok('...and it is on the shopping list', S.shoppableItems ? S.shoppableItems().some(i => i.id === landed.id) : landed.type === 'supply');
ok('sync reported no error', !S.syncConfig().lastError);

// --- the self-check §8 recommends must work as described ---
// If the doc's householdId disagreed with the app's, the app's own get/put
// would have created a SECOND key in the store. One key means they agree.
const hid = await doc.householdId(CODE);
ok('the doc householdId matches the app', Object.keys(files).length === 1 && files[hid]);

// Read the ack back the way §4 tells you to, using the doc's own key derivation.
const enc = new TextEncoder();
const normc = c => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
async function docKey(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normc(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('stratos.household.v1'), iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function readAcks() {
  const r = await fetch(GAS, { method: 'POST', headers: {}, body: JSON.stringify({ action: 'get', household: hid }) });
  const { store } = await r.json();
  const key = await docKey(CODE);
  const acks = [];
  for (const [d, blob] of Object.entries(store)) {
    if (/^inbox/i.test(d) || !String(blob).startsWith('v1:')) continue;
    const bytes = Uint8Array.from(atob(blob.slice(3)), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    acks.push((JSON.parse(new TextDecoder().decode(pt)).inboxAck || {}).inboxfamilymix || 0);
  }
  return acks;
}
const acks = await readAcks();
ok('§4: max(inboxAck.inboxfamilymix) has reached the batch at',
  acks.length > 0 && Math.max(...acks) >= batchAt);

// --- and the base64 helper survives a real-sized batch (the RangeError trap) ---
T += 1000;
const big = Array.from({ length: 200 }, (_, k) => ({
  externalId: 'familymix:2026-08-31:' + k, text: 'Vare ' + k, quantity: '1 kg',
  category: 'groceries', type: 'supply', scope: 'house',
}));
let threw = null;
try { await doc.push(GAS, CODE, big); } catch (e) { threw = e; }
ok('a full 200-item batch encodes without RangeError', threw === null);
T += 1000;
await H.syncNow();
ok('...and all 200 land', S.state.items.filter(i => /^Vare /.test(i.title)).length === 200);

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.Date.now = realNow;
if (fail) process.exit(1);
