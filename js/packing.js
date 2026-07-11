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
} from './store.js';
import { showToast } from './views.js';

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

// ---------- screens ----------
function homeHtml() {
  const trips = packTrips();
  const active = trips.filter(t => !t.done);
  const past = trips.filter(t => t.done);
  const tpls = packTemplates();

  let h = '<h1>Packing</h1>' +
    '<p class="hint">Reusable lists to pack from — brain-dump once, tick as you go. Edit them as the kids grow.</p>';

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
  const box = kind === 'trip'
    ? '<button class="pk-check' + (opts.checked ? ' on' : '') + '" data-action="toggle-trip-item" data-id="' + itemId + '" aria-label="pack">' + (opts.checked ? '✓' : '') + '</button>'
    : '<span class="pk-dot">•</span>';
  const save = (kind === 'trip' && opts.templated)
    ? '<button class="pk-save" data-action="save-to-template" data-id="' + itemId + '" title="keep on the list for next time">⤒</button>' : '';
  return '<div class="pk-item' + (opts.checked ? ' done' : '') + '">' + box +
    '<span class="pk-text pk-edit" contenteditable="true" data-kind="' + kind + '-item" data-id="' + itemId + '">' + esc(text) + '</span>' +
    save +
    '<button class="pk-x" data-action="del-' + kind + '-item" data-id="' + itemId + '" aria-label="remove">✕</button></div>';
}

function templateHtml(t) {
  let h = '<button class="pk-back" data-action="home">‹ Packing</button>' +
    '<input class="pk-title pk-edit-name" id="pkTplName" value="' + esc(t.name) + '" data-kind="tpl-name" aria-label="list name">' +
    '<div class="pk-dump"><textarea id="pkTplDump" placeholder="Brain-dump items — one per line or comma-separated&#10;e.g. toothbrushes, sunscreen, Kiva’s inhaler, chargers"></textarea>' +
    '<button class="primary" data-action="add-template-items">Add to list</button></div>';
  if (!t.items.length) {
    h += '<p class="hint">Empty for now — dump the things you always bring above.</p>';
  } else {
    h += '<div class="pk-list">';
    for (const i of t.items) h += itemRowHtml(i.text, i.id, 'tpl');
    h += '</div>';
  }
  h += '<div class="pk-actions">' +
    '<button class="primary big" data-action="pack-template" data-id="' + t.id + '">🧳 Pack for a trip</button>' +
    '<button class="chip danger" data-action="del-template">Delete list</button></div>';
  return h;
}

function tripHtml(t) {
  const p = progress(t);
  const unchecked = t.items.filter(i => !i.checked);
  const checked = t.items.filter(i => i.checked);
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
    h += '<div class="pk-list">';
    for (const i of unchecked) h += itemRowHtml(i.text, i.id, 'trip', { checked: false, templated: !!t.templateId });
    h += '</div>';
  }
  if (checked.length) {
    h += '<div class="pk-packed-head">✓ packed (' + checked.length + ')</div><div class="pk-list packed">';
    for (const i of checked) h += itemRowHtml(i.text, i.id, 'trip', { checked: true, templated: !!t.templateId });
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
        if (name && name.trim()) packGoto('template', addTemplate(name).id);
        return;
      }
      case 'pack-template': {
        const tpl = getTemplate(id); if (!tpl) return;
        const name = prompt('Name this trip', tpl.name + ' — ' + fmtDate(Date.now()));
        if (name === null) return; // cancelled
        packGoto('trip', startTrip(id, name).id);
        return;
      }
      case 'add-template-items': {
        const ta = $('#pkTplDump'); const n = addTemplateItems(nav.id, ta ? ta.value : '');
        renderPacking();
        if (n) showToast('Added ' + n + ' item' + (n === 1 ? '' : 's') + '.');
        return;
      }
      case 'del-tpl-item': removeTemplateItem(nav.id, id); renderPacking(); return;
      case 'del-template': {
        const t = getTemplate(nav.id);
        if (t && confirm('Delete “' + t.name + '”? Trips already started keep their own copies.')) {
          deleteTemplate(nav.id); packGoto('home');
        }
        return;
      }

      case 'add-trip-items': {
        const inp = $('#pkTripAdd'); const n = addTripItems(nav.id, inp ? inp.value : '');
        renderPacking();
        const again = $('#pkTripAdd'); if (again) again.focus();
        if (!n) showToast('Already on the list.');
        return;
      }
      case 'toggle-trip-item': toggleTripItem(nav.id, id); renderPacking(); return;
      case 'del-trip-item': removeTripItem(nav.id, id); renderPacking(); return;
      case 'save-to-template': {
        const added = saveTripItemToTemplate(nav.id, id);
        showToast(added ? 'Added to your list for next time.' : 'Already on your list.');
        return;
      }
      case 'finish-trip': setTripDone(nav.id, true); renderPacking(); return;
      case 'reopen-trip': setTripDone(nav.id, false); renderPacking(); return;
      case 'reuse-trip': {
        const src = getTrip(nav.id); if (!src) return;
        const name = prompt('Name the new trip', src.name);
        if (name === null) return;
        packGoto('trip', reuseTrip(nav.id, name).id);
        return;
      }
      case 'copy-trip': { const t = getTrip(nav.id); if (t) copyTrip(t); return; }
      case 'del-trip': {
        const t = getTrip(nav.id);
        if (t && confirm('Delete “' + t.name + '”? This can’t be undone.')) { deleteTrip(nav.id); packGoto('home'); }
        return;
      }
    }
  });

  // inline edits: item text and list/trip names save on blur (focusout bubbles)
  view.addEventListener('focusout', (e) => {
    const el = e.target.closest('.pk-edit, .pk-edit-name');
    if (!el) return;
    const kind = el.dataset.kind, id = el.dataset.id;
    const text = (el.value !== undefined ? el.value : el.innerText).trim();
    if (kind === 'tpl-item') editTemplateItem(nav.id, id, text);
    else if (kind === 'trip-item') editTripItem(nav.id, id, text);
    else if (kind === 'tpl-name') renameTemplate(nav.id, text);
    else if (kind === 'trip-name') renameTrip(nav.id, text);
  });

  // Enter in the quick-add or on a contenteditable item commits without a newline
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'pkTripAdd') {
      e.preventDefault();
      const n = addTripItems(nav.id, e.target.value); renderPacking();
      const again = $('#pkTripAdd'); if (again) again.focus();
      if (!n) showToast('Already on the list.');
    } else if (e.target.classList && e.target.classList.contains('pk-edit')) {
      e.preventDefault(); e.target.blur();
    }
  });
}
