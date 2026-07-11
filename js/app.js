// App shell: navigation, profile picker, badge, service worker.

import { state, save, inboxItems, memberName, tickLoops } from './store.js';
import { initSizer, openSizer, openUniverse } from './bubbles.js';
import { initDump, initHouse, renderLists, renderHouse, renderSettings, renderTakeover, renderDigest, refreshDumpResults, allSurfaced, openSheet, initNews, renderNewsBlob } from './views.js';
import { initPacking, renderPacking } from './packing.js';
import { syncNow, syncConfigured } from './hsync.js';

const $ = (s) => document.querySelector(s);
let current = 'dump';

function goto(view) {
  tickLoops(); // reawaken loop items whose cycle is coming due
  current = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view));
  if (view === 'lists') renderLists();
  if (view === 'house') renderHouse();
  if (view === 'pack') renderPacking();
  if (view === 'settings') renderSettings();
  if (view === 'size') openUniverse();
  window.scrollTo(0, 0);
}
window.stratosGoto = goto;

function refreshBadge() {
  const n = inboxItems().length;
  const b = $('#inboxBadge');
  b.hidden = n === 0;
  b.textContent = n;
  // the Lists tab itself glows when something is surfacing
  const surfacing = allSurfaced().length > 0;
  document.querySelector('[data-view="lists"]').classList.toggle('surfacing', surfacing);
}

function refreshProfileChip() {
  $('#profileChip').textContent = memberName(state.profile);
}

function init() {
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => goto(t.dataset.view)));
  $('#settingsBtn').addEventListener('click', () => goto('settings'));
  $('#profileChip').addEventListener('click', () => goto('settings'));

  initDump();
  initHouse();
  initSizer();
  initNews();
  initPacking();

  document.addEventListener('stratos:changed', () => {
    refreshBadge();
    renderNewsBlob(); // a sync from the other person may have brought news
    if (current === 'dump') refreshDumpResults();
    if (current === 'lists') renderLists();
    if (current === 'house') renderHouse();
    if (current === 'pack') renderPacking();
  });

  // tapping the hero bubble in the sizer opens its full edit sheet
  document.addEventListener('stratos:edit', (e) => openSheet(e.detail));

  // --- Google Drive sync scheduling ---
  let syncTimer = null;
  const trySync = () => { if (syncConfigured()) syncNow(); };
  const scheduleSync = () => { clearTimeout(syncTimer); syncTimer = setTimeout(trySync, 4000); };
  document.addEventListener('stratos:changed', scheduleSync); // debounce pushes after edits
  // a packing inline-edit blur: push it, but no re-render (would eat the next tap)
  document.addEventListener('stratos:packsync', scheduleSync);
  window.addEventListener('focus', trySync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) trySync(); });
  setInterval(trySync, 60000);
  trySync(); // on load

  if (!state.profile) {
    const fr = $('#firstRun');
    fr.hidden = false;
    fr.querySelectorAll('[data-profile]').forEach(b =>
      b.addEventListener('click', () => {
        state.profile = b.dataset.profile;
        save();
        fr.hidden = true;
        refreshProfileChip();
      }));
  }

  refreshProfileChip();
  refreshBadge();
  renderNewsBlob(); // show any unreviewed changes from the other person
  goto('lists'); // the app opens to your ranked list
  // once a day, a warm digest greets you; otherwise the ember takeover floats
  // whatever needs eyes before everything else
  if (!renderDigest()) renderTakeover();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
