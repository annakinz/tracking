// List / dump / house / settings / detail-sheet rendering.

import {
  state, save, addItem, getItem, updateItem, deleteItem, markDone,
  uOf, effectivePriority, gravityBoost, effDueISO, memberName, visibleTo,
  inboxItems, exportJSON, importJSON, resetAll, DIM_ORDER,
} from './store.js';
import { parseDump, classifyOne } from './classify.js';
import { agentClassify, getKey, setKey } from './agent.js';
import { openSizer } from './bubbles.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let personFilterVal = 'all';

// Surfacing: the app visibly changes its patterns when something needs your
// eyes — never a notification, never a buried section. Two triggers:
// deadline gravity, and high-dread items that have sat for a week+
// (dread is the signal for *why* something isn't getting done).
export function surfacedOf(items) {
  return items
    .filter(i => i.status === 'active')
    .map(i => {
      const boost = gravityBoost(i);
      const dread = uOf(i, 'dread');
      const ageDays = Math.floor((Date.now() - i.createdAt) / 86400e3);
      if (boost > 0) {
        const why = i.due
          ? (boost >= 1.5 ? '🔥 due ' : '⏰ due ') + i.due
          : '🔁 every ~' + i.loop.every + 'd — probably needed';
        return { i, why, w: 10 + boost };
      }
      if (dread !== null && dread >= 4 && ageDays >= 7)
        return { i, why: '🌀 high dread · sitting ' + ageDays + ' days', w: dread + ageDays / 30 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.w - a.w);
}

export function allSurfaced() {
  return surfacedOf(state.items.filter(i => visibleTo(i, state.profile)));
}

// Compact surface strip for the Dump tab — the landing screen greets you
// with what the app wants seen before you even navigate anywhere.
export function renderDumpSurface() {
  const box = $('#dumpSurface');
  if (!box) return;
  box.innerHTML = '';
  const surf = allSurfaced().slice(0, 4);
  if (!surf.length) return;
  const strip = document.createElement('div');
  strip.className = 'surface-strip';
  strip.innerHTML = '<div class="ss-head">👁 surfacing now</div>';
  for (const s of surf) {
    const b = document.createElement('button');
    b.className = 'ss-item';
    b.innerHTML = '<span class="ss-title">' + esc(s.i.title) + '</span>' +
      '<span class="minichip why">' + s.why + '</span>';
    b.onclick = () => openSheet(s.i.id);
    strip.appendChild(b);
  }
  box.appendChild(strip);
}

export function changed() {
  document.dispatchEvent(new CustomEvent('stratos:changed'));
}

// ---------- DUMP ----------

export function initDump() {
  const btn = $('#dumpBtn');
  btn.addEventListener('click', async () => {
    const text = $('#dumpText').value;
    if (!text.trim()) return;
    btn.disabled = true;
    btn.textContent = getKey() ? 'Filing…' : 'Dump it';
    let classified = await agentClassify(text);
    const viaAgent = !!classified;
    if (!classified) classified = parseDump(text).map(classifyOne);
    btn.disabled = false;
    btn.textContent = 'Dump it';
    if (!classified.length) return;
    const made = classified.map(addItem);
    $('#dumpText').value = '';
    renderDumpResults(made, viaAgent);
    changed();
  });
}

function renderDumpResults(items, viaAgent) {
  const box = $('#dumpResults');
  const via = viaAgent ? '✨ filed by Gemini'
    : getKey() ? 'filed by built-in rules (Gemini unreachable)'
    : 'filed by built-in rules — add a Gemini key in ⚙︎ Settings for smarter filing';
  box.innerHTML = '<div class="hint" style="margin-top:14px">Filed ' + items.length +
    (items.length === 1 ? ' item' : ' items') + ' <span style="opacity:.7">(' + via + ')</span>' +
    ' — tap to correct me. Then head to <b>Size</b> 🫧</div>';
  for (const it of items) box.appendChild(itemCard(it));
}

function itemCard(it) {
  const el = document.createElement('button');
  el.className = 'filed-card';
  el.innerHTML =
    '<div class="fc-title">' + esc(it.title) + '</div>' +
    '<div class="fc-chips">' +
      chip(typeIcon(it.type) + ' ' + it.type) +
      chip('👤 ' + esc(memberName(it.scope))) +
      chip('🏷 ' + esc(it.category)) +
      (it.due ? chip('📅 ' + it.due) : '') +
      (it.source ? chip('🏪 ' + esc(it.source)) : '') +
      (it.loop?.every ? chip('🔁 ~' + it.loop.every + 'd loop') : '') +
      chip(it.visibility === 'private' ? '🔒 private' : '👥 shared') +
    '</div>';
  el.onclick = () => openSheet(it.id);
  return el;
}

const chip = (t) => '<span class="minichip">' + t + '</span>';
const typeIcon = (t) => ({ task: '☑️', issue: '🌀', supply: '🧺', goal: '🎯' }[t] || '•');

// ---------- LISTS ----------

export function renderLists() {
  const bar = $('#personFilter');
  bar.innerHTML = '';
  const opts = [{ id: 'all', name: 'All' }, ...state.family];
  for (const o of opts) {
    const b = document.createElement('button');
    b.className = 'chip' + (personFilterVal === o.id ? ' on' : '');
    b.textContent = o.name;
    b.onclick = () => { personFilterVal = o.id; renderLists(); };
    bar.appendChild(b);
  }

  const sort = $('#sortSel').value;
  const vis = $('#visSel').value;
  const showDone = $('#showDone').checked;

  let items = state.items.filter(i => visibleTo(i, state.profile));
  if (personFilterVal !== 'all') items = items.filter(i => i.scope === personFilterVal);
  if (vis === 'shared') items = items.filter(i => i.visibility === 'shared');
  if (vis === 'private') items = items.filter(i => i.visibility === 'private' && i.createdBy === state.profile);

  const active = items.filter(i => i.status !== 'done');
  const done = items.filter(i => i.status === 'done');

  active.sort(sorter(sort));

  const body = $('#listBody');
  body.innerHTML = '';

  if (!active.length && !done.length) {
    body.innerHTML = '<div class="empty"><div class="empty-art">☁️</div><p>Nothing here yet. Dump something!</p></div>';
    return;
  }

  const inbox = active.filter(i => i.status === 'inbox');
  if (inbox.length) {
    const btn = document.createElement('button');
    btn.className = 'primary wide';
    btn.textContent = '🫧 Size ' + inbox.length + ' new item' + (inbox.length > 1 ? 's' : '');
    btn.onclick = () => { window.stratosGoto('size'); };
    body.appendChild(btn);
  }

  const surfaced = surfacedOf(active).slice(0, 5);

  if (surfaced.length) {
    const h = document.createElement('div');
    h.className = 'group-head surfaced-head';
    h.textContent = '👁 surfacing now';
    body.appendChild(h);
    for (const s of surfaced) {
      const row = itemRow(s.i, sort, { noDue: true });
      const why = document.createElement('span');
      why.className = 'minichip why';
      why.textContent = s.why;
      row.querySelector('.row-chips').prepend(why);
      body.appendChild(row);
    }
  }

  // group by category
  const groups = {};
  for (const i of active) (groups[i.category] || (groups[i.category] = [])).push(i);
  for (const [cat, arr] of Object.entries(groups)) {
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = cat;
    body.appendChild(h);
    for (const i of arr) body.appendChild(itemRow(i, sort));
  }

  if (showDone && done.length) {
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = 'done';
    body.appendChild(h);
    done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    for (const i of done) body.appendChild(itemRow(i, sort));
  }
}

function sorter(sort) {
  if (sort === 'new') return (a, b) => b.createdAt - a.createdAt;
  if (sort === 'due') return (a, b) => (effDueISO(a) || '9999') < (effDueISO(b) || '9999') ? -1 : 1;
  if (sort === 'priority') return (a, b) => effectivePriority(b) - effectivePriority(a);
  return (a, b) => (uOf(b, sort) ?? -1) - (uOf(a, sort) ?? -1);
}

function itemRow(i, sort, opts = {}) {
  const el = document.createElement('button');
  el.className = 'row' + (i.status === 'done' ? ' done' : '');
  const dimForDot = ['priority', 'effort', 'difficulty', 'dread', 'restock'].includes(sort) ? sort : 'priority';
  const u = dimForDot === 'priority' ? effectivePriority(i) : (uOf(i, dimForDot) ?? null);
  const n = state.dims[dimForDot].strata.length;
  const dot = u === null ? 10 : 10 + (u / n) * 26;
  const boost = gravityBoost(i);
  el.innerHTML =
    '<span class="dot" style="width:' + dot + 'px;height:' + dot + 'px"></span>' +
    '<span class="row-main"><span class="row-title">' + esc(i.title) + '</span>' +
    '<span class="row-chips">' +
      (i.scope !== state.profile ? chip(esc(memberName(i.scope))) : '') +
      (i.due && !opts.noDue ? chip((boost >= 1.5 ? '🔥 ' : boost > 0 ? '⏰ ' : '📅 ') + i.due) : '') +
      (i.source ? chip('🏪 ' + esc(i.source)) : '') +
      (i.loop?.every && !opts.noDue ? chip('🔁 ~' + i.loop.every + 'd') : '') +
      (i.visibility === 'private' ? chip('🔒') : '') +
      (i.status === 'inbox' ? chip('unsized') : '') +
    '</span></span>' +
    '<span class="row-check" data-check>' + (i.status === 'done' ? '↩︎' : '✓') + '</span>';
  el.onclick = (e) => {
    if (e.target.closest('[data-check]')) {
      markDone(i.id, i.status !== 'done');
      changed();
    } else {
      openSheet(i.id);
    }
  };
  return el;
}

// ---------- HOUSE ----------

export function initHouse() {
  const add = () => {
    const v = $('#houseAdd').value.trim();
    if (!v) return;
    for (const raw of parseDump(v)) {
      const c = classifyOne(raw);
      c.scope = 'house';
      if (c.type === 'task') c.category = c.category === 'general' ? 'house tasks' : c.category;
      addItem(c);
    }
    $('#houseAdd').value = '';
    changed();
  };
  $('#houseAddBtn').addEventListener('click', add);
  $('#houseAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
}

let houseSourceVal = 'all';

export function renderHouse() {
  const body = $('#houseBody');
  body.innerHTML = '';
  const items = state.items.filter(i => i.scope === 'house' && visibleTo(i, state.profile));
  let active = items.filter(i => i.status !== 'done');
  const done = items.filter(i => i.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

  // store-run mode: standing in Netto, filter to the Netto loop
  const sources = [...new Set(active.map(i => i.source).filter(Boolean))].sort();
  if (sources.length) {
    const bar = document.createElement('div');
    bar.className = 'filterbar';
    for (const s of ['all', ...sources]) {
      const b = document.createElement('button');
      b.className = 'chip' + (houseSourceVal === s ? ' on' : '');
      b.textContent = s === 'all' ? 'Everywhere' : '🏪 ' + s;
      b.onclick = () => { houseSourceVal = s; renderHouse(); };
      bar.appendChild(b);
    }
    body.appendChild(bar);
  } else {
    houseSourceVal = 'all';
  }
  if (houseSourceVal !== 'all') active = active.filter(i => i.source === houseSourceVal);

  const groups = { groceries: [], supplies: [], other: [] };
  for (const i of active) (groups[i.category] || groups.other).push(i);

  for (const [name, arr] of Object.entries(groups)) {
    if (!arr.length) continue;
    arr.sort((a, b) => (uOf(b, 'restock') ?? effectivePriority(b)) - (uOf(a, 'restock') ?? effectivePriority(a)));
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = name === 'other' ? 'house tasks & more' : name;
    body.appendChild(h);
    for (const i of arr) body.appendChild(itemRow(i, i.type === 'supply' ? 'restock' : 'priority'));
  }

  if (done.length) {
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = 'recently done — tap ↺ to re-add';
    body.appendChild(h);
    for (const i of done.slice(0, 15)) {
      const el = document.createElement('button');
      el.className = 'row done';
      el.innerHTML = '<span class="row-main"><span class="row-title">' + esc(i.title) + '</span></span>' +
        '<span class="row-check">↺</span>';
      el.onclick = () => {
        const c = { ...classifyOne(i.raw || i.title), scope: 'house', category: i.category, type: i.type };
        addItem(c);
        changed();
      };
      body.appendChild(el);
    }
  }
  if (!active.length && !done.length) {
    body.innerHTML = '<div class="empty"><div class="empty-art">🏠</div><p>Add groceries, supplies, house tasks…</p></div>';
  }
}

// ---------- DETAIL SHEET ----------

export function openSheet(id) {
  const i = getItem(id);
  if (!i) return;
  const wrap = $('#sheetWrap');
  const sheet = $('#sheet');
  wrap.hidden = false;

  const famOpts = state.family.map(f =>
    '<option value="' + f.id + '"' + (f.id === i.scope ? ' selected' : '') + '>' + esc(f.name) + '</option>').join('');
  const typeOpts = ['task', 'issue', 'supply', 'goal'].map(t =>
    '<option value="' + t + '"' + (t === i.type ? ' selected' : '') + '>' + t + '</option>').join('');
  const cats = [...new Set(state.items.map(x => x.category))];

  const dimRows = DIM_ORDER.map(d => {
    const m = i.dims?.[d];
    const label = m ? (() => {
      const idx = state.dims[d].strata.findIndex(s => s.id === m.s);
      return idx >= 0 ? (idx + 1) + ' · ' + esc(state.dims[d].strata[idx].label) : '—';
    })() : '—';
    return '<button class="dimrow" data-resize="' + d + '"><span>' + esc(state.dims[d].label) +
      '</span><b>' + label + '</b><span class="hint">resize ›</span></button>';
  }).join('');

  sheet.innerHTML =
    '<div class="sheet-grab"></div>' +
    '<input id="shTitle" value="' + esc(i.title) + '">' +
    '<div class="sheet-grid">' +
      '<label>Type <select id="shType">' + typeOpts + '</select></label>' +
      '<label>Who <select id="shScope">' + famOpts + '</select></label>' +
      '<label>Category <input id="shCat" list="catList" value="' + esc(i.category) + '">' +
        '<datalist id="catList">' + cats.map(c => '<option value="' + esc(c) + '">').join('') + '</datalist></label>' +
      '<label>Due <input type="date" id="shDue" value="' + (i.due || '') + '"></label>' +
      '<label>Source <input id="shSource" list="srcList" placeholder="Netto, Wolt…" value="' + esc(i.source || '') + '">' +
        '<datalist id="srcList">' + [...new Set(state.items.map(x => x.source).filter(Boolean))]
          .map(s => '<option value="' + esc(s) + '">').join('') + '</datalist></label>' +
      '<label>Loop: every <input type="number" id="shLoop" min="1" step="1" placeholder="—" value="' +
        (i.loop?.every ?? '') + '"> days' +
        (i.loop?.auto && i.loop?.every ? ' <span class="hint">(learned)</span>' : '') + '</label>' +
    '</div>' +
    '<button id="shVis" class="chip big-chip">' + (i.visibility === 'private' ? '🔒 Private (only me)' : '👥 Shared with Ebbe & me') + '</button>' +
    '<div class="dimrows">' + dimRows + '</div>' +
    '<div class="sheet-actions">' +
      '<button id="shDone" class="primary">' + (i.status === 'done' ? '↩︎ Not done' : '✓ Done') + '</button>' +
      '<button id="shDelete" class="danger">Delete</button>' +
    '</div>';

  let visibility = i.visibility;
  $('#shVis').onclick = () => {
    visibility = visibility === 'private' ? 'shared' : 'private';
    $('#shVis').textContent = visibility === 'private' ? '🔒 Private (only me)' : '👥 Shared with Ebbe & me';
  };

  const commit = () => {
    const lv = parseFloat($('#shLoop').value);
    const loop = lv > 0
      ? (lv === i.loop?.every ? i.loop : { every: Math.round(lv), auto: false, history: i.loop?.history || [] })
      : null;
    updateItem(id, {
      title: $('#shTitle').value.trim() || i.title,
      type: $('#shType').value,
      scope: $('#shScope').value,
      category: $('#shCat').value.trim() || i.category,
      due: $('#shDue').value || null,
      source: $('#shSource').value.trim() || null,
      visibility,
      loop,
    });
    changed();
  };

  const close = () => { commit(); wrap.hidden = true; };
  $('#sheetShade').onclick = close;

  sheet.querySelectorAll('[data-resize]').forEach(b => {
    b.onclick = () => {
      commit();
      wrap.hidden = true;
      window.stratosGoto('size');
      openSizer([getItem(id)], () => window.stratosGoto('lists'), b.dataset.resize);
    };
  });
  $('#shDone').onclick = () => { commit(); markDone(id, i.status !== 'done'); wrap.hidden = true; changed(); };
  $('#shDelete').onclick = () => {
    if (confirm('Delete "' + i.title + '"?')) { deleteItem(id); wrap.hidden = true; changed(); }
  };
}

// ---------- SETTINGS ----------

export function renderSettings() {
  const body = $('#settingsBody');
  const famRows = state.family.filter(f => f.id !== 'house').map(f =>
    '<label class="famrow">' + (f.user ? '👤' : '🧒') +
    ' <input data-fam="' + f.id + '" value="' + esc(f.name) + '"></label>').join('');

  body.innerHTML =
    '<div class="group-head">this device</div>' +
    '<div class="setrow">Profile: <b>' + esc(memberName(state.profile)) + '</b> ' +
    '<button id="setSwitch" class="chip">switch</button></div>' +
    '<div class="group-head">family</div>' + famRows +
    '<div class="group-head">agent</div>' +
    '<label class="famrow">🔑 <input id="setGemini" type="password" placeholder="Gemini API key (free at aistudio.google.com/apikey)" value="' + esc(getKey()) + '"></label>' +
    '<p class="hint">With a key, dumps are filed by Gemini (free tier, called straight from this device — the key never leaves it and is not included in exports). Without one, built-in rules do the filing. Your corrections teach both.</p>' +
    '<div class="group-head">data</div>' +
    '<div class="setrow"><button id="setExport" class="chip">Export JSON</button> ' +
    '<label class="chip">Import <input type="file" id="setImport" accept=".json" hidden></label> ' +
    '<button id="setReset" class="chip danger">Reset all</button></div>' +
    '<p class="hint">Data lives on this device for now (export/import to move it). Sync between phones is the next milestone — see DESIGN.md.</p>';

  body.querySelectorAll('[data-fam]').forEach(inp => {
    inp.onchange = () => {
      const f = state.family.find(x => x.id === inp.dataset.fam);
      if (f && inp.value.trim()) { f.name = inp.value.trim(); save(); changed(); }
    };
  });
  $('#setGemini').onchange = (e) => { setKey(e.target.value); };
  $('#setSwitch').onclick = () => {
    state.profile = state.profile === 'anna' ? 'ebbe' : 'anna';
    save(); changed(); renderSettings();
  };
  $('#setExport').onclick = () => {
    const blob = new Blob([exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'stratos-export.json';
    a.click();
  };
  $('#setImport').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { importJSON(await f.text()); changed(); renderSettings(); alert('Imported!'); }
    catch (err) { alert('Import failed: ' + err.message); }
  };
  $('#setReset').onclick = () => {
    if (confirm('Really erase everything on this device?')) { resetAll(); location.reload(); }
  };
}
