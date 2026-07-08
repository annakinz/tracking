// List / dump / house / settings / detail-sheet rendering.

import {
  state, save, uid, addItem, getItem, updateItem, deleteItem, markDone,
  uOf, effectivePriority, gravityBoost, effDueISO, memberName, visibleTo,
  inboxItems, childrenOf, exportJSON, importJSON, resetAll, DIM_ORDER,
} from './store.js';
import { parseDump, classifyOne } from './classify.js';
import { agentClassify, agentPhotoTasks, getKey, setKey } from './agent.js';
import { openSizer } from './bubbles.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let personFilterVal = 'all';
let wellbeingOpen = false;
// the filed-results cards on the Dump screen are a live view of the last
// dump; kept here so edits (which mutate the items in place) can re-render
// them instead of leaving a stale snapshot.
let lastFiled = [];
let lastFiledViaAgent = false;

// The Sorbet law: every category owns a tint. Whole card washed in the
// pale tone, saturated dot, deep tone for its heading. Known categories
// get fixed homes; new ones hash into the palette deterministically so a
// category keeps its color forever.
const SWATCHES = [
  { bg: '#FFD3C8', dot: '#FF7A59', deep: '#B33A1E' }, // coral
  { bg: '#BFEED6', dot: '#2FBF8F', deep: '#17714F' }, // mint
  { bg: '#DDD0F7', dot: '#8B6FE8', deep: '#5B3FC4' }, // lilac
  { bg: '#FFEBA1', dot: '#F0B000', deep: '#8F6A00' }, // lemon
  { bg: '#C2E3FA', dot: '#3E9EE3', deep: '#1C6AA6' }, // sky
  { bg: '#F9CCE3', dot: '#E9629F', deep: '#A83067' }, // rose
  { bg: '#DFE9B4', dot: '#97A93B', deep: '#5D6B1C' }, // sage
  { bg: '#FFDCA8', dot: '#FF9E3D', deep: '#A85E10' }, // peach
];
const CAT_HOMES = {
  health: 0, groceries: 1, supplies: 1, school: 2, wellbeing: 5,
  planning: 3, finance: 4, home: 6, errands: 7, shopping: 7, laundry: 4, clutter: 6,
};
export function catSwatch(cat) {
  const c = (cat || 'general').toLowerCase();
  let idx = CAT_HOMES[c];
  if (idx === undefined) {
    let h = 0;
    for (let k = 0; k < c.length; k++) h = (h * 31 + c.charCodeAt(k)) >>> 0;
    idx = h % SWATCHES.length;
  }
  return SWATCHES[idx];
}

