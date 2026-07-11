// Stratos data layer: localStorage persistence, strata, local learning.

const DB_KEY = 'stratos.v1';

// Build number — bump together with the service-worker CACHE in sw.js on
// every deploy. Shown in Settings so you can confirm your phone is current.
export const BUILD = '45';

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
      { id: 'kid1', name: 'Auriea' },
      { id: 'kid2', name: 'Kiva' },
      { id: 'house', name: 'House' },
    ],
    dims,
    items: [],
    learned: {}, // field -> token -> value -> count
    seq: 1,
    // per-file deletion/unshare tombstones (id -> ts) for Drive sync merge
    syncTomb: { shared: {}, private: {} },
    // "while you were away": changes the OTHER person made, waiting to be
    // reviewed (popped). newsSeen dedupes so a popped item never comes back;
    // newsInit is set after the first shared sync so joining doesn't flood.
    news: [], newsSeen: {}, newsInit: false,
  };
}

// called after any change so sync can merge by "newest wins"
function touch(item) { if (item) item.updatedAt = Date.now(); }
function tombFor(kind) { return (state.syncTomb || (state.syncTomb = { shared: {}, private: {} }))[kind]; }

export let state = load();

function load() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* corrupted -> start fresh */ }
  return freshState();
}

export function save() {
  const json = JSON.stringify(state);
  localStorage.setItem(DB_KEY, json);
  maybeBackup(json);
}

// ---------- automatic local backups (undo a bad sync) ----------
// A rolling set of full-state snapshots kept in localStorage, separate from the
// live store. We take at most one every few hours (and at least one per new
// day) so a destructive sync is always recoverable to an earlier point without
// any server or manual export. Quota-safe: if the write is too big we drop the
// oldest snapshots until it fits.
const BAK_KEY = 'stratos.backups.v1';
const BAK_MAX = 8;            // how many snapshots to keep
const BAK_MIN_GAP = 6 * 3600 * 1000; // don't snapshot more than once per 6h...
let bakLast = 0;

function loadBackups() {
  try { return JSON.parse(localStorage.getItem(BAK_KEY)) || []; } catch (e) { return []; }
}
function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }

function maybeBackup(json) {
  let now;
  try { now = Date.now(); } catch (e) { return; } // Date.now unavailable in some test envs
  const list = loadBackups();
  const latest = list[list.length - 1];
  // ...but always keep one for each new calendar day, even inside the 6h window.
  const sameDay = latest && dayKey(latest.at) === dayKey(now);
  if (latest && (now - latest.at) < BAK_MIN_GAP && sameDay) return;
  if (now - bakLast < 60 * 1000) return; // never more than once a minute (churn guard)
  bakLast = now;
  list.push({ at: now, day: dayKey(now), data: json });
  writeBackups(list);
}

function writeBackups(list) {
  // newest-last; trim to BAK_MAX, then shrink further if we blow the quota
  while (list.length > BAK_MAX) list.shift();
  while (list.length) {
    try { localStorage.setItem(BAK_KEY, JSON.stringify(list)); return; }
    catch (e) { list.shift(); } // quota exceeded (e.g. photos) → drop oldest, retry
  }
  try { localStorage.removeItem(BAK_KEY); } catch (e) {}
}

// Snapshots for the UI, newest first: { at, day, items } (count only, no payload).
export function backupList() {
  return loadBackups().slice().reverse().map(b => {
    let items = 0;
    try { items = (JSON.parse(b.data).items || []).length; } catch (e) {}
    return { at: b.at, day: b.day, items };
  });
}

// Restore a snapshot by timestamp. Before overwriting we snapshot the CURRENT
// state too, so restoring is itself undoable.
export function restoreBackup(at) {
  const list = loadBackups();
  const hit = list.find(b => b.at === at);
  if (!hit) return false;
  let restored;
  try { restored = JSON.parse(hit.data); } catch (e) { return false; }
  maybeBackup(JSON.stringify(state)); // keep a pre-restore point
  state = restored;
  save();
  document.dispatchEvent(new CustomEvent('stratos:changed'));
  return true;
}

