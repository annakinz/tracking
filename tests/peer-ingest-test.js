// Peer ingest: the contract in docs/PEER-INGEST.md, plus every hazard the
// adversarial review raised.
let T = 1_700_000_000_000;
let ls = new Map();
globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
globalThis.document = { dispatchEvent() {} };
globalThis.Date.now = () => T;

const A = await import(new URL('../js/store.js', import.meta.url)); A.state.profile = 'anna';
ls = new Map();
const B = await import(new URL('../js/store.js?dev2', import.meta.url)); B.state.profile = 'ebbe';

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('✓', n)) : (fail++, console.log('✗', n)); };
const wire = (s) => JSON.parse(JSON.stringify(s));
const pull = (to, from, who) => to.applySync('shared', wire(from.syncSnapshot('shared', who)));
const batch = (items, at) => ({ v: 1, kind: 'inbox', peer: 'familymix', at, items: {}, deleted: {}, inbox: items });
const item = (o) => ({ externalId: o.e, text: o.t, quantity: o.q, category: 'groceries', type: 'supply', scope: 'house', ...o });

// ---------- basic ingest ----------
T += 1000;
let r = A.ingestPeerItems('familymix', [
  item({ e: 'fm:2026-08-24:linser', t: 'Røde linser', q: '400 g', quantityGrams: 400, note: 'Mon dinner' }),
  item({ e: 'fm:2026-08-24:havregryn', t: 'Havregryn', q: '1 kg' }),
], T);
ok('ingests a batch', r.added === 2);
const linser = A.state.items.find(i => /linser/i.test(i.title));
ok('quantity is a first-class field', linser.quantity === '400 g' && linser.quantityGrams === 400);
ok('note becomes notes', linser.notes === 'Mon dinner');
ok('forced shared + active + house', linser.visibility === 'shared' && linser.status === 'active' && linser.scope === 'house');
ok('auto-sized to Getting low', Math.floor(A.uOf(linser, 'restock')) === 3);
ok('id is namespaced px_', linser.id.startsWith('px_'));
ok('externalId retained', linser.externalId === 'fm:2026-08-24:linser');

// ---------- forced fields: a peer must not be able to tick off or hide ----------
T += 1000;
A.ingestPeerItems('familymix', [item({
  e: 'fm:evil', t: 'Sneaky', status: 'done', visibility: 'private', parent: 'i1_x',
  createdBy: 'anna', dims: { priority: { s: 'priority_6', f: 1 } }, id: 'i999_hack',
})], T);
const sneaky = A.state.items.find(i => i.title === 'Sneaky');
ok('peer cannot set status done', sneaky.status === 'active');
ok('peer cannot set visibility private', sneaky.visibility === 'shared');
ok('peer cannot set parent', sneaky.parent === null);
ok('peer cannot forge createdBy', sneaky.createdBy === 'app:familymix');
ok('peer cannot preset priority', !sneaky.dims.priority);
ok('peer cannot choose the id', sneaky.id.startsWith('px_') && sneaky.id !== 'i999_hack');

// ---------- peer can never address a family item ----------
const mine = A.addItem({ title: 'Family secret', scope: 'anna', visibility: 'private' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: mine.id, t: 'Hijacked' })], T);
ok('externalId equal to a real id cannot hijack it', A.getItem(mine.id).title === 'Family secret');

// ---------- watermark: a batch is consumed exactly once ----------
const before = A.state.items.length;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:2026-08-24:linser', t: 'Røde linser', q: '400 g' })], T);
ok('replaying the same batch at is ignored wholesale', r.ignoredBatch === true && A.state.items.length === before);
T -= 5000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:old', t: 'Old batch' })], T);
ok('an older batch is refused (replay defence)', r.ignoredBatch === true);
T += 6000;

