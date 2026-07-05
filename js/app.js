// App shell: navigation, profile picker, badge, service worker.

import { state, save, inboxItems, memberName } from './store.js';
import { initSizer, openSizer } from './bubbles.js';
import { initDump, initHouse, renderLists, renderHouse, renderSettings } from './views.js';

const $ = (s) => document.querySelector(s);
let current = 'dump';

function goto(view) {
  current = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view));
  if (view === 'lists') renderLists();
  if (view === 'house') renderHouse();
  if (view === 'settings') renderSettings();
  if (view === 'size') openSizer(inboxItems(), () => goto('lists'));
  window.scrollTo(0, 0);
}
window.stratosGoto = goto;

function refreshBadge() {
  const n = inboxItems().length;
  const b = $('#inboxBadge');
  b.hidden = n === 0;
  b.textContent = n;
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

  document.addEventListener('stratos:changed', () => {
    refreshBadge();
    if (current === 'lists') renderLists();
    if (current === 'house') renderHouse();
  });

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
  goto('dump');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