export function uid() { return 'i' + (state.seq++) + '_' + Date.now().toString(36); }

// ---------- items ----------

export function addItem(fields) {
  const scope = fields.scope || state.profile;

  // Loops: re-dumping something that already exists reactivates the same
  // item instead of duplicating it. Each recurrence is recorded; from 3+
  // occurrences the rhythm is learned (median gap in days).
  // (Subtasks are exempt — steps of different tasks may share names.)
  const phrase = normPhrase(fields.title);
  const existing = !fields.parent && phrase && state.items.find(i =>
    !i.parent && i.scope === scope && normPhrase(i.title) === phrase);
  if (existing) {
    const now = Date.now();
    const L = existing.loop || (existing.loop = { every: null, auto: true, history: [existing.createdAt] });
    if (!L.history || !L.history.length) L.history = [existing.createdAt];
    if (now - L.history[L.history.length - 1] > 12 * 3600e3) L.history.push(now);
    if (L.auto && L.history.length >= 3) {
      const gaps = [];
      for (let k = 1; k < L.history.length; k++) gaps.push((L.history[k] - L.history[k - 1]) / 86400e3);
      gaps.sort((a, b) => a - b);
      L.every = Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)]));
    }
    if (fields.due) existing.due = fields.due;
    if (fields.source && !existing.source) existing.source = fields.source;
    // previously sized -> straight to active with its magnitudes; else re-size
    existing.status = Object.keys(existing.dims || {}).length ? 'active' : 'inbox';
    existing.doneAt = null;
    touch(existing);
    save();
    return existing;
  }

  const item = {
    id: uid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: state.profile,
    raw: fields.raw || fields.title,
    title: fields.title,
    type: fields.type || 'task',
    scope,
    category: fields.category || 'general',
    visibility: fields.visibility || 'shared',
    due: fields.due || null,
    source: fields.source || null,
    loop: null,
    parent: fields.parent || null,
    notes: fields.notes || '',
    media: [],
    dims: {},
    status: 'inbox',
    agentGuess: {
      type: fields.type, scope: fields.scope,
      category: fields.category, visibility: fields.visibility,
      source: fields.source,
    },
  };
  state.items.push(item);
  save();
  return item;
}

// Reawaken resting loop items at ~60% of their cycle, so loop gravity has
// room to ramp toward the predicted run-out date instead of starting on fire.
export function tickLoops() {
  const now = Date.now();
  let dirty = false;
  for (const i of state.items) {
    if (i.status !== 'done' || !i.loop?.every || !i.doneAt) continue;
    // daily chores come back at the next calendar day; longer loops ramp back
    // in at ~60% of their cycle so deadline gravity has room to build.
    let reawakenAt;
    if (i.loop.every <= 1) {
      const d = new Date(i.doneAt); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
      reawakenAt = d.getTime();
    } else {
      reawakenAt = i.doneAt + i.loop.every * 0.6 * 86400e3;
    }
    if (now >= reawakenAt) { i.status = 'active'; dirty = true; }
  }
  if (dirty) save();
  return dirty;
}

export function getItem(id) { return state.items.find(i => i.id === id); }

export function deleteItem(id) {
  const now = Date.now();
  // tombstone the item and its steps in both files so the delete propagates
  for (const i of state.items) {
    if (i.id === id || i.parent === id) { tombFor('shared')[i.id] = now; tombFor('private')[i.id] = now; }
  }
  state.items = state.items.filter(i => i.id !== id && i.parent !== id);
  save();
}

export function childrenOf(id) {
  return state.items.filter(i => i.parent === id);
}

// Update fields; anything that differs from the current value counts as a
// correction and teaches the local agent.
export function updateItem(id, fields) {
  const item = getItem(id);
  if (!item) return;
  const oldVis = item.visibility;
  const toks = tokens(item.title);
  for (const [k, v] of Object.entries(fields)) {
    if (['type', 'scope', 'category', 'visibility', 'source'].includes(k) && v && item[k] !== v) {
      learn(k, toks, v);
      learnExact(k, item.title, v);
      // rolling correction log — becomes context for the Gemini agent
      (state.corrections || (state.corrections = [])).push({ title: item.title, field: k, to: v, at: Date.now() });
      state.corrections = state.corrections.slice(-50);
    }
    item[k] = v;
  }
  // if visibility flipped, tell the file it left to drop this item (no leak)
  if (fields.visibility && fields.visibility !== oldVis) {
    if (oldVis === 'shared') tombFor('shared')[id] = Date.now();
    else tombFor('private')[id] = Date.now();
  }
  touch(item);
  save();
  return item;
}

