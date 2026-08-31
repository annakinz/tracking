// The app must open on House → Shop, and a FamilyMix line must reach that list
// without being given a pantry reading nobody checked.
import pw from '/opt/node22/lib/node_modules/playwright/index.js';  // browser test: needs Playwright
import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
const ROOT = new URL('..', import.meta.url).pathname;
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
const b = await pw.chromium.launch({ args: ['--no-sandbox'] });
const page = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = []; page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'networkidle' });
if (await page.isVisible('#firstRun')) await page.click('[data-profile="anna"]');
await page.waitForTimeout(300);

ok('the app opens on House', await page.isVisible('#view-house'));
const seg = await page.$$eval('.seg', els => els.map(e => ({ t: e.textContent.trim(), on: e.className.includes('on') })));
ok('...with Shop selected, not Tasks', seg.some(s => /Shop/.test(s.t) && s.on));

// a FamilyMix delivery
await page.evaluate(async () => {
  const S = await import('./js/store.js');
  S.ingestPeerItems('inboxfamilymix', [
    { externalId: 'fm:1', text: 'Røde linser', quantity: '400 g', category: 'groceries', type: 'supply', scope: 'house' },
    { externalId: 'fm:2', text: 'Hakket oksekød', quantity: '500 g', category: 'groceries', type: 'supply', scope: 'house' },
  ], Date.now());
  S.saveState();
});
await page.evaluate(() => window.stratosGoto('lists'));
await page.evaluate(() => window.stratosGoto('house'));
await page.waitForTimeout(300);

const titles = await page.$$eval('.shop-title', els => els.map(e => e.textContent));
ok('the delivery is on the Shop list', titles.some(t => /linser/i.test(t)) && titles.some(t => /oksek/i.test(t)));
ok('...with its amounts', (await page.$$eval('.qty', els => els.map(e => e.textContent))).includes('400 g'));

const flags = await page.$$eval('.shop-flag', els => els.map(e => e.textContent));
ok('no pantry label is claimed for them', !flags.some(f => /Getting low|Stocked|Plenty|Fine/.test(f)));
const sized = await page.evaluate(async () => {
  const S = await import('./js/store.js');
  return S.state.items.filter(i => String(i.id).startsWith('px_')).map(i => S.uOf(i, 'restock'));
});
ok('...because the dial is genuinely unset', sized.length === 2 && sized.every(v => v === null));

// a grocery the family types itself still gets the sensible default
await page.evaluate(async () => {
  const S = await import('./js/store.js');
  S.addItem({ title: 'Smør', type: 'supply', scope: 'house', category: 'groceries' });
  S.saveState();
});
const own = await page.evaluate(async () => {
  const S = await import('./js/store.js');
  const i = S.state.items.find(x => x.title === 'Smør');
  return S.uOf(i, 'restock');
});
ok('a hand-added grocery is still auto-sized', own !== null && Math.floor(own) === 3);

ok('no console/page errors', errs.filter(e => !/favicon|manifest|404/i.test(e)).length === 0);
if (errs.length) console.log(errs.slice(0, 5));
console.log(fail ? '\nFAILURES: ' + fail : '\nALL PASSED');
await b.close(); server.close();
process.exit(fail ? 1 : 0);
