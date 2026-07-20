// Packing lists — a Keep-style checklist feature.
//
// Templates are the reusable core lists you brain-dump into once and edit as
// life changes; a Trip is a checklist instance spun off a template that you
// tick as you pack and can still add to. Past trips are kept, so you always
// have the old lists to reuse. Data + logic live in store.js; this file is the
// screen. Rendering is innerHTML + one set of delegated listeners on the
// persistent #view-pack container, so we can freely re-render on every change.

import {
  packTemplates, packTrips, getTemplate, getTrip,
  addTemplate, renameTemplate, deleteTemplate, addTemplateItems, editTemplateItem, removeTemplateItem,
  startTrip, renameTrip, toggleTripItem, addTripItems, editTripItem, removeTripItem,
  setTripDone, deleteTrip, saveTripItemToTemplate, reuseTrip,
  setPackListOrder, sortPackList, setPackItemGroup, packListGroups,
} from './store.js';
import { showToast, changed, catSwatch } from './views.js';
import { packGroupOf } from './classify.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// which screen the Pack tab is showing
let nav = { screen: 'home', id: null };
export function packGoto(screen, id) { nav = { screen, id: id || null }; renderPacking(); window.scrollTo(0, 0); }

const fmtDate = (ms) => { try { return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } };
const progress = (trip) => {
  const total = trip.items.length, done = trip.items.filter(i => i.checked).length;
  return { total, done, pct: total ? Math.round(done / total * 100) : 0 };
};
const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const ordOf = (i) => (i.ord != null ? i.ord : (i.c != null ? i.c : 0));
const byOrd = (arr) => arr.slice().sort((a, b) => (ordOf(a) - ordOf(b)) || ((a.c || 0) - (b.c || 0)));

// ---------- screens ----------
function homeHtml() {
  const trips = packTrips();
  const active = trips.filter(t => !t.done);
  const past = trips.filter(t => t.done);
  const tpls = packTemplates();

  let h = '<h1>Packing</h1>' +
    '<p class="hint">Reusable lists to pack from — brain-dump once, tick as you go. Edit them as the kids grow. Shared with your household, so you can pack a trip together.</p>';

  if (active.length) {
    h += '<div class="group-head">packing now</div><div class="pk-cards">';
    for (const t of active) {
      const p = progress(t);
      h += '<button class="pk-card trip" data-action="open-trip" data-id="' + t.id + '">' +
        '<div class="pk-card-top"><span class="pk-name">' + esc(t.name) + '</span>' +
        '<span class="pk-count">' + p.done + '/' + p.total + '</span></div>' +
        '<div class="pk-bar"><i style="width:' + p.pct + '%"></i></div></button>';
    }
    h += '</div>';
  }

  h += '<div class="group-head">your lists <button class="chip" data-action="new-template">＋ New list</button></div>';
  if (!tpls.length) {
    h += '<p class="hint">No lists yet. Make one (e.g. “Summer trip”, “Ski trip”) and brain-dump everything you usually bring.</p>';
  } else {
    h += '<div class="pk-cards">';
    for (const t of tpls) {
      h += '<div class="pk-card tpl">' +
        '<button class="pk-card-open" data-action="open-template" data-id="' + t.id + '">' +
        '<div class="pk-card-top"><span class="pk-name">' + esc(t.name) + '</span>' +
        '<span class="pk-count">' + t.items.length + ' item' + (t.items.length === 1 ? '' : 's') + '</span></div></button>' +
        '<button class="pk-go chip" data-action="pack-template" data-id="' + t.id + '">🧳 Pack</button>' +
        '</div>';
    }
    h += '</div>';
  }

  if (past.length) {
    h += '<div class="group-head">past trips</div><div class="pk-cards">';
    for (const t of past) {
      const p = progress(t);
      h += '<button class="pk-card past" data-action="open-trip" data-id="' + t.id + '">' +
        '<div class="pk-card-top"><span class="pk-name">' + esc(t.name) + '</span>' +
        '<span class="pk-count">' + fmtDate(t.doneAt || t.createdAt) + '</span></div>' +
        '<div class="pk-sub2">' + p.total + ' items · packed ' + p.done + '</div></button>';
    }
    h += '</div>';
  }
  return h;
}