export function setMagnitude(id, dimId, stratumId, frac) {
  const item = getItem(id);
  if (!item) return;
  item.dims[dimId] = { s: stratumId, f: frac, at: Date.now() };
  if (item.status === 'inbox') item.status = 'active';
  touch(item);
  save();
}

export function markDone(id, done = true, note) {
  const item = getItem(id);
  if (!item) return;
  item.status = done ? 'done' : 'active';
  item.doneAt = done ? Date.now() : null;
  item.doneBy = done ? state.profile : null;      // who finished it (for the other's news)
  if (!done) item.doneNote = null;
  else if (note != null) item.doneNote = String(note).trim() || null;
  touch(item);
  save();
}

// Attach/replace a note to the other person on an already-finished item —
// travels with the item through sync and shows up in their review blob.
export function attachDoneNote(id, note) {
  const item = getItem(id);
  if (!item) return;
  item.doneNote = (note || '').trim() || null;
  touch(item);
  save();
}

// A little message thread lives on each shared item. Adding one bumps
// updatedAt so it syncs; the other person's copy surfaces it as news.
// kind: 'msg' (plain), 'ask' (please take this), 'thanks' (a heart back).
export function addMessage(id, text, kind = 'msg', photo = null) {
  const item = getItem(id);
  if (!item) return;
  const t = String(text || '').trim();
  if (!t && !photo) return item;
  const msg = { id: uid(), by: state.profile, text: t, kind, at: Date.now() };
  if (photo) msg.photo = photo;                 // small shrunk data-URL, syncs with the item
  (item.messages || (item.messages = [])).push(msg);
  touch(item);
  save();
  return item;
}

// ---- "I'm on it": claim a shared task so you don't both do it ----
export function claimItem(id, on = true) {
  const item = getItem(id);
  if (!item) return;
  item.claimedBy = on ? state.profile : null;
  item.claimedAt = on ? Date.now() : null;
  touch(item);
  save();
  return item;
}

// ---- snooze: push something out of sight until a chosen time ----
export function snoozeItem(id, untilMs) {
  const item = getItem(id);
  if (!item) return;
  item.snoozeUntil = untilMs || null;
  touch(item);
  save();
  return item;
}
export function isSnoozed(item) { return !!item.snoozeUntil && item.snoozeUntil > Date.now(); }

// ---- daily chore: a shared thing that comes back every day ----
export function setDailyChore(id, on) {
  const item = getItem(id);
  if (!item) return;
  item.loop = on ? { every: 1, auto: false, history: item.loop?.history || [] } : null;
  touch(item);
  save();
  return item;
}