// Surfacing: the app visibly changes its patterns when something needs your
// eyes — never a notification, never a buried section. Two triggers:
// deadline gravity, and high-dread items that have sat for a week+
// (dread is the signal for *why* something isn't getting done).
export function surfacedOf(items) {
  return items
    // struggles (issues) never surface on the ember screen — the takeover
    // is a call to action, and a struggle isn't actionable the same way
    .filter(i => i.status === 'active' && i.type !== 'issue')
    .map(i => {
      const boost = gravityBoost(i);
      const dread = uOf(i, 'dread');
      const ageDays = Math.floor((Date.now() - i.createdAt) / 86400e3);
      if (boost > 0) {
        const why = i.due
          ? (boost >= 1.5 ? '⚑ due ' : '◷ due ') + i.due
          : '↺ every ~' + i.loop.every + 'd — probably needed';
        return { i, why, w: 10 + boost };
      }
      if (dread !== null && dread >= 4 && ageDays >= 7)
        return { i, why: '◐ high dread · sitting ' + ageDays + ' days', w: dread + ageDays / 30 };
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => b.w - a.w);
}

export function allSurfaced() {
  return surfacedOf(state.items.filter(i => visibleTo(i, state.profile)));
}

// The surfacing takeover: on open, if anything needs eyes, an entire
// screen of floating bubbles on a hot ember background loads BEFORE the
// rest of the app. Tap a bubble to act on it; tapping through to the app
// is the explicit, secondary path. Returns true if it took over.
export function renderTakeover() {
  const el = $('#takeover');
  const surf = allSurfaced().slice(0, 7);
  if (!surf.length || !state.profile) { el.hidden = true; return false; }
  const wrap = $('#takeoverBubbles');
  wrap.innerHTML = '';
  const maxW = Math.max(...surf.map(s => s.w));
  const slots = [[50, 32], [26, 58], [74, 60], [30, 14], [73, 17], [26, 84], [72, 86]];
  surf.forEach((s, idx) => {
    const b = document.createElement('button');
    b.className = 'tk-bubble';
    const size = 30 + 32 * (s.w / maxW);
    b.style.width = b.style.height = 'min(' + size + 'vw, ' + Math.round(size * 0.72) + 'vh)';
    b.style.left = slots[idx][0] + '%';
    b.style.top = slots[idx][1] + '%';
    b.style.zIndex = 10 + Math.round(60 - size);
    b.style.animationDuration = (7 + (idx % 3) * 2.1) + 's';
    b.style.animationDelay = (-idx * 1.4) + 's';
    b.innerHTML = '<span class="tk-title"></span><span class="tk-why"></span>';
    b.querySelector('.tk-title').textContent = s.i.title;
    b.querySelector('.tk-why').textContent = s.why;
    b.onclick = () => { el.hidden = true; openItem(s.i.id); };
    wrap.appendChild(b);
  });
  $('#takeoverDismiss').onclick = () => { el.hidden = true; };
  el.hidden = false;
  return true;
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

  // Photo dump: photograph the mess; Gemini names the job and breaks it
  // into the concrete steps it can actually see. Any dump text goes along
  // as context. Without a key (or on failure) the photo still becomes a task.
  $('#photoDumpFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    e.target.value = '';
    const label = document.querySelector('.photodump');
    label.classList.add('busy');
    label.firstChild.textContent = '⊙ Looking at the photo… ';
    try {
      const dataUrl = await shrinkImage(f, 1200);
      const res = getKey() ? await agentPhotoTasks(dataUrl, $('#dumpText').value.trim()) : null;
      let parent;
      if (res) {
        parent = addItem({ title: res.title, type: 'task', scope: res.scope, category: res.category, notes: res.note });
        for (const s of res.steps) {
          addItem({ title: s, type: 'task', scope: parent.scope, category: parent.category, visibility: parent.visibility, parent: parent.id });
        }
        if (res.steps.length >= 2) parent.type = 'goal';
      } else {
        parent = addItem({ title: 'Sort out what’s in the photo', type: 'task', scope: 'house', category: 'home' });
      }
      (parent.media || (parent.media = [])).push({ id: uid(), dataUrl });
      save();
      $('#dumpText').value = '';
      renderDumpResults([parent], !!res);
      changed();
    } catch {
      alert("Couldn't read that image.");
    }
    label.classList.remove('busy');
    label.firstChild.textContent = '⊙ Photo dump — point me at the mess ';
  });
}

function renderDumpResults(items, viaAgent) {
  lastFiled = items;
  lastFiledViaAgent = viaAgent;
  const box = $('#dumpResults');
  const via = viaAgent ? '✦ filed by Gemini'
    : getKey() ? 'filed by built-in rules (Gemini unreachable)'
    : 'filed by built-in rules — add a Gemini key in ⚙︎ Settings for smarter filing';
  box.innerHTML = '<div class="hint" style="margin-top:14px">Filed ' + items.length +
    (items.length === 1 ? ' item' : ' items') + ' <span style="opacity:.7">(' + via + ')</span>' +
    ' — tap to correct me. Then head to <b>Size</b>.</div>';
  for (const it of items) box.appendChild(itemCard(it));
}