function itemRowHtml(text, itemId, kind, opts = {}) {
  // kind: 'tpl' (plain, editable) or 'trip' (checkbox + editable)
  // A drag handle reorders; checked trip items aren't draggable (order is moot).
  const grip = opts.checked ? '<span class="pk-grip off"> </span>'
    : '<span class="pk-grip" data-grip aria-label="drag to reorder">⠿</span>';
  const box = kind === 'trip'
    ? '<button class="pk-check' + (opts.checked ? ' on' : '') + '" data-action="toggle-trip-item" data-id="' + itemId + '" aria-label="pack">' + (opts.checked ? '✓' : '') + '</button>'
    : '';
  const save = (kind === 'trip' && opts.templated)
    ? '<button class="pk-save" data-action="save-to-template" data-id="' + itemId + '" title="keep on the list for next time">⤒</button>' : '';
  const grp = '<button class="pk-gchip" data-action="group-item" data-id="' + itemId + '" title="put in a group">⊞</button>';
  return '<div class="pk-item' + (opts.checked ? ' done' : '') + '" data-id="' + itemId + '">' + grip + box +
    '<span class="pk-text pk-edit" contenteditable="true" data-kind="' + kind + '-item" data-id="' + itemId + '">' + esc(text) + '</span>' +
    grp + save +
    '<button class="pk-x" data-action="del-' + kind + '-item" data-id="' + itemId + '" aria-label="remove">✕</button></div>';
}

// Controls above a list: A–Z sort and one-tap auto-grouping
function sortBar() {
  return '<div class="pk-sortbar"><button class="chip small" data-action="sort-az">A–Z</button>' +
    '<button class="chip small" data-action="auto-group">✦ Auto-group</button>' +
    '<span class="hint tiny">drag ⠿ to reorder · ⊞ to group</span></div>';
}

// Render a set of items either flat or, when any of them carry a group, inside
// faint colour-coded cards sorted by group name. Each card (and the ungrouped
// tray) is a drop target, so dragging a row into another card regroups it.
function listBodyHtml(items, kind, opts) {
  const sorted = byOrd(items);
  const rows = (arr) => arr.map(i => itemRowHtml(i.text, i.id, kind, { ...opts(i) })).join('');
  if (!sorted.some(i => i.group)) {
    return '<div class="pk-list" data-sortable data-group="">' + rows(sorted) + '</div>';
  }
  const groups = new Map(), loose = [];
  for (const i of sorted) { if (i.group) { (groups.get(i.group) || groups.set(i.group, []).get(i.group)).push(i); } else loose.push(i); }
  let h = '';
  for (const name of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const sw = catSwatch(name);
    h += '<div class="pk-group" style="background:' + sw.bg + '55;border-color:' + sw.bg + '">' +
      '<div class="pk-group-head" style="color:' + sw.deep + '">' + esc(name) + '</div>' +
      '<div class="pk-list" data-sortable data-group="' + esc(name) + '">' + rows(groups.get(name)) + '</div></div>';
  }
  if (loose.length) {
    h += '<div class="pk-group loose"><div class="pk-group-head">Ungrouped</div>' +
      '<div class="pk-list" data-sortable data-group="">' + rows(loose) + '</div></div>';
  }
  return h;
}