// ---- daily digest / recap data ----
function localDay(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

export function finishedToday() {
  const s = startOfToday();
  return state.items.filter(i => i.status === 'done' && (i.doneAt || 0) >= s && !i.parent &&
    i.type !== 'issue' && visibleTo(i, state.profile));
}
// how many open shared things each person is holding (claim wins over scope)
export function openLoad() {
  const load = {};
  for (const i of state.items) {
    if (i.status === 'active' && !i.parent && i.type !== 'issue' && i.visibility === 'shared' && !isSnoozed(i)) {
      const who = i.claimedBy || (state.family.find(f => f.id === i.scope && f.user) ? i.scope : null);
      if (who) load[who] = (load[who] || 0) + 1;
    }
  }
  return load;
}
export function digestSeenToday() { return state.lastDigestDay === localDay(); }
export function markDigestSeen() { state.lastDigestDay = localDay(); save(); }

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

// ---------- deadline & loop gravity ----------

// The effective "needed by" moment: an explicit due date, or for loop items
// the predicted next need (last completion + learned cycle).
export function effDueMs(item) {
  if (item.due) return new Date(item.due + 'T23:59:59').getTime();
  if (item.loop?.every && item.doneAt) return item.doneAt + item.loop.every * 86400e3;
  return null;
}

export function effDueISO(item) {
  const ms = effDueMs(item);
  return ms ? new Date(ms).toISOString().slice(0, 10) : null;
}

// 0 beyond the window; ramps to +3 strata at due/overdue.
export function gravityBoost(item) {
  const ms = effDueMs(item);
  if (ms === null) return 0;
  const days = (ms - Date.now()) / 86400e3;
  if (!item.due && item.loop?.every) {
    // loop rhythm: ramp across the item's own cycle length
    return 3 * Math.max(0, Math.min(1, 1 - days / item.loop.every));
  }
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
export const normPhrase = (t) => tokens(t).join(' ');

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

// Items the sizer will actually show you as dotted/unsized bubbles. This is the
// single source of truth for the "Size N new items" prompt and the Size-tab
// badge, so the number can never disagree with what's on screen. It matches the
// universe's own filter (openUniverse in bubbles.js): not done, not a subtask,
// not a wellbeing issue, visible to you — AND still missing a priority. Using
// status==='inbox' here was the bug: an issue or subtask stays 'inbox' forever
// (the universe never surfaces it), so it produced a phantom "1 to size" with no
// bubble to size; and an item sized on a non-priority dim flips to 'active' yet
// is still a dotted bubble. Priority-unset is the honest signal.
export function inboxItems() {
  return state.items.filter(i =>
    i.status !== 'done' && !i.parent && i.type !== 'issue' &&
    visibleTo(i, state.profile) && uOf(i, 'priority') === null);
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

// ---------- Drive sync: snapshot & merge ----------
// Two payloads: 'shared' (visibility shared, goes in the household file both
// people can read) and 'private' (this profile's private items, in their own
// Drive). Media/agent guesses are stripped to keep the files small.

function slim(it) {
  const { media, agentGuess, ...rest } = it;
  return rest;
}

export function syncSnapshot(kind, me) {
  const items = {};
  for (const it of state.items) {
    const mine = it.createdBy === me;
    if (kind === 'shared' && it.visibility === 'shared') items[it.id] = slim(it);
    else if (kind === 'private' && it.visibility === 'private' && mine) items[it.id] = slim(it);
  }
  return { v: 1, items, deleted: { ...tombFor(kind) }, at: Date.now() };
}

// Record one "news" event (the other person added/finished a shared item).
// Deduped by a stable key so a popped card never returns; during the very
// first shared sync we only seed the keys (seeding) so nothing surfaces.
function pushNews(ev, seeding) {
  if (!state.newsSeen) state.newsSeen = {};
  const key = ev.kind + ':' + ev.itemId + ':' + ev.at;
  if (state.newsSeen[key]) return;
  state.newsSeen[key] = Date.now();
  if (seeding) return;
  if (!state.news) state.news = [];
  state.news.push({ ...ev, key });
}

// Decide whether an incoming shared item is news for me. prevStatus is the
// local status before the merge (undefined = the item is new to me).
function detectNews(it, prevStatus, seeding) {
  if (it.visibility !== 'shared') return;
  const me = state.profile;
  if (prevStatus === undefined) {
    if (!it.createdBy || it.createdBy === me) return;    // my own item, or unknown
    if (it.status === 'done') {
      // already finished when it reaches me: news only if someone else did it
      if (it.doneBy && it.doneBy !== me)
        pushNews({ itemId: it.id, kind: 'done', by: it.doneBy, title: it.title, note: it.doneNote || '', at: it.doneAt || it.updatedAt || 0 }, seeding);
      return;
    }
    pushNews({ itemId: it.id, kind: 'added', by: it.createdBy, title: it.title, note: '', at: it.createdAt || it.updatedAt || 0 }, seeding);
  } else if (it.status === 'done' && prevStatus !== 'done' && it.doneBy && it.doneBy !== me) {
    pushNews({ itemId: it.id, kind: 'done', by: it.doneBy, title: it.title, note: it.doneNote || '', at: it.doneAt || it.updatedAt || 0 }, seeding);
  }
}

// Surface messages the other person left on a shared item (on any item,
// including ones I created — so a reply on my own task still pings me).
function scanMessages(it, seeding) {
  const me = state.profile;
  for (const m of it.messages || []) {
    if (!m || m.by === me) continue;
    pushNews({ itemId: it.id, kind: 'message', subkind: m.kind || 'msg', by: m.by, title: it.title, note: m.text || (m.photo ? '📷 photo' : ''), at: m.at || 0 }, seeding);
  }
}

// surface when the other person claims ("I'm on it") a shared task
function scanClaim(it, prevClaim, seeding) {
  const me = state.profile;
  if (it.visibility === 'shared' && it.claimedBy && it.claimedBy !== me && it.claimedBy !== prevClaim) {
    pushNews({ itemId: it.id, kind: 'claim', by: it.claimedBy, title: it.title, note: '', at: it.claimedAt || it.updatedAt || 0 }, seeding);
  }
}

// Merge a downloaded file into local state; returns true if anything changed.
export function applySync(kind, remote) {
  if (!remote || typeof remote !== 'object') return false;
  let changed = false;
  const tomb = tombFor(kind);
  // only the shared household file carries news; seed silently the first time
  const watch = kind === 'shared';
  const seeding = watch && !state.newsInit;
  for (const [id, ts] of Object.entries(remote.deleted || {})) {
    if (!tomb[id] || ts > tomb[id]) tomb[id] = ts;
    const local = getItem(id);
    // Only ever delete an item that still belongs to THIS file's visibility.
    // Crucial: a shared-file tombstone must NOT delete a now-private item — if
    // you unshared something to keep it personal, its id is in the shared
    // tombstones, and without this guard an incoming delete would wipe your
    // private copy. Same protection the other way for the private file.
    const wantVis = kind === 'private' ? 'private' : 'shared';
    if (local && local.visibility === wantVis && (local.updatedAt || 0) <= ts) {
      state.items = state.items.filter(x => x.id !== id);
      changed = true;
    }
  }
  for (const it of Object.values(remote.items || {})) {
    if (tomb[it.id] && tomb[it.id] >= (it.updatedAt || 0)) continue; // deleted newer locally
    const local = getItem(it.id);
    if (!local) {
      state.items.push({ ...it, media: [] }); changed = true;
      if (watch) { detectNews(it, undefined, seeding); scanMessages(it, seeding); scanClaim(it, undefined, seeding); }
    } else if ((it.updatedAt || 0) > (local.updatedAt || 0)) {
      const prev = local.status, prevClaim = local.claimedBy;
      const idx = state.items.findIndex(x => x.id === it.id);
      state.items[idx] = { ...it, media: local.media || [] }; // keep local photos
      changed = true;
      if (watch) { detectNews(it, prev, seeding); scanMessages(it, seeding); scanClaim(it, prevClaim, seeding); }
    }
  }
  // prune tombstones + seen-news keys older than 90 days so the maps don't grow
  const cutoff = Date.now() - 90 * 86400e3;
  for (const [id, ts] of Object.entries(tomb)) if (ts < cutoff) delete tomb[id];
  for (const [k, ts] of Object.entries(state.newsSeen || {})) if (ts < cutoff) delete state.newsSeen[k];
  if (watch) state.newsInit = true;   // past the first sync — future changes surface
  if (changed || seeding) save();
  return changed;
}

// ---------- news (the other person's changes, waiting to be reviewed) ----------
export function newsItems() { return (state.news || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0)); }
export function reviewNews(key) { state.news = (state.news || []).filter(n => n.key !== key); save(); }
export function clearNews() { state.news = []; save(); }
export function otherUsers() { return state.family.filter(f => f.user && f.id !== state.profile); }
export function partnerName() { const o = otherUsers()[0]; return o ? o.name : 'the household'; }

export function syncConfig() { return state.sync || (state.sync = {}); }
export function saveState() { save(); }