// Re-render the Dump screen's filed cards from current state, dropping any
// that were deleted. Called on every change so an edit made in the detail
// sheet is reflected immediately instead of leaving a stale card.
export function refreshDumpResults() {
  if (!lastFiled.length) return;
  const live = lastFiled.map(it => getItem(it.id)).filter(Boolean);
  if (!live.length) { $('#dumpResults').innerHTML = ''; lastFiled = []; return; }
  renderDumpResults(live, lastFiledViaAgent);
}

function itemCard(it) {
  const el = document.createElement('button');
  el.className = 'filed-card';
  const fsw = catSwatch(it.category);
  el.style.background = fsw.bg;
  el.style.boxShadow = '0 4px 0 ' + fsw.dot + '66';
  el.innerHTML =
    '<div class="fc-title">' + esc(it.title) + '</div>' +
    '<div class="fc-chips">' +
      chip(typeIcon(it.type) + ' ' + it.type) +
      chip(esc(memberName(it.scope))) +
      chip(esc(it.category)) +
      (it.due ? chip('due ' + it.due) : '') +
      (it.source ? chip('@ ' + esc(it.source)) : '') +
      (it.loop?.every ? chip('↺ ~' + it.loop.every + 'd loop') : '') +
      kidsChip(it) +
      chip(it.visibility === 'private' ? 'private' : 'shared') +
    '</div>';
  el.onclick = () => openItem(it.id);
  return el;
}

const chip = (t) => '<span class="minichip">' + t + '</span>';
const typeIcon = (t) => ({ task: '☐', issue: '◐', supply: '◇', goal: '◎' }[t] || '•');

