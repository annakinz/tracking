// A phone sitting on v66 force-updates to v68: its stored state must load,
// render and sync without any of the new maps existing.
let ls = new Map();
globalThis.localStorage = { getItem: k => ls.has(k) ? ls.get(k) : null, setItem: (k,v) => ls.set(k,String(v)), removeItem: k => ls.delete(k) };
globalThis.document = { dispatchEvent(){} };
let pass=0, fail=0; const ok=(n,c)=>{c?(pass++,console.log('✓',n)):(fail++,console.log('✗',n));};

// hand-built v66-shaped blob: no quantity, no externalId, no peerAck/peerAdopt,
// one item with a junk due date that v66 tolerated
const old = {
  profile: 'anna',
  family: [{id:'anna',name:'Anna',user:true},{id:'ebbe',name:'Ebbe',user:true},{id:'house',name:'House'}],
  items: [
    { id:'i1_a', title:'Mælk', raw:'mælk', type:'supply', scope:'house', category:'groceries',
      visibility:'shared', status:'active', createdBy:'anna', createdAt:1, updatedAt:2, dims:{}, due:null },
    { id:'i2_b', title:'Ring til tandlægen', raw:'x', type:'task', scope:'anna', category:'errands',
      visibility:'private', status:'active', createdBy:'anna', createdAt:1, updatedAt:2, dims:{}, due:'2026-13-45' },
  ],
  news: [], newsSeen: {}, syncTomb: { shared:{}, private:{} },
  sync: { gasUrl:'x', code:'ABCD' },
};
ls.set('stratos.v1', JSON.stringify(old));

const S = await import(new URL('../js/store.js', import.meta.url));
ok('old state loads', S.state.items.length === 2);
ok('items survive intact', S.state.items.find(i=>i.title==='Mælk').visibility === 'shared');
ok('a junk due date no longer blows up date maths', S.effDueMs(S.getItem('i2_b')) === null);
ok('the new peer maps start empty, not undefined', JSON.stringify(S.peerAckMap())==='{}' && JSON.stringify(S.peerAdoptMap())==='{}');

const snap = S.syncSnapshot('shared','anna');
ok('a snapshot still builds', Object.keys(snap.items).length === 1);
ok('...and carries the new maps', snap.inboxAck && snap.inboxAdopt);
ok('private items still stay out of the shared file', !snap.items['i2_b']);

// a peer batch lands on top of legacy state
const r = S.ingestPeerItems('inboxfamilymix', [
  { externalId:'fm:1', text:'Mælk', quantity:'2 l', category:'groceries', type:'supply', scope:'house' },
], Date.now());
ok('a peer batch merges into the legacy hand-added row', r.updated === 1 && S.getItem('i1_a').quantity === '2 l');
ok('...without duplicating it', S.state.items.filter(i=>i.title==='Mælk').length === 1);
ok('...and cannot see the private item', S.getItem('i2_b').quantity == null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