// ---------- no resurrection ----------
A.buyItem(linser.id, true);                       // the family buys it
ok('bought item is done', A.getItem(linser.id).status === 'done');
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:2026-08-24:linser', t: 'Røde linser', q: '400 g' })], T);
ok('a re-push does NOT reopen a bought item', A.getItem(linser.id).status === 'done' && r.skipped === 1);

const gryn = A.state.items.find(i => /havregryn/i.test(i.title));
A.deleteItem(gryn.id);
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:2026-08-24:havregryn', t: 'Havregryn', q: '1 kg' })], T);
ok('a re-push does NOT revive a deleted item', !A.getItem(gryn.id) && r.skipped === 1);

// ---------- corrections update only what the peer owns ----------
const keep = A.state.items.find(i => i.title === 'Sneaky');
A.updateItem(keep.id, { source: 'Netto' });
A.setMagnitude(keep.id, 'restock', A.state.dims.restock.strata[6].id, 0.5);   // family says "Out!"
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:evil', t: 'Sneaky', q: '2 kg' })], T);
const after = A.getItem(keep.id);
ok('a correction updates the amount', after.quantity === '2 kg');
ok("the family's own sizing survives", Math.floor(A.uOf(after, 'restock')) === 6);
ok("the family's own source survives", after.source === 'Netto');

// ---------- convergence: two devices ingest the same batch ----------
T += 1000;
const shared = batch([item({ e: 'fm:2026-08-31:mælk', t: 'Mælk', q: '2 l' })], T);
A.ingestPeerItems(shared.peer, shared.inbox, shared.at);
B.ingestPeerItems(shared.peer, shared.inbox, shared.at);
const idA = A.state.items.find(i => /mælk/i.test(i.title)).id;
const idB = B.state.items.find(i => /mælk/i.test(i.title)).id;
ok('both devices mint the SAME id', idA === idB);
pull(B, A, 'anna'); pull(A, B, 'ebbe');
ok('after sync there is exactly one Mælk on A', A.state.items.filter(i => /mælk/i.test(i.title)).length === 1);
ok('after sync there is exactly one Mælk on B', B.state.items.filter(i => /mælk/i.test(i.title)).length === 1);

// ---------- watermark rides the snapshot, so a NEW phone doesn't re-ingest ----------
ls = new Map();
const C = await import(new URL('../js/store.js?dev3', import.meta.url)); C.state.profile = 'anna';
pull(C, A, 'anna');
ok('a fresh phone inherits the watermark', (C.peerAckMap()['familymix'] || 0) >= shared.at);
r = C.ingestPeerItems(shared.peer, shared.inbox, shared.at);
ok('fresh phone refuses the already-consumed batch', r.ignoredBatch === true);