function templateHtml(t) {
  let h = '<button class="pk-back" data-action="home">‹ Packing</button>' +
    '<input class="pk-title pk-edit-name" id="pkTplName" value="' + esc(t.name) + '" data-kind="tpl-name" aria-label="list name">' +
    '<div class="pk-dump"><textarea id="pkTplDump" placeholder="Brain-dump items — one per line or comma-separated&#10;e.g. toothbrushes, sunscreen, Kiva’s inhaler, chargers"></textarea>' +
    '<button class="primary" data-action="add-template-items">Add to list</button></div>';
  if (!t.items.length) {
    h += '<p class="hint">Empty for now — dump the things you always bring above.</p>';
  } else {
    if (t.items.length > 1) h += sortBar();
    h += listBodyHtml(t.items, 'tpl', () => ({}));
  }
  h += '<div class="pk-actions">' +
    '<button class="primary big" data-action="pack-template" data-id="' + t.id + '">🧳 Pack for a trip</button>' +
    '<button class="chip danger" data-action="del-template">Delete list</button></div>';
  return h;
}

function tripHtml(t) {
  const p = progress(t);
  const unchecked = byOrd(t.items.filter(i => !i.checked));
  const checked = byOrd(t.items.filter(i => i.checked));
  // ⤒ ("keep for next time") only makes sense for items not already on the
  // source template — so hide it on the ones that came from the template.
  const tpl = t.templateId ? getTemplate(t.templateId) : null;
  const inTemplate = new Set((tpl ? tpl.items : []).map(i => normText(i.text)));
  const canSave = (i) => !!t.templateId && !inTemplate.has(normText(i.text));
  let h = '<button class="pk-back" data-action="home">‹ Packing</button>' +
    '<input class="pk-title pk-edit-name" id="pkTripName" value="' + esc(t.name) + '" data-kind="trip-name" aria-label="trip name">' +
    '<div class="pk-trip-head"><span class="pk-count big">' + p.done + ' / ' + p.total + ' packed</span>' +
    '<div class="pk-bar big"><i style="width:' + p.pct + '%"></i></div></div>';

  h += '<div class="pk-add"><input id="pkTripAdd" placeholder="Add an item…" autocapitalize="none" enterkeyhint="done">' +
    '<button class="chip" data-action="add-trip-items">Add</button></div>';

  if (!unchecked.length && !checked.length) {
    h += '<p class="hint">Nothing here yet — add items above.</p>';
  }
  if (unchecked.length) {
    if (unchecked.length > 1) h += sortBar();
    h += listBodyHtml(unchecked, 'trip', (i) => ({ checked: false, templated: canSave(i) }));
  }
  if (checked.length) {
    h += '<div class="pk-packed-head">✓ packed (' + checked.length + ')</div><div class="pk-list packed">';
    for (const i of checked) h += itemRowHtml(i.text, i.id, 'trip', { checked: true, templated: canSave(i) });
    h += '</div>';
  }

  h += '<div class="pk-actions">' +
    (t.done
      ? '<button class="primary big" data-action="reopen-trip">Reopen trip</button>'
      : '<button class="primary big" data-action="finish-trip">Finish &amp; keep this list</button>') +
    '<button class="chip" data-action="reuse-trip">Reuse as new trip</button>' +
    '<button class="chip" data-action="copy-trip">Copy as text</button>' +
    '<button class="chip danger" data-action="del-trip">Delete</button></div>';
  return h;
}

export function renderPacking() {
  const view = $('#view-pack');
  if (!view) return;
  if (nav.screen === 'template') {
    const t = getTemplate(nav.id);
    if (!t) { nav = { screen: 'home', id: null }; }
    else { view.innerHTML = templateHtml(t); return; }
  }
  if (nav.screen === 'trip') {
    const t = getTrip(nav.id);
    if (!t) { nav = { screen: 'home', id: null }; }
    else { view.innerHTML = tripHtml(t); return; }
  }
  view.innerHTML = homeHtml();
}

// ---------- interaction (delegated on the persistent container) ----------
function tripText(t) {
  return t.items.map(i => (i.checked ? '☑ ' : '☐ ') + i.text).join('\n');
}

async function copyTrip(t) {
  const text = t.name + '\n' + tripText(t);
  try { await navigator.clipboard.writeText(text); showToast('Copied — paste it anywhere.'); }
  catch (e) { showToast('Couldn’t copy on this device.'); }
}

