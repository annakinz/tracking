// The Settings "connected apps" panel must tell the three cases apart:
// nothing there / there but undecryptable / there and already consumed.
// The fake household file lives here in Node, so the route handler never has
// to call back into the page (which deadlocks).
import pw from '/opt/node22/lib/node_modules/playwright/index.js';  // browser test: needs Playwright
import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';

const ROOT = new URL('..', import.meta.url).pathname;
const CODE = 'ABCD-EFGH-JKLM-NPQR';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer(async (req, res) => {
  try { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const d = await readFile(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d);
  } catch (e) { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;
let fail = 0; const ok = (n, c) => { console.log(c ? '✓' : '✗', n); if (!c) fail++; };

// --- the household file, Node-side ---
const store = {};
const enc = new TextEncoder();
const normCode = c => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const b64 = (buf) => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };
async function keyFor(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normCode(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: enc.encode('stratos.household.v1'), iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function writeSlot(slot, code, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(code), enc.encode(JSON.stringify(payload)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);
  store[slot] = 'v1:' + b64(out);
}

const b = await pw.chromium.launch({ args: ['--no-sandbox'] });
const page = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

await page.route('**/exec*', (route) => {
  const body = JSON.parse(route.request().postData() || '{}');
  if (body.action === 'put') {
    store[String(body.device).replace(/[^a-zA-Z0-9]/g, '').slice(0, 64)] = String(body.data || '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, store }) });
});

await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle' });
if (await page.isVisible('#firstRun')) await page.click('[data-profile="anna"]');
await page.evaluate(async (code) => {
  const S = await import('./js/store.js');
  Object.assign(S.syncConfig(), { gasUrl: 'https://script.google.com/macros/s/x/exec', code });
  S.saveState();
}, CODE);

const sync = async () => {
  await page.evaluate(async () => { const H = await import('./js/hsync.js'); await H.syncNow(); });
  await page.waitForTimeout(120);
};
const panel = async () => {
  await page.evaluate(() => window.stratosGoto && window.stratosGoto('settings'));
  await page.waitForTimeout(250);
  return page.$eval('.apps-panel', el => el.textContent).catch(() => '(no panel)');
};

// --- 1. no app has written anything ---
await sync();
let t = await panel();
ok('with no app, the panel says so plainly', /None found/.test(t));
ok('...and names the two real causes', /different sync URL/.test(t) && /household code/.test(t));

// --- 2. an app wrote, but under the WRONG household code ---
await writeSlot('inboxfamilymix', 'WRONG-CODE-HERE-XXXX', { v: 1, kind: 'inbox', at: Date.now(), items: {}, deleted: {}, inbox: [] });
await sync();
t = await panel();
ok('an undecryptable inbox is REPORTED, not skipped silently', /cannot decrypt/.test(t));
ok('...named after the app', /familymix/.test(t));
ok('...and blames the household code', /household code does not match/.test(t));

// --- 3. the same app, written correctly ---
await writeSlot('inboxfamilymix', CODE, {
  v: 1, kind: 'inbox', peer: 'familymix', at: Date.now(), items: {}, deleted: {},
  inbox: [
    { externalId: 'fm:1', text: 'Røde linser', quantity: '400 g', category: 'groceries', type: 'supply', scope: 'house' },
    { externalId: 'fm:2', text: 'Havregryn', quantity: '1 kg', category: 'groceries', type: 'supply', scope: 'house' },
  ],
});
await sync();
t = await panel();
ok('a good batch reports what it added', /2 items added just now/.test(t));
const n = await page.evaluate(async () => (await import('./js/store.js')).state.items.filter(i => /linser|havregryn/i.test(i.title)).length);
ok('...and the items really landed', n === 2);

// --- 4. the same batch again: "already taken in", not silence ---
await sync();
t = await panel();
ok('a standing batch says it is already taken in', /already taken in/.test(t));
ok('...rather than looking like nothing happened', !/None found/.test(t));

// --- 5. a payload that forgot kind:"inbox" ---
await writeSlot('inboxmealplan', CODE, { v: 1, at: Date.now(), inbox: [{ externalId: 'x', text: 'Ost' }] });
await sync();
t = await panel();
ok('a missing kind:"inbox" is named exactly', /kind must be "inbox"/.test(t));

ok('no console/page errors', errs.filter(e => !/favicon|manifest|404/i.test(e)).length === 0);
if (errs.length) console.log(errs.slice(0, 5));
console.log(fail ? '\nFAILURES: ' + fail : '\nALL PASSED');
await b.close(); server.close();
process.exit(fail ? 1 : 0);