function kidsChip(i) {
  const kids = childrenOf(i.id);
  if (!kids.length) return '';
  return chip('◔ ' + kids.filter(k => k.status === 'done').length + '/' + kids.length);
}

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

  const allActive = items.filter(i => i.status !== 'done');
  // subtasks live inside their parent's sheet, not as top-level rows —
  // but they can still surface on their own (due dates, dread)
  const topActive = allActive.filter(i => !i.parent);
  // struggles aren't tasks: they live behind the wellbeing chip, not
  // between "buy milk" and "fix the gate"
  const issues = topActive.filter(i => i.type === 'issue');
  const active = topActive.filter(i => i.type !== 'issue');
  const done = items.filter(i => i.status === 'done' && !i.parent && i.type !== 'issue');

  active.sort(sorter(sort));

  const body = $('#listBody');
  body.innerHTML = '';

  if (!active.length && !done.length) {
    body.innerHTML = '<div class="empty"><div class="empty-art">○</div><p>Nothing here yet. Dump something!</p></div>';
    return;
  }

  const inbox = allActive.filter(i => i.status === 'inbox');
  if (inbox.length) {
    const btn = document.createElement('button');
    btn.className = 'primary wide';
    btn.textContent = '◯ Size ' + inbox.length + ' new item' + (inbox.length > 1 ? 's' : '');
    btn.onclick = () => { window.stratosGoto('size'); };
    body.appendChild(btn);
  }

  if (issues.length) {
    const wb = document.createElement('button');
    wb.className = 'wb-chip' + (wellbeingOpen ? ' open' : '');
    wb.textContent = '☾ wellbeing · ' + issues.length;
    wb.onclick = () => { wellbeingOpen = !wellbeingOpen; renderLists(); };
    body.appendChild(wb);
    if (wellbeingOpen) {
      const panel = document.createElement('div');
      panel.className = 'wb-panel';
      panel.innerHTML = '<p class="hint">Not tasks — things being carried. Sized by how heavy they feel right now.</p>';
      issues.sort((a, b) => (uOf(b, 'difficulty') ?? -1) - (uOf(a, 'difficulty') ?? -1));
      for (const i of issues) panel.appendChild(itemRow(i, 'difficulty'));
      body.appendChild(panel);
    }
  }

  const surfaced = surfacedOf(allActive).slice(0, 5);

  if (surfaced.length) {
    const h = document.createElement('div');
    h.className = 'group-head surfaced-head';
    h.textContent = '✦ surfacing now';
    body.appendChild(h);
    for (const s of surfaced) {
      const row = itemRow(s.i, sort, { noDue: true });
      row.style.background = 'var(--ember-tint)';
      row.style.boxShadow = '0 4px 0 var(--ember-shadow)';
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
    h.style.color = catSwatch(cat).deep;
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
  const sw = catSwatch(i.category);
  el.style.background = sw.bg;
  el.style.boxShadow = '0 4px 0 ' + sw.dot + '66';
  const dimForDot = ['priority', 'effort', 'difficulty', 'dread', 'restock'].includes(sort) ? sort : 'priority';
  const u = dimForDot === 'priority' ? effectivePriority(i) : (uOf(i, dimForDot) ?? null);
  const n = state.dims[dimForDot].strata.length;
  const dot = u === null ? 10 : 10 + (u / n) * 26;
  const boost = gravityBoost(i);
  el.innerHTML =
    '<span class="dot" style="width:' + dot + 'px;height:' + dot + 'px;' +
      'background:radial-gradient(circle at 32% 30%, #ffffffb3, ' + sw.dot + ')"></span>' +
    '<span class="row-main"><span class="row-title">' + esc(i.title) + '</span>' +
    '<span class="row-chips">' +
      (i.scope !== state.profile ? chip(esc(memberName(i.scope))) : '') +
      (i.due && !opts.noDue ? chip((boost >= 1.5 ? '⚑ ' : boost > 0 ? '◷ ' : 'due ') + i.due) : '') +
      (i.source ? chip('@ ' + esc(i.source)) : '') +
      (i.loop?.every && !opts.noDue ? chip('↺ ~' + i.loop.every + 'd') : '') +
      (kidsChip(i)) +
      (i.notes || (i.media || []).length ? chip('✎') : '') +
      (i.visibility === 'private' ? chip('private') : '') +
      (i.status === 'inbox' ? chip('unsized') : '') +
    '</span></span>' +
    '<span class="row-check" data-check>' + (i.status === 'done' ? '↺' : '✓') + '</span>';
  el.onclick = (e) => {
    if (e.target.closest('[data-check]')) {
      markDone(i.id, i.status !== 'done');
      changed();
    } else {
      openItem(i.id);
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
      b.textContent = s === 'all' ? 'Everywhere' : '@ ' + s;
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
    body.innerHTML = '<div class="empty"><div class="empty-art">⌂</div><p>Add groceries, supplies, house tasks…</p></div>';
  }
}

// ---------- BUBBLE INTERIOR ----------
// An item with steps opens as a bubble you enter: the steps float inside
// as their own bubbles, sized by priority. Tap a step to dive in (steps can
// have steps); check them off in place; "details" opens the full sheet.

export function openItem(id) {
  if (childrenOf(id).length) openBubble(id);
  else openSheet(id);
}

export function openBubble(id) {
  const i = getItem(id);
  if (!i) return;
  const wrap = $('#bubbleWrap');
  wrap.hidden = false;
  $('#bubbleTitle').textContent = i.title;
  const box = $('#bubbleKids');
  box.innerHTML = '';
  const kids = childrenOf(id);
  const slots = [[50, 30], [28, 52], [72, 52], [36, 76], [67, 78], [50, 55], [25, 30], [75, 30], [50, 90]];
  const us = kids.map(k => effectivePriority(k));
  const maxU = Math.max(...us, 0.1);
  kids.slice(0, slots.length).forEach((k, idx) => {
    const b = document.createElement('button');
    b.className = 'kid-bubble' + (k.status === 'done' ? ' done' : '');
    const ksw = catSwatch(k.category);
    b.style.background = ksw.bg;
    b.style.boxShadow = '0 6px 0 ' + ksw.dot + '55';
    const size = 23 + 15 * (us[idx] / maxU);
    b.style.width = b.style.height = size + '%';
    b.style.left = slots[idx][0] + '%';
    b.style.top = slots[idx][1] + '%';
    b.style.animationDuration = (6 + (idx % 4) * 1.6) + 's';
    b.style.animationDelay = (-idx * 1.1) + 's';
    const check = document.createElement('span');
    check.className = 'kb-check';
    check.textContent = k.status === 'done' ? '✓' : '';
    check.onclick = (e) => {
      e.stopPropagation();
      markDone(k.id, k.status !== 'done');
      openBubble(id);
      changed();
    };
    const t = document.createElement('span');
    t.className = 'kb-title';
    t.textContent = k.title;
    b.append(check, t);
    b.onclick = () => { wrap.hidden = true; openItem(k.id); };
    box.appendChild(b);
  });
  $('#bubbleDetails').onclick = () => { wrap.hidden = true; openSheet(id); };
  $('#bubbleAddStep').onclick = () => {
    const t = prompt('New step inside “' + i.title + '”');
    if (t && t.trim()) {
      addItem({ title: t.trim(), type: 'task', scope: i.scope, category: i.category, visibility: i.visibility, parent: i.id });
      changed();
      openBubble(id);
    }
  };
  $('#bubbleClose').onclick = () => { wrap.hidden = true; };
  $('#bubbleShade').onclick = () => { wrap.hidden = true; };
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
    '<button id="shVis" class="chip big-chip">' + (i.visibility === 'private' ? 'Private — only me' : 'Shared with Ebbe & me') + '</button>' +
    (i.due ? '<a class="chip big-chip cal" target="_blank" rel="noopener" href="' + gcalUrl(i) + '">↗ Add to Google Calendar</a>' : '') +
    '<div class="group-head">notes</div>' +
    '<textarea id="shNotes" placeholder="Notes, links, anything — paste a URL and it becomes a chip below">' + esc(i.notes || '') + '</textarea>' +
    '<div id="shLinks" class="linkrow">' + linkChips(i.notes) + '</div>' +
    '<div class="group-head">photos</div>' +
    '<div class="mediagrid" id="shMedia"></div>' +
    '<label class="chip addphoto">⊙ Add photo<input type="file" id="shPhoto" accept="image/*" hidden></label>' +
    '<div class="group-head">steps</div>' +
    '<div id="shKids"></div>' +
    '<div class="quickadd subadd"><input id="shSubInput" placeholder="Break it into steps…">' +
    '<button id="shSubAdd" class="chip">Add</button></div>' +
    '<div class="dimrows">' + dimRows + '</div>' +
    '<div class="sheet-actions">' +
      '<button id="shDone" class="primary">' + (i.status === 'done' ? '↺ Not done' : '✓ Done') + '</button>' +
      '<button id="shDelete" class="danger">Delete</button>' +
    '</div>';

  // live link chips as you type/paste
  $('#shNotes').addEventListener('input', () => {
    $('#shLinks').innerHTML = linkChips($('#shNotes').value);
  });

  renderSheetMedia(i);
  renderSheetKids(i);

  $('#shPhoto').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const dataUrl = await shrinkImage(f);
      const item = getItem(id);
      (item.media || (item.media = [])).push({ id: uid(), dataUrl });
      save();
      renderSheetMedia(item);
      changed();
    } catch { alert("Couldn't read that image."); }
    e.target.value = '';
  };

  const addStep = () => {
    const t = $('#shSubInput').value.trim();
    if (!t) return;
    addItem({ title: t, type: 'task', scope: i.scope, category: i.category, visibility: i.visibility, parent: i.id });
    $('#shSubInput').value = '';
    // a task broken into real steps has become a goal (correct me in Type)
    if (getItem(id).type === 'task' && childrenOf(id).length >= 2) {
      getItem(id).type = 'goal';
      $('#shType').value = 'goal';
      save();
    }
    renderSheetKids(getItem(id));
    changed();
  };
  $('#shSubAdd').onclick = addStep;
  $('#shSubInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addStep(); });

  let visibility = i.visibility;
  $('#shVis').onclick = () => {
    visibility = visibility === 'private' ? 'shared' : 'private';
    $('#shVis').textContent = visibility === 'private' ? 'Private — only me' : 'Shared with Ebbe & me';
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
      notes: $('#shNotes').value,
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

// ---------- sheet helpers ----------

// One-tap prefilled Google Calendar event (all-day on the due date).
function gcalUrl(i) {
  const start = i.due.replace(/-/g, '');
  const end = new Date(new Date(i.due + 'T12:00:00').getTime() + 86400e3)
    .toISOString().slice(0, 10).replace(/-/g, '');
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: i.title,
    dates: start + '/' + end,
    details: ((i.notes || '') + '\n— from Stratos').trim(),
  });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

function linkChips(notes) {
  const urls = (notes || '').match(/https?:\/\/[^\s)>\]]+/g) || [];
  return [...new Set(urls)].map(u => {
    let host = u;
    try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    return '<a class="minichip link" href="' + esc(u) + '" target="_blank" rel="noopener">🔗 ' + esc(host) + '</a>';
  }).join('');
}