export function initPacking() {
  const view = $('#view-pack');
  if (!view) return;

  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action, id = btn.dataset.id;

    switch (a) {
      case 'home': packGoto('home'); return;
      case 'open-template': packGoto('template', id); return;
      case 'open-trip': packGoto('trip', id); return;

      case 'new-template': {
        const name = prompt('Name this list (e.g. “Summer trip”, “Ski trip”)');
        if (name && name.trim()) { const t = addTemplate(name); packGoto('template', t.id); changed(); }
        return;
      }
      case 'pack-template': {
        const tpl = getTemplate(id); if (!tpl) return;
        const name = prompt('Name this trip', tpl.name + ' — ' + fmtDate(Date.now()));
        if (name === null) return; // cancelled
        packGoto('trip', startTrip(id, name).id); changed();
        return;
      }
      case 'add-template-items': {
        const ta = $('#pkTplDump'); const n = addTemplateItems(nav.id, ta ? ta.value : '');
        changed();
        if (n) showToast('Added ' + n + ' item' + (n === 1 ? '' : 's') + '.');
        return;
      }
      case 'del-tpl-item': removeTemplateItem(nav.id, id); changed(); return;
      case 'del-template': {
        const t = getTemplate(nav.id);
        if (t && confirm('Delete “' + t.name + '”? Trips already started keep their own copies.')) {
          deleteTemplate(nav.id); packGoto('home'); changed();
        }
        return;
      }

      case 'add-trip-items': {
        const inp = $('#pkTripAdd'); const n = addTripItems(nav.id, inp ? inp.value : '');
        changed();
        const again = $('#pkTripAdd'); if (again) again.focus();
        if (!n) showToast('Already on the list.');
        return;
      }
      case 'group-item': {
        const kind = nav.screen === 'template' ? 'template' : 'trip';
        const list = kind === 'template' ? getTemplate(nav.id) : getTrip(nav.id);
        const it = list && list.items.find(x => x.id === id); if (!it) return;
        const existing = packListGroups(kind, nav.id);
        const msg = 'Group name for this item' +
          (existing.length ? ' — existing: ' + existing.join(', ') : '') +
          '.\n(Leave blank to ungroup.)';
        const g = prompt(msg, it.group || '');
        if (g === null) return;
        setPackItemGroup(kind, nav.id, id, g);
        changed();
        return;
      }
      case 'auto-group': {
        const kind = nav.screen === 'template' ? 'template' : 'trip';
        const list = kind === 'template' ? getTemplate(nav.id) : getTrip(nav.id);
        if (!list) return;
        // fill ONLY ungrouped items — never overwrite a group set by hand
        let n = 0, left = 0;
        for (const it of list.items) {
          if (it.group) continue;
          const g = packGroupOf(it.text);
          if (g) { setPackItemGroup(kind, nav.id, it.id, g); n++; }
          else left++;
        }
        changed();
        showToast(n
          ? 'Grouped ' + n + ' item' + (n === 1 ? '' : 's') + (left ? ' · ' + left + ' left for you' : '')
          : 'Nothing I recognize to group — use ⊞ to place the rest.');
        return;
      }
      case 'sort-az': {
        if (nav.screen === 'template') sortPackList('template', nav.id);
        else if (nav.screen === 'trip') {
          const t = getTrip(nav.id); if (!t) return;
          sortPackList('trip', nav.id, t.items.filter(i => !i.checked).map(i => i.id));
        }
        changed();
        return;
      }
      case 'toggle-trip-item': toggleTripItem(nav.id, id); changed(); return;
      case 'del-trip-item': removeTripItem(nav.id, id); changed(); return;
      case 'save-to-template': {
        const added = saveTripItemToTemplate(nav.id, id);
        if (added) changed();
        showToast(added ? 'Added to your list for next time.' : 'Already on your list.');
        return;
      }
      case 'finish-trip': setTripDone(nav.id, true); changed(); return;
      case 'reopen-trip': setTripDone(nav.id, false); changed(); return;
      case 'reuse-trip': {
        const src = getTrip(nav.id); if (!src) return;
        const name = prompt('Name the new trip', src.name);
        if (name === null) return;
        packGoto('trip', reuseTrip(nav.id, name).id); changed();
        return;
      }
      case 'copy-trip': { const t = getTrip(nav.id); if (t) copyTrip(t); return; }
      case 'del-trip': {
        const t = getTrip(nav.id);
        if (t && confirm('Delete “' + t.name + '”? This can’t be undone.')) { deleteTrip(nav.id); packGoto('home'); changed(); }
        return;
      }
    }
  });

  // inline edits: item text and list/trip names save on blur (focusout bubbles).
  // We persist + queue a sync but DON'T re-render here — rebuilding the DOM on
  // blur would eat the very tap (a checkbox, another row) that caused the blur.
  view.addEventListener('focusout', (e) => {
    const el = e.target.closest('.pk-edit, .pk-edit-name');
    if (!el) return;
    const kind = el.dataset.kind, id = el.dataset.id;
    const text = (el.value !== undefined ? el.value : el.innerText).trim();
    if (kind === 'tpl-item') editTemplateItem(nav.id, id, text);
    else if (kind === 'trip-item') editTripItem(nav.id, id, text);
    else if (kind === 'tpl-name') renameTemplate(nav.id, text);
    else if (kind === 'trip-name') renameTrip(nav.id, text);
    else return;
    document.dispatchEvent(new CustomEvent('stratos:packsync')); // sync, no re-render
  });

  // Enter in the quick-add or on a contenteditable item commits without a newline
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'pkTripAdd') {
      e.preventDefault();
      const n = addTripItems(nav.id, e.target.value); changed();
      const again = $('#pkTripAdd'); if (again) again.focus();
      if (!n) showToast('Already on the list.');
    } else if (e.target.classList && e.target.classList.contains('pk-edit')) {
      e.preventDefault(); e.target.blur();
    }
  });

  // drag-to-reorder / regroup: grab the ⠿ handle and move a row. It follows the
  // finger across group cards (each is a drop target); on release we persist the
  // new order and, if it landed in a different card, its new group.
  let drag = null;
  const domSnapshot = () => [...view.querySelectorAll('[data-sortable]')]
    .flatMap(c => [...c.querySelectorAll('.pk-item')].map(r => (c.dataset.group || '') + '/' + r.dataset.id)).join(',');
  view.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]'); if (!grip) return;
    const row = grip.closest('.pk-item');
    if (!row || !row.closest('[data-sortable]')) return;
    e.preventDefault();
    drag = { row, start: domSnapshot() };
    row.classList.add('dragging');
    try { grip.setPointerCapture(e.pointerId); } catch (_) {}
  });
  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const under = document.elementFromPoint(e.clientX, e.clientY); // .dragging has pointer-events:none
    const target = (under && under.closest('[data-sortable]')) || drag.row.closest('[data-sortable]');
    if (!target) return;
    const others = [...target.querySelectorAll('.pk-item:not(.dragging)')];
    let placed = false;
    for (const r of others) {
      const box = r.getBoundingClientRect();
      if (e.clientY < box.top + box.height / 2) { target.insertBefore(drag.row, r); placed = true; break; }
    }
    if (!placed) target.appendChild(drag.row);
  });
  const endDrag = () => {
    if (!drag) return;
    drag.row.classList.remove('dragging');
    const moved = domSnapshot() !== drag.start;
    drag = null;
    if (!moved) return;
    // read the DOM back into group + order (no-ops are skipped inside the store)
    const kind = nav.screen === 'template' ? 'template' : 'trip';
    for (const c of view.querySelectorAll('[data-sortable]')) {
      const group = c.dataset.group || '';
      const ids = [...c.querySelectorAll('.pk-item')].map(r => r.dataset.id);
      for (const iid of ids) setPackItemGroup(kind, nav.id, iid, group);
      setPackListOrder(kind, nav.id, ids);
    }
    changed();
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);
}