// ---------- attaches to an item the family already added by hand ----------
T += 1000;
const byHand = A.addItem({ title: 'Smør', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:2026-08-31:smoer', t: 'Smør', q: '250 g' })], T);
ok('no duplicate line for something already listed', A.state.items.filter(i => i.title === 'Smør').length === 1);
ok('the amount is attached to the existing row', A.getItem(byHand.id).quantity === '250 g');

// ---------- an inbox payload is never merged as items ----------
T += 1000;
const poisoned = { v: 1, kind: 'inbox', at: T, items: { 'i_evil': { id: 'i_evil', title: 'Injected', visibility: 'shared', updatedAt: T } }, deleted: { [idA]: T + 1 }, inbox: [] };
const n0 = A.state.items.length;
const ch = A.applySync('shared', poisoned);
ok('applySync refuses an inbox payload outright', ch === false && A.state.items.length === n0);
ok('...and its deleted map is ignored too', !!A.getItem(idA));

// ---------- a far-future tombstone cannot be planted ----------
T += 1000;
const target = A.getItem(idA);
B.applySync('shared', { v: 1, items: {}, deleted: { [idA]: 4102444800000 }, at: T });
const planted = B.state.syncTomb.shared[idA];
ok('future-dated tombstones are clamped to now', planted <= T + 5 * 60e3);

// ---------- malformed input never throws, and never half-lands ----------
T += 1000;
let threw = false, mres = null;
const nBefore = A.state.items.length;
const ackBeforeBad = A.peerAckMap()['familymix'] || 0;
try {
  mres = A.ingestPeerItems('familymix', [null, 42, 'nope', {}, { externalId: 'x' }, { text: 'no id' },
    { externalId: 'y', text: 'ctrl chars', neededOn: '2026-01-01" onfocus="alert(1)' }], T);
} catch (e) { threw = true; }
ok('malformed entries never throw', threw === false);
ok('a malformed entry refuses the WHOLE batch', mres.ignoredBatch === true && /malformed/.test(mres.reason || ''));
ok('...naming which item was at fault', /item 1 of 7/.test(mres.reason || ''));
ok('...and nothing at all lands', A.state.items.length === nBefore);
ok('...and the watermark does not move', (A.peerAckMap()['familymix'] || 0) === ackBeforeBad);

// the same content, well-formed, must still be sanitised rather than trusted
T += 1000;
A.ingestPeerItems('familymix', [
  { externalId: 'y', text: 'ctrl\u0007 chars', neededOn: '2026-01-01" onfocus="alert(1)' },
], T);
const ctrl = A.state.items.find(i => i.externalId === 'y');
ok('control characters stripped from text', ctrl && !/[\u0000-\u001f]/.test(ctrl.title));
ok('a non-ISO neededOn is dropped, not stored', ctrl && ctrl.due === null);

// ---------- batch cap: refuse whole, never truncate-and-ack ----------
const ackBeforeHuge = A.peerAckMap()['familymix'];
T += 1000;
const huge = Array.from({ length: 500 }, (_, k) => item({ e: 'fm:bulk:' + k, t: 'Bulk ' + k }));
r = A.ingestPeerItems('familymix', huge, T);
ok('an oversized batch is refused whole', r.ignoredBatch === true && r.added === 0);
ok('...and says how many were sent', r.dropped === 500 && /at most 200/.test(r.reason || ''));
ok('...and NOTHING from it lands', !A.state.items.some(i => /^Bulk /.test(i.title)));
ok('...and the watermark does NOT advance (peer can retry)',
  A.peerAckMap()['familymix'] === ackBeforeHuge);
T += 1000;
r = A.ingestPeerItems('familymix', huge.slice(0, 200), T);
ok('re-sent inside the cap, it lands in full', r.added === 200);

// ---------- a peer must never reach a PRIVATE item ----------
T += 1000;
const secret = A.addItem({ title: 'Pregnancy test', scope: 'house', type: 'supply', category: 'groceries', visibility: 'private' });
ok('the private item really is private', A.getItem(secret.id).visibility === 'private');
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:snoop:test', t: 'Pregnancy test', q: '2 stk' })], T);
const stillSecret = A.getItem(secret.id);
ok('a phrase match cannot write into a private item', !stillSecret.quantity && !stillSecret.externalId);
ok('...it becomes a separate shared line instead', r.added === 1);
ok('...and the private item is still private', stillSecret.visibility === 'private');

// ---------- two peer apps are separate tenants ----------
T += 1000;
A.ingestPeerItems('inboxfamilymix', [item({ e: 'shared:external:id', t: 'Ost', q: '200 g' })], T);
T += 1000;
A.ingestPeerItems('inboxmealplanner', [item({ e: 'shared:external:id', t: 'Ost', q: '500 g' })], T);
const osts = A.state.items.filter(i => i.title === 'Ost');
ok('the same externalId from two apps does NOT collide', osts.length === 2);
ok('each app gets its own id namespace', new Set(osts.map(i => i.id)).size === 2);
ok('one app cannot overwrite the other’s amount',
  osts.some(i => i.quantity === '200 g') && osts.some(i => i.quantity === '500 g'));
ok('watermarks are per-slot, not per self-declared name',
  A.peerAckMap()['inboxfamilymix'] !== A.peerAckMap()['inboxmealplanner']);

// ---------- a peer cannot impersonate a family member ----------
T += 1000;
A.ingestPeerItems('inboxanna', [item({ e: 'imp:1', t: 'Impostor' })], T);
const imp = A.state.items.find(i => i.title === 'Impostor');
ok('a slot named after a person is not that person', imp.createdBy === 'app:anna' && imp.createdBy !== 'anna');
ok('...and it still reads nicely in the UI', A.memberName(imp.createdBy) === 'anna');

// ---------- a delivery raises exactly one news card ----------
A.state.newsInit = true;
A.clearNews();
T += 1000;
const nAt = T;
A.ingestPeerItems('familymix', [item({ e: 'news:a', t: 'Ærter' }), item({ e: 'news:b', t: 'Persille' })], nAt);
let cards = A.newsItems().filter(n => n.kind === 'peer');
ok('the ingesting phone is told a delivery arrived', cards.length === 1 && /2 items from familymix/.test(cards[0].title));
// the OTHER phone learns second-hand and must not raise a second card for it
B.state.newsInit = true;
pull(B, A, 'anna');
B.clearNews();
pull(B, A, 'anna');
ok('the second-hand card does not double up', B.newsItems().filter(n => n.kind === 'peer').length === 0);

// ---------- re-reading a standing inbox must not churn sync ----------
T += 1000;
const hand = A.addItem({ title: 'Rugbrød', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:rug', t: 'Rugbrød', q: '1 stk' })], T);
const stampAfterAttach = A.getItem(hand.id).updatedAt;
T += 60000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:rug', t: 'Rugbrød', q: '1 stk' })], T);
ok('a no-op re-push does not bump updatedAt', A.getItem(hand.id).updatedAt === stampAfterAttach);

// ---------- a batch with no timestamp is refused, loudly ----------
r = A.ingestPeerItems('familymix', [item({ e: 'no:at', t: 'Undated' })], undefined);
ok('a batch with no "at" is refused', r.ignoredBatch === true && /at/.test(r.reason || ''));
ok('...and nothing from it lands', !A.state.items.some(i => i.title === 'Undated'));

// ---------- wrong JSON types cannot be stringified into the list ----------
T += 1000;
r = A.ingestPeerItems('familymix', [{ externalId: 'types:1', text: ['M\u00e6lk', 'Fl\u00f8de'] }], T);
ok('an array text is malformed, not joined into "M\u00e6lk,Fl\u00f8de"',
  r.ignoredBatch === true && !A.state.items.some(i => /Fl\u00f8de/.test(i.title)));
T += 1000;
A.ingestPeerItems('familymix', [
  { externalId: 'types:2', text: 'Guler\u00f8dder', quantity: { amount: 400, unit: 'g' }, quantityGrams: '400' },
], T);
const gul = A.state.items.find(i => i.externalId === 'types:2');
ok('an object quantity becomes null, not "[object Object]"', gul && gul.quantity === null);
ok('a string quantityGrams is refused, not coerced', gul && gul.quantityGrams === null);

// ---------- a merged line stays deleted (the twin-adoption resurrection) ----------
T += 1000;
const byHand2 = A.addItem({ title: 'Kaffe', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:kaffe', t: 'Kaffe', q: '500 g' })], T);
ok('the peer line merged into the family row', A.getItem(byHand2.id).quantity === '500 g'
  && !A.state.items.some(i => i.id.startsWith('px_') && i.title === 'Kaffe'));
A.deleteItem(byHand2.id);
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:kaffe', t: 'Kaffe', q: '500 g' })], T);
ok('deleting the merged row blocks the peer id too', !A.state.items.some(i => i.title === 'Kaffe'));
ok('...and it is reported as a refusal', r.skipped === 1 && r.added === 0);

// ---------- a re-push must not rename the family's own row ----------
T += 1000;
const named = A.addItem({ title: 'Mel', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:mel', t: 'Mel', q: '1 kg' })], T);
A.updateItem(named.id, { title: 'Mel — den grove' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:mel', t: 'Mel', q: '2 kg' })], T);
ok("a re-push corrects the amount but keeps the family's title",
  A.getItem(named.id).title === 'Mel — den grove' && A.getItem(named.id).quantity === '2 kg');

// ---------- a far-future ack must not kill the channel for ever ----------
const D = await import(new URL('../js/store.js?dev4', import.meta.url)); D.state.profile = 'anna';
T += 1000;
D.applySync('shared', { v: 1, at: T, items: {}, deleted: {}, inboxAck: { familymix: 4102444800000 } });
ok('an incoming watermark is clamped to now', D.peerAckMap()['familymix'] <= T + 5 * 60e3);
T += 1000;
r = D.ingestPeerItems('familymix', [item({ e: 'fm:after', t: 'Stadig muligt' })], T);
ok('...so the peer channel still works afterwards', r.added === 1);
T += 1000;
const ackBeforeFuture = D.peerAckMap()['familymix'];
r = D.ingestPeerItems('familymix', [item({ e: 'fm:future', t: 'Fra fremtiden' })], 4102444800000);
ok('a far-future batch is refused, not absorbed', r.ignoredBatch === true && /future/.test(r.reason || ''));
ok('...and the watermark is untouched', D.peerAckMap()['familymix'] === ackBeforeFuture);
T += 1000;
r = D.ingestPeerItems('familymix', [item({ e: 'fm:sane', t: 'Igen normal' })], T);
ok('...so a sane batch straight after still lands', r.added === 1);

// ---------- an already-poisoned tombstone repairs itself ----------
const E = await import(new URL('../js/store.js?dev5', import.meta.url)); E.state.profile = 'anna';
E.state.syncTomb = { shared: { 'i9_stuck': 4102444800000 }, private: {} };
T += 1000;
E.applySync('shared', { v: 1, at: T, items: {}, deleted: {} });
ok('a tombstone already in state is pulled back into the prune window',
  E.state.syncTomb.shared['i9_stuck'] <= T + 5 * 60e3);

// ---------- unsharing a merged row takes it out of the peer's reach ----------
T += 1000;
const shared2 = A.addItem({ title: 'Vin', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:vin', t: 'Vin', q: '2 fl' })], T);
ok('the peer line merged into the shared row', A.getItem(shared2.id).quantity === '2 fl');
A.updateItem(shared2.id, { visibility: 'private' });
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:vin', t: 'Vin', q: '6 fl' })], T);
ok('making it private puts it beyond the peer', A.getItem(shared2.id).quantity === '2 fl');
ok('...and no shadow copy is created either',
  A.state.items.filter(i => i.title === 'Vin').length === 1);

// ---------- impossible dates ----------
ok('a well-shaped impossible date is refused', A.validDue('2026-13-45') === null);
ok('a rolled-over date is refused', A.validDue('2026-02-30') === null);
ok('a real date passes', A.validDue('2026-08-24') === '2026-08-24');
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:baddate', t: 'Skæv dato', neededOn: '2026-02-30' })], T);
ok('a peer cannot push an impossible due date',
  A.state.items.find(i => i.externalId === 'fm:baddate').due === null);

// ---------- a correction must not ERASE what it omits ----------
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:erase', t: 'Ris', q: '1 kg', quantityGrams: 1000 })], T);
const rice = A.state.items.find(i => i.externalId === 'fm:erase');
ok('the amount landed', rice.quantity === '1 kg' && rice.quantityGrams === 1000);
T += 1000;
A.ingestPeerItems('familymix', [{ externalId: 'fm:erase', text: 'Ris' }], T);   // no quantity at all
ok('omitting quantity does NOT blank it', A.getItem(rice.id).quantity === '1 kg');
ok('omitting quantityGrams does NOT blank it', A.getItem(rice.id).quantityGrams === 1000);
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:erase', t: 'Ris', q: '2 kg' })], T);
ok('but a supplied amount still corrects it', A.getItem(rice.id).quantity === '2 kg');

// the same, on a row the FAMILY typed the amount onto
T += 1000;
const own = A.addItem({ title: 'Sukker', scope: 'house', type: 'supply', category: 'groceries' });
A.updateItem(own.id, { quantity: '500 g' });
T += 1000;
A.ingestPeerItems('familymix', [{ externalId: 'fm:sukker', text: 'Sukker' }], T);
ok("a peer push cannot blank the family's own amount", A.getItem(own.id).quantity === '500 g');

// ---------- one app cannot claim a row another app adopted ----------
T += 1000;
const contested = A.addItem({ title: 'Chokolade', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('inboxappone', [item({ e: 'shared:eid', t: 'Chokolade', q: '100 g' })], T);
ok('app one adopts the family row', A.getItem(contested.id).externalId === 'shared:eid');
T += 1000;
r = A.ingestPeerItems('inboxapptwo', [item({ e: 'shared:eid', t: 'Chokolade', q: '900 g' })], T);
ok('app two cannot reach it by the same externalId', A.getItem(contested.id).quantity === '100 g');
ok('...it gets its own separate line', r.added === 1);

// ---------- an adopted row that is unshared stays out of reach for good ----------
T += 1000;
const adoptPriv = A.addItem({ title: 'Cigaretter', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:cig', t: 'Cigaretter', q: '1 pk' })], T);
A.updateItem(adoptPriv.id, { visibility: 'private' });
A.state.syncTomb.shared = {};                      // simulate the 90-day prune
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:cig', t: 'Cigaretter', q: '10 pk' })], T);
ok('a private row is unreachable even after its tombstone is pruned',
  A.getItem(adoptPriv.id).quantity === '1 pk' && A.getItem(adoptPriv.id).visibility === 'private');

// ---------- short names still match instead of duplicating ----------
T += 1000;
const eggs = A.addItem({ title: 'Æg', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:aeg', t: 'Æg', q: '12 stk' })], T);
ok('a two-letter name merges rather than duplicating',
  A.state.items.filter(i => i.title === 'Æg').length === 1 && A.getItem(eggs.id).quantity === '12 stk');

// ---------- a pruned adoption record must not flap between phones ----------
const F = await import(new URL('../js/store.js?dev6', import.meta.url)); F.state.profile = 'anna';
T += 1000;
F.applySync('shared', { v: 1, at: T, items: {}, deleted: {},
  inboxAdopt: { 'familymix:fm:ghost': 'i9_long_gone' } });
ok('an adoption record for a vanished item is not taken on',
  !F.peerAdoptMap()['familymix:fm:ghost']);
T += 1000;
const ch2 = F.applySync('shared', { v: 1, at: T, items: {}, deleted: {},
  inboxAdopt: { 'familymix:fm:ghost': 'i9_long_gone' } });
ok('...so re-receiving it does not mark state changed', ch2 === false);

// ---------- a MINTED row that is unshared is beyond the peer too ----------
// (the adopted-row case is covered above; this is the sibling lookup)
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:wine', t: 'Vin', q: '2 fl' })], T);
const wine = A.state.items.find(i => i.externalId === 'fm:wine');
ok('the peer minted its own row', wine.id.startsWith('px_') && wine.visibility === 'shared');
A.updateItem(wine.id, { visibility: 'private' });
A.state.syncTomb.shared = {};                       // simulate the 90-day prune
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:wine', t: 'Vin på flaske', q: '99 fl', quantityGrams: 9999, neededOn: '2026-12-24' })], T);
const wineAfter = A.getItem(wine.id);
ok('a re-push cannot rewrite an unshared minted row',
  wineAfter.title === 'Vin' && wineAfter.quantity === '2 fl' && wineAfter.quantityGrams === null && wineAfter.due === null);
ok('...it is refused, not turned into a second row', r.skipped === 1 && r.added === 0);
ok('...and it stays private', wineAfter.visibility === 'private');

// ---------- a phone with no adoption record still re-binds, not duplicates ----------
T += 1000;
const bound = A.addItem({ title: 'Yoghurt', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:yog', t: 'Yoghurt', q: '500 g' })], T);
ok('the line merged onto the family row', A.getItem(bound.id).externalId === 'fm:yog');
ok('...and the owning app is stamped on the row itself', A.getItem(bound.id).externalPeer === 'familymix');
delete A.state.peerAdopt['familymix:fm:yog'];       // the map is device-local and pruned
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:yog', t: 'Yoghurt', q: '750 g' })], T);
ok('losing the adoption record does NOT mint a duplicate',
  A.state.items.filter(i => i.title === 'Yoghurt').length === 1);
ok('...it re-binds to the same row', A.getItem(bound.id).quantity === '750 g');

// ---------- but another app still cannot ride that externalId ----------
T += 1000;
r = A.ingestPeerItems('inboxotherapp', [item({ e: 'fm:yog', t: 'Yoghurt', q: '5 kg' })], T);
ok('a different app is not let onto the claimed row', A.getItem(bound.id).quantity === '750 g');
ok('...it gets its own line', r.added === 1);

// ---------- C1 and bidi controls never reach the shopping row ----------
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:spoof', t: 'Melk‮gnirts​', q: 'xy' })], T);
const spoof = A.state.items.find(i => i.externalId === 'fm:spoof');
ok('C1 controls are stripped', !/[-]/.test(spoof.title + spoof.quantity));
ok('bidi overrides are stripped', !/[‪-‮⁦-⁩]/.test(spoof.title));
ok('zero-width characters are stripped', !/[​-‏﻿]/.test(spoof.title));

// ---------- the adoption map stays bounded ----------
T += 1000;
const stale = A.addItem({ title: 'Kanel', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:kanel', t: 'Kanel', q: '50 g' })], T);
ok('an adoption is recorded', A.peerAdoptMap()['familymix:fm:kanel'] === stale.id);
A.updateItem(stale.id, { externalId: null });        // the family clears it
A.pruneSyncMaps();
ok('a stale adoption record is pruned', !A.peerAdoptMap()['familymix:fm:kanel']);
ok('...while a live one is kept', A.peerAdoptMap()['familymix:fm:yog'] === bound.id);

// ---------- unsharing a peer row must not destroy it ----------
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:kit', t: 'Test kit' })], T);
const kit = A.state.items.find(i => i.externalId === 'fm:kit');
A.updateItem(kit.id, { visibility: 'private', notes: 'clinic Tuesday' });
const kitP = A.getItem(kit.id);
ok('the person who unshared it can still see it', A.visibleTo(kitP, 'anna'));
ok('...the other person cannot', !A.visibleTo(kitP, 'ebbe'));
ok('...it is carried in HER private file, not orphaned',
  !!A.syncSnapshot('private', 'anna').items[kit.id]);
ok('...and it has left the shared file', !A.syncSnapshot('shared', 'anna').items[kit.id]);
ok('...the notes she added survive', A.getItem(kit.id).notes === 'clinic Tuesday');

// ---------- and the peer can never put it back ----------
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:kit', t: 'Test kit', q: '2 stk' })], T);
ok('a re-push is refused', r.skipped === 1 && A.getItem(kit.id).quantity == null);
A.state.syncTomb.shared = {};                        // 90 days pass
T += 1000;
r = A.ingestPeerItems('familymix', [item({ e: 'fm:kit', t: 'Test kit', q: '2 stk' })], T);
ok('still refused after the tombstone ages out', r.skipped === 1 && r.added === 0);
ok('...because the refusal is durable, not on the 90-day clock',
  !!A.peerRefusedMap()['familymix:fm:kit']);
ok('...and it rides the shared snapshot to the other phone',
  !!A.syncSnapshot('shared', 'anna').inboxRefused['familymix:fm:kit']);

// ---------- a stale copy must not undo an unshare ----------
const G = await import('/home/user/tracking/js/store.js?dev7'); G.state.profile = 'anna';
const H2 = await import('/home/user/tracking/js/store.js?dev8'); H2.state.profile = 'ebbe';
T += 1000;
const joint = G.addItem({ title: 'Vin', scope: 'house', type: 'supply', category: 'groceries' });
H2.applySync('shared', wire(G.syncSnapshot('shared', 'anna')));
ok('both phones have it', !!H2.getItem(joint.id));
T += 1000;
G.updateItem(joint.id, { visibility: 'private', notes: 'private note' });   // Anna unshares on G
T += 1000;
H2.updateItem(joint.id, { quantity: '3 fl' });                             // Ebbe edits before hearing
T += 1000;
G.applySync('shared', wire(H2.syncSnapshot('shared', 'ebbe')));
ok('a newer edit does NOT undo the unshare', G.getItem(joint.id).visibility === 'private');
ok('...and does not overwrite the private content', G.getItem(joint.id).notes === 'private note');
// but a genuine later re-share still wins
T += 1000;
H2.updateItem(joint.id, { visibility: 'shared' });
T += 1000;
G.applySync('shared', wire(H2.syncSnapshot('shared', 'ebbe')));
ok('a genuinely later re-share is still accepted', G.getItem(joint.id).visibility === 'shared');

// ---------- a peer may correct its own amount but not the family's ----------
T += 1000;
const hand2 = A.addItem({ title: 'Peber', scope: 'house', type: 'supply', category: 'groceries' });
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:peber', t: 'Peber', q: '50 g' })], T);
ok('the peer fills the blank amount', A.getItem(hand2.id).quantity === '50 g');
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:peber', t: 'Peber', q: '100 g' })], T);
ok('the peer can correct the value it put there', A.getItem(hand2.id).quantity === '100 g');
A.updateItem(hand2.id, { quantity: '2 poser' });      // the family types their own
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:peber', t: 'Peber', q: '100 g' })], T);
ok("a standing re-send does not revert the family's own amount",
  A.getItem(hand2.id).quantity === '2 poser');
T += 1000;
A.ingestPeerItems('familymix', [item({ e: 'fm:peber', t: 'Peber', q: '250 g' })], T);
ok('...and neither does a fresh correction', A.getItem(hand2.id).quantity === '2 poser');

// ---------- a future watermark must not park our own ----------
const I2 = await import('/home/user/tracking/js/store.js?dev9'); I2.state.profile = 'anna';
const ackBefore = I2.peerAckMap()['familymix'] || 0;
T += 1000;
I2.applySync('shared', { v: 1, at: T, items: {}, deleted: {}, inboxAck: { familymix: 4102444800000 } });
ok('a future watermark is ignored, not clamped to now',
  (I2.peerAckMap()['familymix'] || 0) === ackBefore);
T += 1000;
r = I2.ingestPeerItems('familymix', [item({ e: 'fm:live', t: 'Stadig muligt' })], T);
ok('...so a live batch still lands', r.added === 1);
T += 1000;
I2.applySync('shared', { v: 1, at: T, items: {}, deleted: {}, inboxAck: { familymix: 4102444800000 } });
T += 1000;
r = I2.ingestPeerItems('familymix', [item({ e: 'fm:live2', t: 'Og igen' })], T);
ok('...and again on the next merge (no moving-target re-park)', r.added === 1);

// ---------- an import must not clone this phone's sync slot ----------
const J2 = await import('/home/user/tracking/js/store.js?dev10'); J2.state.profile = 'anna';
J2.syncConfig().deviceId = 'dORIGINAL';
J2.saveState();
const dump = J2.exportJSON();
const K2 = await import('/home/user/tracking/js/store.js?dev11');
K2.importJSON(dump);
ok('an imported copy does not inherit the sync slot', !K2.syncConfig().deviceId);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
