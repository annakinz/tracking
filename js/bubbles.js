// The magnitude interface: a bubble you pinch through exponential strata.
// u = stratumIndex + frac(0..1). Crossing a band boundary "jumps scopes":
// the background shifts, peers swap to that stratum's residents, and the
// bubble re-enters small (growing) or large (shrinking).

import { state, setMagnitude, uOf, insertStratum, visibleTo } from './store.js';
import { defaultDimension } from './classify.js';

const MIN_W = 96, MAX_W = 250;   // bubble width across one stratum

// ground → meadow → sky → sunset → dusk → night → space
// (each stratum is properly its own color; sunset is the pink→orange pair)
const STAGE_THEMES = [
  ['#FFE49A', '#F5C35B', '#6B4E12'],
  ['#D3F5A6', '#93DB66', '#336110'],
  ['#BFE9FF', '#6BBFF2', '#0F5C94'],
  ['#FFC3D9', '#FF9660', '#8F1D4E'],
  ['#E5B8F2', '#8E7BE6', '#3F2387'],
  ['#5A4BAF', '#2A2168', '#EDE7FF'],
  ['#282052', '#0D0B22', '#D9D3F5'],
];
const PEER_SLOTS = [
  [0.18, 0.20], [0.82, 0.18], [0.14, 0.62], [0.86, 0.60], [0.30, 0.82], [0.72, 0.84],
];

let els = null;
let queue = [];          // items waiting to be sized
let item = null;         // current item
let dim = 'priority';
let u = 3.5;
let lastStratum = -1;
let onFinish = null;

export function initSizer() {
  els = {
    stage: document.getElementById('sizeStage'),
    empty: document.getElementById('sizeEmpty'),
    bg: document.getElementById('strataBg'),
    peers: document.getElementById('peerLayer'),
    bubble: document.getElementById('theBubble'),
    label: document.getElementById('bubbleLabel'),
    rail: document.getElementById('rail'),
    num: document.getElementById('stratumNum'),
    name: document.getElementById('stratumName'),
    chips: document.getElementById('dimChips'),
    ok: document.getElementById('okBtn'),
    skip: document.getElementById('skipBtn'),
  };
  bindGestures();
  els.ok.addEventListener('click', commit);
  els.skip.addEventListener('click', skip);
}

// Open the sizer for a queue of items. done() runs when the queue empties.
export function openSizer(items, done, forcedDim) {
  queue = items.slice();
  onFinish = done;
  if (!queue.length) return showEmpty();
  nextItem(forcedDim);
}

function showEmpty() {
  els.stage.hidden = true;
  els.empty.hidden = false;
  if (onFinish) { const f = onFinish; onFinish = null; f(); }
}

function nextItem(forcedDim) {
  item = queue.shift();
  if (!item) return showEmpty();
  els.empty.hidden = true;
  els.stage.hidden = false;
  dim = forcedDim || defaultDimension(item);
  const existing = uOf(item, dim);
  const n = state.dims[dim].strata.length;
  u = existing ?? (n - 1) / 2 + 0.5;
  lastStratum = -1;
  els.label.textContent = item.title;
  renderChips();
  buildRail();
  render();
}

function renderChips() {
  els.chips.innerHTML = '';
  for (const [id, d] of Object.entries(state.dims)) {
    const b = document.createElement('button');
    b.className = 'chip' + (id === dim ? ' on' : '');
    b.textContent = d.label;
    b.onclick = () => {
      dim = id;
      const n = state.dims[dim].strata.length;
      u = uOf(item, dim) ?? (n - 1) / 2 + 0.5;
      lastStratum = -1;
      renderChips(); buildRail(); render();
    };
    els.chips.appendChild(b);
  }
}

function buildRail() {
  const strata = state.dims[dim].strata;
  els.rail.innerHTML = '';
  // top of rail = highest stratum
  for (let i = strata.length - 1; i >= 0; i--) {
    if (i < strata.length - 1) {
      const plus = document.createElement('button');
      plus.className = 'rail-plus';
      plus.textContent = '+';
      plus.title = 'Insert a stratum here';
      plus.onclick = (e) => {
        e.stopPropagation();
        const label = prompt('Name for the new stratum (between "' +
          strata[i].label + '" and "' + strata[i + 1].label + '")?');
        if (label === null) return;
        insertStratum(dim, i + 1, label || 'Between');
        if (Math.floor(u) > i) u += 1; // keep the bubble where it visually was
        lastStratum = -1;
        buildRail(); render();
      };
      els.rail.appendChild(plus);
    }
    const cell = document.createElement('button');
    cell.className = 'rail-cell';
    cell.dataset.idx = i;
    cell.textContent = i + 1;
    cell.onclick = () => { u = i + 0.5; render(); };
    els.rail.appendChild(cell);
  }
}