function shrinkImage(file, max = 1000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function renderSheetMedia(i) {
  const grid = $('#shMedia');
  grid.innerHTML = '';
  for (const m of (i.media || [])) {
    const img = document.createElement('img');
    img.src = m.dataUrl;
    img.onclick = () => {
      if (confirm('Remove this photo?')) {
        i.media = i.media.filter(x => x.id !== m.id);
        save();
        renderSheetMedia(i);
      }
    };
    grid.appendChild(img);
  }
}

function renderSheetKids(i) {
  const box = $('#shKids');
  box.innerHTML = '';
  for (const k of childrenOf(i.id)) {
    const row = document.createElement('div');
    row.className = 'kidrow' + (k.status === 'done' ? ' done' : '');
    const check = document.createElement('button');
    check.className = 'kid-check';
    check.textContent = k.status === 'done' ? '✓' : '';
    check.onclick = () => { markDone(k.id, k.status !== 'done'); renderSheetKids(i); changed(); };
    const title = document.createElement('button');
    title.className = 'kid-title';
    title.textContent = k.title;
    title.onclick = () => openItem(k.id); // dive in (steps can have steps)
    row.append(check, title);
    box.appendChild(row);
  }
}

// ---------- SETTINGS ----------

export function renderSettings() {
  const body = $('#settingsBody');
  const famRows = state.family.filter(f => f.id !== 'house').map(f =>
    '<label class="famrow">' + (f.user ? '•' : '◦') +
    ' <input data-fam="' + f.id + '" value="' + esc(f.name) + '"></label>').join('');

  body.innerHTML =
    '<div class="group-head">this device</div>' +
    '<div class="setrow">Profile: <b>' + esc(memberName(state.profile)) + '</b> ' +
    '<button id="setSwitch" class="chip">switch</button></div>' +
    '<div class="group-head">family</div>' + famRows +
    '<div class="group-head">agent</div>' +
    '<label class="famrow"><input id="setGemini" type="password" placeholder="Gemini API key (free at aistudio.google.com/apikey)" value="' + esc(getKey()) + '"></label>' +
    '<p class="hint">With a key, dumps are filed by Gemini (free tier, called straight from this device — the key never leaves it and is not included in exports). Without one, built-in rules do the filing. Your corrections teach both.</p>' +
    '<div class="group-head">household notes for the agent</div>' +
    '<textarea id="setNotes" placeholder="Facts the agent should know, e.g. “blue IKEA + rainbow bags = clean laundry to put away; bamboo baskets = dirty laundry”">' + esc(state.agentNotes || '') + '</textarea>' +
    '<p class="hint">Included in every Gemini prompt (text and photo dumps). Write how your home actually works — the agent treats it as ground truth.</p>' +
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
  $('#setNotes').onchange = (e) => { state.agentNotes = e.target.value.trim(); save(); };
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
