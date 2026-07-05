// Stratos data layer: localStorage persistence, strata, local learning.

const DB_KEY = 'stratos.v1';

export const DIM_ORDER = ['priority', 'effort', 'difficulty', 'dread', 'restock'];

const DEFAULT_DIMS = {
  priority:   { label: 'Priority',   strata: ['Someday', 'Whenever', 'Soon-ish', 'This week', 'Important', 'Urgent', 'On fire'] },
  effort:     { label: 'Effort',     strata: ['Minutes', 'An hour', 'A morning', 'A day', 'Several days', 'Weeks', 'A season'] },
  difficulty: { label: 'Difficulty', strata: ['Trivial', 'Easy', 'Manageable', 'Tricky', 'Hard', 'Draining', 'Overwhelming'] },
  dread:      { label: 'Dread',      strata: ['Fun', 'Fine', 'Meh', 'Ugh', 'Avoiding it', 'Dreading it', 'Paralyzing'] },
  restock:    { label: 'Restock',    strata: ['Stocked', 'Plenty', 'Fine', 'Getting low', 'Low', 'Almost out', 'Out!'] },
};

function freshState() {
  const dims = {};
  for (const [id, d] of Object.entries(DEFAULT_DIMS)) {
    dims[id] = { label: d.label, strata: d.strata.map((label, i) => ({ id: id + '_' + i, label })) };
  }
  return {
    profile: null,
    family: [
      { id: 'anna', name: 'Anna', user: true },
      { id: 'ebbe', name: 'Ebbe', user: true },
      { id: 'kid1', name: 'Kid 1' },
      { id: 'kid2', name: 'Kid 2' },
      { id: 'house', name: 'House' },
    ],
    dims,
    items: [],
    learned: {}, // field -> token -> value -> count
    seq: 1,
  };
}

export let state = load();

function load() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* corrupted -> start fresh */ }
  return freshState();
}

export function save() {
  localStorage.setItem(DB_KEY, JSON.stringify(state));
}

export function uid() { return 'i' + (state.seq++) + '_' + Date.now().toString(36); }

// ---------- items ----------

export function addItem(fields) {
  const item = {
    id: uid(),
    createdAt: Date.now(),
    createdBy: state.profile,
    raw: fields.raw || fields.title,
    title: fields.title,
    type: fields.type || 'task',
    scope: fields.scope || state.profile,
    category: fields.category || 'general',
    visibility: fields.visibility || 'shared',
    due: fields.due || null,
    dims: {},
    status: 'inbox',
    agentGuess: {
      type: fields.type, scope: fields.scope,
      category: fields.category, visibility: fields.visibility,
    },
  };
  state.items.push(item);
  save();
  return item;
}

export function getItem(id) { return state.items.find(i => i.id === id); }

export function deleteItem(id) {
  state.items = state.items.filter(i => i.id !== id);
  save();
}

// Update fields; anything that differs from the current value counts as a
// correction and teaches the local agent.
export function updateItem(id, fields) {
  const item = getItem(id);
  if (!item) return;
  const toks = tokens(item.title);
  for (const [k, v] of Object.entries(fields)) {
    if (['type', 'scope', 'category', 'visibility'].includes(k) && item[k] !== v) {
      learn(k, toks, v);
      learnExact(k, item.title, v);
      // rolling correction log — becomes context for the Gemini agent
      (state.corrections || (state.corrections = [])).push({ title: item.title, field: k, to: v, at: Date.now() });
      state.corrections = state.corrections.slice(-50);
    }
    item[k] = v;
  }
  save();
  return item;
}

export function setMagnitude(id, dimId, stratumId, frac) {
  const item = getItem(id);
  if (!item) return;
  item.dims[dimId] = { s: stratumId, f: frac, at: Date.now() };
  if (item.status === 'inbox') item.status = 'active';
  save();
}

export function markDone(id, done = true) {
  const item = getItem(id);
  if (!item) return;
  item.status = done ? 'done' : 'active';
  item.doneAt = done ? Date.now() : null;
  save();
}

// ---------- strata math ----------

// continuous magnitude: stratumIndex + frac, or null if unsized
export function uOf(item, dimId) {
  const m = item.dims?.[dimId];
  if (!m) return null;
  const idx = state.dims[dimId].strata.findIndex(s => s.id === m.s);
  if (idx < 0) return null;
  return idx + (m.f ?? 0.5);
}

export function insertStratum(dimId, atIdx, label) {
  const dim = state.dims[dimId];
  dim.strata.splice(atIdx, 0, { id: dimId + '_x' + Date.now().toString(36), label });
  save();
}

// ---------- deadline gravity ----------
// 0 beyond 14 days out; ramps to +3 strata at due/overdue.
export function gravityBoost(item) {
  if (!item.due) return 0;
  const days = (new Date(item.due + 'T23:59:59') - Date.now()) / 86400e3;
  if (days <= 0) return 3;
  if (days <= 2) return 2.5;
  if (days <= 7) return 1 + (7 - days) / 5 * 1.5;   // 1 .. 2.5
  if (days <= 14) return (14 - days) / 7;            // 0 .. 1
  return 0;
}

export function effectivePriority(item) {
  const base = uOf(item, 'priority') ?? 3.0;
  const n = state.dims.priority.strata.length;
  return Math.min(n - 0.01, base + gravityBoost(item));
}

// ---------- local learning ----------

export function tokens(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9æøåäöü\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}
const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'about', 'need', 'get', 'buy', 'some', 'new']);

export function learn(field, toks, value) {
  const L = state.learned[field] || (state.learned[field] = {});
  for (const t of toks) {
    const tv = L[t] || (L[t] = {});
    tv[value] = (tv[value] || 0) + 1;
  }
  save();
}

// Exact-phrase memory: one correction is enough for a verbatim repeat
// ("milk" marked private stays private next time it's dumped).
const normPhrase = (t) => tokens(t).join(' ');

export function learnExact(field, title, value) {
  const key = '_exact_' + field;
  const L = state.learned[key] || (state.learned[key] = {});
  const p = normPhrase(title);
  if (p) L[p] = value;
  save();
}

export function exactGuess(field, text) {
  const L = state.learned['_exact_' + field];
  return (L && L[normPhrase(text)]) || null;
}

// Returns {value, score} learned for these tokens, or null.
export function learnedGuess(field, toks, minScore = 1) {
  const L = state.learned[field];
  if (!L) return null;
  const scores = {};
  for (const t of toks) {
    const tv = L[t];
    if (!tv) continue;
    for (const [v, c] of Object.entries(tv)) scores[v] = (scores[v] || 0) + c;
  }
  let best = null;
  for (const [v, s] of Object.entries(scores)) {
    if (!best || s > best.score) best = { value: v, score: s };
  }
  return best && best.score >= minScore ? best : null;
}

// ---------- misc ----------

export function memberName(id) {
  return state.family.find(f => f.id === id)?.name || id;
}

export function visibleTo(item, profile) {
  return item.visibility !== 'private' || item.createdBy === profile;
}

export function inboxItems() {
  return state.items.filter(i => i.status === 'inbox' && visibleTo(i, state.profile));
}

export function exportJSON() { return JSON.stringify(state, null, 2); }

export function importJSON(text) {
  const parsed = JSON.parse(text); // throws if invalid
  if (!parsed.items || !parsed.dims) throw new Error('not a Stratos export');
  state = parsed;
  save();
}

export function resetAll() {
  state = freshState();
  save();
}