function peersOf(stratumIdx) {
  const sid = state.dims[dim].strata[stratumIdx]?.id;
  return state.items.filter(o =>
    o.id !== item.id && o.status !== 'done' &&
    visibleTo(o, state.profile) &&
    o.dims?.[dim]?.s === sid
  ).slice(0, PEER_SLOTS.length);
}

function render() {
  if (!item) return; // stray gestures on an empty stage
  const strata = state.dims[dim].strata;
  const n = strata.length;
  u = Math.max(0.02, Math.min(n - 0.02, u));
  const idx = Math.floor(u);
  const frac = u - idx;

  const w = MIN_W + (MAX_W - MIN_W) * frac;
  els.bubble.style.width = els.bubble.style.height = w + 'px';

  els.num.textContent = (idx + 1);
  els.name.textContent = strata[idx].label;

  // depth theme: warm ground at the bottom stratum, up through sky and
  // sunset to space at the top — the world darkens as things get bigger
  const depth = idx / Math.max(1, n - 1);
  const theme = STAGE_THEMES[Math.round(depth * (STAGE_THEMES.length - 1))];
  els.bg.style.background =
    `radial-gradient(120% 90% at 50% 110%, ${theme[0]} 0%, ${theme[1]} 75%)`;
  els.stage.style.setProperty('--stagefg', theme[2]);

  for (const c of els.rail.querySelectorAll('.rail-cell')) {
    c.classList.toggle('on', +c.dataset.idx === idx);
  }

  if (idx !== lastStratum) {
    const dir = lastStratum < 0 ? 0 : (idx > lastStratum ? 1 : -1);
    lastStratum = idx;
    renderPeers(idx);
    if (dir !== 0) {
      els.stage.classList.remove('jump-up', 'jump-down');
      void els.stage.offsetWidth; // restart animation
      els.stage.classList.add(dir > 0 ? 'jump-up' : 'jump-down');
      if (navigator.vibrate) navigator.vibrate(12);
    }
  }
}

function renderPeers(idx) {
  els.peers.innerHTML = '';
  const peers = peersOf(idx);
  peers.forEach((p, i) => {
    const f = p.dims[dim].f ?? 0.5;
    const w = (MIN_W + (MAX_W - MIN_W) * f) * 0.72; // peers slightly recessed
    const el = document.createElement('div');
    el.className = 'peer';
    el.style.width = el.style.height = w + 'px';
    el.style.left = (PEER_SLOTS[i][0] * 100) + '%';
    el.style.top = (PEER_SLOTS[i][1] * 100) + '%';
    el.style.fontSize = Math.max(9, w / 10) + 'px';
    el.innerHTML = '<span></span>';
    el.querySelector('span').textContent = p.title;
    els.peers.appendChild(el);
  });
}

// ---------- gestures ----------

function bindGestures() {
  const stage = els.stage;
  let pinchDist = 0;
  let dragY = null;

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchDist = dist(e.touches);
      dragY = null;
    } else if (e.touches.length === 1) {
      dragY = e.touches[0].clientY;
    }
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (e.target.closest('#sizeHud') || e.target.closest('#rail')) return;
    e.preventDefault();
    if (e.touches.length === 2) {
      const d = dist(e.touches);
      if (pinchDist > 0) {
        u += Math.log2(d / pinchDist) * 1.6;
        render();
      }
      pinchDist = d;
    } else if (e.touches.length === 1 && dragY !== null) {
      const y = e.touches[0].clientY;
      u -= (y - dragY) * 0.008; // drag up = grow
      dragY = y;
      render();
    }
  }, { passive: false });

  stage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchDist = 0;
    if (e.touches.length === 0) dragY = null;
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    u -= e.deltaY * 0.0028;
    render();
  }, { passive: false });

  // mouse drag for desktop testing
  let mouseY = null;
  stage.addEventListener('mousedown', (e) => {
    if (e.target.closest('#sizeHud') || e.target.closest('#rail')) return;
    mouseY = e.clientY;
  });
  window.addEventListener('mousemove', (e) => {
    if (mouseY === null) return;
    u -= (e.clientY - mouseY) * 0.008;
    mouseY = e.clientY;
    render();
  });
  window.addEventListener('mouseup', () => { mouseY = null; });
}

function dist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

// ---------- commit / skip ----------

function commit() {
  if (!item) return;
  const strata = state.dims[dim].strata;
  const idx = Math.floor(u);
  setMagnitude(item.id, dim, strata[idx].id, u - idx);
  document.dispatchEvent(new CustomEvent('stratos:changed'));
  nextItem(null);
}

function skip() {
  nextItem(null);
}
