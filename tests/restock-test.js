let T = 1_700_000_000_000;
let ls = new Map();
globalThis.localStorage = { getItem:k=>ls.has(k)?ls.get(k):null, setItem:(k,v)=>ls.set(k,String(v)), removeItem:k=>ls.delete(k) };
globalThis.document = { dispatchEvent(){} };
globalThis.Date.now = () => T;
let pass=0,fail=0; const ok=(n,c)=>{c?(pass++,console.log('✓',n)):(fail++,console.log('✗',n));};

// build a state that already has the bad rows, as her phone does
const S0 = await import(new URL('../js/store.js', import.meta.url));
S0.state.profile='anna';
const a = S0.addItem({title:'Havregryn',type:'supply',scope:'house',category:'groceries'});
const b = S0.addItem({title:'Kaffe',type:'supply',scope:'house',category:'groceries'});
const c = S0.addItem({title:'Ring til tandlaegen',type:'task',scope:'anna',category:'errands'});
S0.buyItem(a.id,true); S0.buyItem(b.id,true);
// force the contradictory state the old addItem produced
S0.state.items.find(i=>i.id===a.id).status='active';
S0.state.items.find(i=>i.id===b.id).status='active';
S0.setMagnitude(b.id,'restock',S0.state.dims.restock.strata[5].id,0.5);   // family said "Almost out"
delete S0.state.fixStockedOnList;
S0.saveState();

// reload as a fresh app start
const S = await import(new URL('../js/store.js?reload', import.meta.url));
const lbl=(id)=>{const i=S.getItem(id);const r=S.uOf(i,'restock');return r==null?'unsized':S.state.dims.restock.strata[Math.floor(r)].label;};
ok('a listed item reading "Stocked" is repaired to "Getting low"', lbl(a.id)==='Getting low');
ok('a reading the family set deliberately is left alone', lbl(b.id)==='Almost out');
ok('non-supplies are untouched', S.uOf(S.getItem(c.id),'restock')===null);
ok('the repair marks itself done so it never runs twice', S.state.fixStockedOnList===true);
console.log(`\n${pass} passed, ${fail} failed`); if(fail) process.exit(1);

// and the forward fix: re-adding a bought supply never comes back "Stocked"
const it = S.addItem({ title: 'Smør', type: 'supply', scope: 'house', category: 'groceries' });
T += 86400e3;
S.buyItem(it.id, true);
ok('buying snaps the dial to Stocked', lbl(it.id) === 'Stocked');
T += 20 * 86400e3;
S.addItem({ title: 'Smør', type: 'supply', scope: 'house', category: 'groceries' });
ok('re-adding it to the list resets the dial', lbl(it.id) === 'Getting low');
ok('...and it really is back on the list', S.getItem(it.id).status === 'active');
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exit(1);
