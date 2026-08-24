// Stratos data layer: localStorage persistence, strata, local learning.

const DB_KEY = 'stratos.v1';

// Build number — bump together with the service-worker CACHE in sw.js on
// every deploy. Shown in Settings so you can confirm your phone is current.
export const BUILD = '68';

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

export let storageFull = false;

export function save() {
  const json = JSON.stringify(state);
  try {
    localStorage.setItem(DB_KEY, json);
    storageFull = false;
  } catch (e) {
    // Out of quota. The backups are the only thing here we can afford to lose,
    // so drop them and try once more; if that still fails, raise a flag the
    // Settings screen can show rather than throwing into a caller that will
    // swallow it. Losing the write silently is the one outcome to avoid.
    try { localStorage.removeItem(BAK_KEY); } catch (e2) { /* nothing to drop */ }
    try {
      localStorage.setItem(DB_KEY, json);
      storageFull = false;
      console.warn('storage was full — local backups were dropped to make room');
      return;
    } catch (e3) {
      storageFull = true;
      console.warn('could not save: storage is full');
      return;
    }
  }
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
    label: fields.label || null,      // optional short name for bubbles
    // How much to buy. `quantity` is the display string ("400 g"); the optional
    // `quantityGrams` is a machine-readable companion so amounts can be summed
    // or compared without parsing text. Peer apps (see docs/PEER-INGEST.md)
    // depend on this being a first-class field rather than glued into the title.
    quantity: (fields.quantity || '').trim() || null,
    quantityGrams: typeof fields.quantityGrams === 'number' ? fields.quantityGrams : null,
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
  // Groceries & supplies auto-size to "Getting low" (level 4 on the restock
  // dial) so a freshly added item lands on the shopping list at a sensible
  // urgency instead of sitting "unsized". Resize any specific one via edit.
  if (item.type === 'supply' && !Object.keys(item.dims).length) {
    const rs = state.dims.restock.strata[3];   // 1-indexed level 4 = "Getting low"
    if (rs) { item.dims.restock = { s: rs.id, f: 0.5, at: Date.now() }; item.status = 'active'; }
  }
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

// ---------- shopping ----------
const shoppableItem = (i) => i.scope === 'house' && !i.parent &&
  (i.type === 'supply' || i.category === 'groceries' || i.category === 'supplies');

// Buying is more than done: the pantry is full again, so the restock dial
// snaps back to "Stocked". The previous reading is stashed so unticking
// ("didn't buy it after all") puts the dial back where it was.
export function buyItem(id, bought = true) {
  const item = getItem(id);
  if (!item) return;
  if (bought) {
    item.restockPrev = item.dims.restock || null;
    const s0 = state.dims.restock.strata[0]; // "Stocked"
    item.dims.restock = { s: s0.id, f: 0.5, at: Date.now() };
  } else if ('restockPrev' in item) {
    if (item.restockPrev) item.dims.restock = item.restockPrev;
    else delete item.dims.restock;
    delete item.restockPrev;
  }
  markDone(id, bought); // touches + saves
}

// "Commonly bought, probably out": done groceries/supplies you've bought at
// least twice whose rhythm says the pantry is likely empty again (≥80% of the
// cycle since the last buy). Items with a *learned* rhythm mostly reawaken on
// their own (tickLoops) — this tray catches the young loops (2 buys, no
// learned `every` yet) and anything else that slipped through. Most-overdue
// first, capped so it stays a gentle nudge rather than a second list.
export function shopSuggestions() {
  const now = Date.now();
  const out = [];
  for (const i of state.items) {
    if (i.status !== 'done' || !shoppableItem(i) || !visibleTo(i, state.profile)) continue;
    const hist = i.loop?.history || [];
    if (hist.length < 2 && !i.loop?.every) continue;   // bought once — not "commonly"
    let everyD = i.loop?.every;
    if (!everyD) {
      const gaps = [];
      for (let k = 1; k < hist.length; k++) gaps.push((hist[k] - hist[k - 1]) / 86400e3);
      gaps.sort((a, b) => a - b);
      everyD = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    }
    if (!everyD || everyD < 0.5) continue;
    const last = i.doneAt || hist[hist.length - 1] || 0;
    const ratio = ((now - last) / 86400e3) / everyD;
    if (ratio >= 0.8) out.push({ item: i, everyD: Math.max(1, Math.round(everyD)), daysAgo: Math.round((now - last) / 86400e3), ratio });
  }
  return out.sort((a, b) => b.ratio - a.ratio).slice(0, 8);
}

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
      // remember what was just taught so the UI can tell you (and let you undo)
      lastLearned.push({ field: k, to: v, from: item[k] || null, phrase: normPhrase(item.title) });
    }
    item[k] = v;
  }
  // if visibility flipped, tell the file it left to drop this item (no leak)
  if (fields.visibility && fields.visibility !== oldVis) {
    if (oldVis === 'shared') tombFor('shared')[id] = Date.now();
    else tombFor('private')[id] = Date.now();
    // Whoever made it private OWNS it from here. Without this, making a row
    // private that you did not create — above all a row a connected app
    // created, whose createdBy is 'app:familymix' and can never equal a
    // profile — hides it from everybody AND drops it from both sync files, so
    // the only copy left is an unreachable orphan in one phone's storage.
    if (fields.visibility === 'private') item.privateBy = state.profile;
    else item.privateBy = null;
    // A visibility change is its own decision with its own clock. The merge
    // compares these so a stale copy from a phone that hadn't heard yet can't
    // quietly undo it — see applySync.
    item.visAt = Date.now();
    // A peer must not be able to put back a row the family took private, ever
    // — not even after its tombstone ages out at 90 days on some other phone.
    if (oldVis === 'shared' && item.externalPeer && item.externalId) {
      peerRefusedMap()[item.externalPeer + ':' + item.externalId] = Date.now();
    }
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
  if (!done) { item.doneNote = null; item.doneNoteAt = null; }
  else if (note != null) {
    item.doneNote = String(note).trim() || null;
    if (item.doneNote) item.doneNoteAt = Date.now();
  }
  touch(item);
  save();
}

// Attach/replace a note to the other person on an already-finished item —
// travels with the item through sync and shows up in their review blob.
export function attachDoneNote(id, note) {
  const item = getItem(id);
  if (!item) return;
  item.doneNote = (note || '').trim() || null;
  item.doneNoteAt = item.doneNote ? Date.now() : null; // its own stamp so the note surfaces even after the completion already synced
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
// Dates reach date maths and an HTML attribute, and items arrive over sync from
// devices (and now peer apps) we don't control — so a due date is only ever
// trusted if it is literally YYYY-MM-DD.
// The shape check alone is not enough: "2026-13-45" is well-shaped and still
// not a date, and new Date() rolls "2026-02-30" over to March rather than
// failing. Round-tripping through Date catches both, so nothing downstream can
// be handed a date that turns into NaN (which is how gcalUrl used to throw and
// take the whole edit sheet with it).
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDue = (d) => {
  const s = String(d || '');
  if (!ISO_DATE.test(s)) return null;
  const t = new Date(s + 'T12:00:00Z');
  return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
};

export function effDueMs(item) {
  if (validDue(item.due)) return new Date(item.due + 'T23:59:59').getTime();
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

// what the last edit(s) taught — the UI drains this to show "✦ Learned …"
let lastLearned = [];
export function takeLastLearned() { const l = lastLearned; lastLearned = []; return l; }

export function learn(field, toks, value) {
  const L = state.learned[field] || (state.learned[field] = {});
  for (const t of toks) {
    const tv = L[t] || (L[t] = {});
    tv[value] = (tv[value] || 0) + 1;
  }
  save();
}

// The exact-phrase rules, for a human-readable "what I've learned" list.
export function learnedRules() {
  const out = [];
  for (const field of ['type', 'category', 'scope', 'visibility', 'source']) {
    const L = state.learned['_exact_' + field];
    if (!L) continue;
    for (const [phrase, value] of Object.entries(L)) out.push({ field, phrase, value });
  }
  return out.sort((a, b) => a.phrase.localeCompare(b.phrase) || a.field.localeCompare(b.field));
}
// Forget a rule: drop the exact memory AND unwind that phrase's token votes,
// so a wrong lesson can be fully corrected.
export function forgetRule(field, phrase) {
  const key = '_exact_' + field, L = state.learned[key];
  const value = L && L[phrase];
  if (L) delete L[phrase];
  if (value && state.learned[field]) {
    for (const t of tokens(phrase)) {
      const tv = state.learned[field][t];
      if (tv && tv[value]) { tv[value]--; if (tv[value] <= 0) delete tv[value]; }
      if (tv && Object.keys(tv).length === 0) delete state.learned[field][t];
    }
  }
  save();
}
export function forgetAllRules() {
  state.learned = {}; state.corrections = []; save();
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

// ---------- short labels ----------
// A bubble is a small circle: the full sentence never fits. Derive a compact
// label that keeps the verb + its object and drops the scaffolding, so
// "Call the accountant about Q3" reads as "Call accountant" on the bubble.
// (The full title still shows on the peek card, lists, and the edit sheet.)
const LABEL_DROP = new Set(['the', 'a', 'an', 'my', 'our', 'some', 'to', 'of', 'that', 'this', 'and']);
// everything from one of these onwards is context, not the thing itself
const LABEL_TAIL = /\s+\b(about|regarding|re|because|so that|before|after|by|from|with|at|on|in|for|via|via the)\b\s+/i;

export function deriveLabel(title, maxWords = 3, maxChars = 22) {
  let t = String(title || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const cut = t.split(LABEL_TAIL)[0];          // drop a trailing context clause
  if (cut && cut.split(' ').length >= 2) t = cut;
  const kept = t.split(' ').filter((w, i) => {
    const bare = w.toLowerCase().replace(/[^a-z0-9æøåäöü'-]/g, '');
    return i === 0 || !LABEL_DROP.has(bare);   // never drop the leading word
  });
  // A one-word label should be the DISTINCTIVE word, not the verb:
  // "Call the accountant" → "accountant", not "Call".
  if (maxWords === 1) {
    let pick = kept[0];
    for (const w of kept) if (w.length >= pick.length) pick = w;
    return pick.length > maxChars ? pick.slice(0, maxChars - 1) + '…' : pick;
  }
  let out = kept.slice(0, maxWords).join(' ');
  if (out.length > maxChars) {                  // still long: fewer words, then clip
    out = kept.slice(0, 2).join(' ');
    if (out.length > maxChars) out = out.slice(0, maxChars - 1).trimEnd() + '…';
  }
  return out || t;
}

// The compact name a bubble wears. An explicit label (set in the edit sheet)
// always wins; otherwise derive one from the title. Full titles live on lists,
// the peek card, and the sheet — this is only for tight spaces.
export function shortLabel(item) {
  if (!item) return '';
  const l = (item.label || '').trim();
  return l || deriveLabel(item.title || '');
}

export function memberName(id) {
  const f = state.family.find(f => f.id === id);
  if (f) return f.name;
  // Connected apps are stored as 'app:familymix' precisely so they can never
  // collide with a family id. Strip the prefix for display only.
  const s = String(id == null ? '' : id);
  return s.startsWith('app:') ? s.slice(4) : s;
}

export function visibleTo(item, profile) {
  // privateBy is who took it private, which is not always who created it — a
  // row from a connected app has no creator profile at all.
  return item.visibility !== 'private' || (item.privateBy || item.createdBy) === profile;
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
  // Only priority-ranked things (tasks/goals) need the bubble sizer. Supplies
  // are ranked by restock (auto-set) and issues by difficulty, so neither
  // belongs in the "needs sizing" count or the priority sky. Also honours the
  // Life/Work view so the count matches what the sky actually shows.
  return state.items.filter(i =>
    i.status !== 'done' && !i.parent && (i.type === 'task' || i.type === 'goal') &&
    visibleTo(i, state.profile) && uOf(i, 'priority') === null && inWorkView(i));
}

// ---------- Life / Work view (shared across Lists and Size) ----------
// One toggle, so the two screens always agree: Life hides Work, Work shows
// only Work. Not persisted — resets to Life each session.
let workView = 'life';
export const getWorkView = () => workView;
export function setWorkView(v) { workView = v === 'work' ? 'work' : 'life'; }
export const isWorkCat = (i) => { const c = (i.category || '').toLowerCase(); return c === 'work' || c === 'work tasks'; };
export const inWorkView = (i) => (workView === 'work' ? isWorkCat(i) : !isWorkCat(i));
// any Work still to size/see, so the toggle can hide itself when irrelevant
export function hasWorkItems() {
  return state.items.some(i => isWorkCat(i) && i.status !== 'done' && visibleTo(i, state.profile));
}

export function exportJSON() { return JSON.stringify(state, null, 2); }

export function importJSON(text) {
  const parsed = JSON.parse(text); // throws if invalid
  if (!parsed.items || !parsed.dims) throw new Error('not a Stratos export');
  state = parsed;
  // The export carries this phone's sync slot name. Importing it onto a SECOND
  // phone — which is exactly what Settings suggests export/import for — would
  // give both phones the same slot, so each would overwrite the other's
  // snapshot in the household file for ever while Settings cheerfully reported
  // "0 other devices". A slot is per-device; mint a new one on the next sync.
  if (state.sync) delete state.sync.deviceId;
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
    const mine = (it.privateBy || it.createdBy) === me;
    if (kind === 'shared' && it.visibility === 'shared') items[it.id] = slim(it);
    else if (kind === 'private' && it.visibility === 'private' && mine) items[it.id] = slim(it);
  }
  const snap = { v: 1, items, deleted: { ...tombFor(kind) }, at: Date.now() };
  if (kind === 'shared') {
    snap.packing = packSnapshot();          // packing rides the shared file
    snap.inboxAck = { ...peerAckMap() };    // how far each peer's inbox is consumed
    snap.inboxAdopt = { ...peerAdoptMap() }; // where merged peer lines ended up
    snap.inboxRefused = { ...peerRefusedMap() }; // lines the family took private
  }
  return snap;
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
const isFamilyMember = (id) => state.family.some(f => f.id === id);

function detectNews(it, prevStatus, seeding) {
  if (it.visibility !== 'shared') return;
  const me = state.profile;
  if (prevStatus === undefined) {
    if (!it.createdBy || it.createdBy === me) return;    // my own item, or unknown
    // Items from a peer app arrive a dozen at a time (a week's groceries).
    // applySync counts those and raises ONE summary card instead.
    if (!isFamilyMember(it.createdBy)) return;
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

// Surface a completion NOTE added after the fact. The plain "done" event only
// fires on the active→done transition; if the other person finishes a task
// (which syncs) and THEN leaves a note, my copy is already done, so that path
// stays silent. This catches the note on its own — keyed by doneNoteAt so it
// never collides with the completion card and re-notifies if the note is edited.
function scanDoneNote(it, prevStatus, prevNote, seeding) {
  const me = state.profile;
  if (it.visibility !== 'shared' || it.status !== 'done' || !it.doneNote) return;
  if (it.doneBy && it.doneBy === me) return;      // my own note
  if (prevStatus !== 'done') return;              // fresh completion already carried the note
  if (it.doneNote === prevNote) return;           // note unchanged
  pushNews({ itemId: it.id, kind: 'done', by: it.doneBy || null, title: it.title, note: it.doneNote, at: it.doneNoteAt || it.updatedAt || 0 }, seeding);
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
  // A peer inbox is not a device snapshot — hsync drains it separately. Bail
  // out here so a peer payload can never be merged as if it were items.
  if (remote.kind === 'inbox') return false;
  let changed = false;
  let peerAdds = 0, peerAt = 0, peerFrom = '';
  const tomb = tombFor(kind);
  // only the shared household file carries news; seed silently the first time
  const watch = kind === 'shared';
  const seeding = watch && !state.newsInit;
  const notFuture = Date.now() + 5 * 60e3;   // small allowance for clock skew
  for (const [id, rawTs] of Object.entries(remote.deleted || {})) {
    const ts = Math.min(Number(rawTs) || 0, notFuture);
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
      state.items.push({ ...it, due: validDue(it.due), media: [] }); changed = true;
      if (watch && it.visibility === 'shared' && it.createdBy && !isFamilyMember(it.createdBy)) {
        // Key the summary card on the BATCH time (ingest stamps it as
        // createdAt), not on this snapshot's time — so the card the ingesting
        // phone already raised and this one are the same card, not two.
        peerAdds++;
        peerAt = Math.max(peerAt, it.createdAt || 0);
        peerFrom = peerFrom || memberName(it.createdBy);   // 'familymix', same wording as the ingest card
      }
      if (watch) { detectNews(it, undefined, seeding); scanMessages(it, seeding); scanClaim(it, undefined, seeding); }
    } else if ((it.updatedAt || 0) > (local.updatedAt || 0)) {
      // A visibility change is its own last-writer-wins, on its own clock. The
      // tombstone loop above already refuses to delete across a visibility
      // change; this loop was replacing across one, which is the same bug with
      // a worse ending: an incoming SHARED copy would overwrite a row this
      // phone had made PRIVATE — putting it back on the household list and
      // taking its content with it — purely because some other phone touched
      // the row before it heard about the unshare. Newer content must not beat
      // a newer decision about who may see it.
      if (local.visibility !== it.visibility && (local.visAt || 0) > (it.visAt || 0)) continue;
      const prev = local.status, prevClaim = local.claimedBy, prevNote = local.doneNote;
      const idx = state.items.findIndex(x => x.id === it.id);
      state.items[idx] = { ...it, due: validDue(it.due), media: local.media || [] }; // keep local photos
      changed = true;
      if (watch) { detectNews(it, prev, seeding); scanDoneNote(it, prev, prevNote, seeding); scanMessages(it, seeding); scanClaim(it, prevClaim, seeding); }
    }
  }
  // Adopt the highest watermark anyone has reached. A future value is IGNORED,
  // not clamped: clamping to Date.now() re-parks our own watermark at "now" on
  // every single merge, and "now" always sits above a live batch's `at`, so one
  // bad slot would silently kill peer ingest on this phone for ever while it
  // published an ack claiming everything had been consumed. Ingest refuses
  // future-dated batches at the source, so dropping these is free.
  if (kind === 'shared' && remote.inboxAck && typeof remote.inboxAck === 'object') {
    const ack = peerAckMap();
    for (const [p, ts] of Object.entries(remote.inboxAck)) {
      const n = Number(ts) || 0;
      if (n > notFuture) continue;
      if (n > (ack[p] || 0)) { ack[p] = n; changed = true; }
    }
  }
  // "do not let this app see this again" travels between phones and never expires
  if (kind === 'shared' && remote.inboxRefused && typeof remote.inboxRefused === 'object') {
    const ref = peerRefusedMap();
    for (const [k, ts] of Object.entries(remote.inboxRefused)) {
      const n = Math.min(Number(ts) || 0, notFuture);
      if (n && !ref[k]) { ref[k] = n; changed = true; }
    }
  }
  // one card for a whole peer delivery, not one per grocery
  if (peerAdds) {
    const pat = peerAt || remote.at || Date.now();
    pushNews({ itemId: 'peer:' + pat, kind: 'peer', by: null,
      title: peerAdds + ' item' + (peerAdds === 1 ? '' : 's') + ' from ' + (peerFrom || 'a connected app'),
      note: 'Added to the shopping list', at: pat }, seeding);
  }
  // packing lists ride the shared file too — merge them with their own
  // per-item newest-wins so both phones can pack a trip together
  if (kind === 'shared' && remote.packing) changed = applyPackSync(remote.packing) || changed;
  // prune tombstones + seen-news keys older than 90 days so the maps don't grow
  const cutoff = Date.now() - 90 * 86400e3;
  // Repair, not just reject: clamping only what arrives on the wire leaves any
  // far-future tombstone ALREADY in local state sitting there for ever — it
  // never falls inside the prune window, so the item it names can never come
  // back. Pull those forward so the next prune can clear them.
  for (const [id, ts] of Object.entries(tomb)) if (ts > notFuture) tomb[id] = notFuture;
  for (const [id, ts] of Object.entries(tomb)) if (ts < cutoff) delete tomb[id];
  // Adopt the other phone's adoption records only AFTER the prune. Before it,
  // the test "would I prune this again?" was reading a tombstone this very call
  // had just re-inserted from remote.deleted — so an entry whose row is long
  // gone looked worth keeping, got re-adopted, was pruned three lines later,
  // and came back on the next sync: changed=true for ever, which the app turns
  // into a self-sustaining four-second sync loop.
  if (kind === 'shared') {
    const adopt = peerAdoptMap();
    for (const [k, v] of Object.entries(remote.inboxAdopt || {})) {
      if (typeof v !== 'string' || adopt[k]) continue;
      const row = getItem(v);
      if (!row && !tomb[v]) continue;                  // nothing left to protect
      if (row && row.visibility !== 'shared') continue; // not ours to know about
      adopt[k] = v; changed = true;
    }
    pruneAdoptMap(tomb);
  }
  for (const [k, ts] of Object.entries(state.newsSeen || {})) if (ts < cutoff) delete state.newsSeen[k];
  if (watch) state.newsInit = true;   // past the first sync — future changes surface
  if (changed || seeding) save();
  return changed;
}

// ---------- peer ingest: a supported way for other apps to add items ----------
// Full contract: docs/PEER-INGEST.md
//
// A peer app (FamilyMix plans the week's meals, so it knows the exact grocery
// quantities before anyone leaves the house) writes ONE reserved slot in the
// household sync store — an "inbox" — encrypted with the household key like
// everything else.
//
// THE INBOX IS SINGLE-WRITER. Stratos reads it and never writes it. An earlier
// design had each client blank the slot after ingesting ("drain"), but the
// Apps Script offers no compare-and-swap, so a batch written between a client's
// read and its blanking write was silently destroyed — the peer would believe
// delivery succeeded and the family would simply never see those items.
//
// Instead each client keeps a WATERMARK per peer and ingests a batch only when
// batch.at is newer than the watermark. A standing inbox is therefore consumed
// exactly once per device, no writes race, and the peer learns what landed from
// the `inboxAck` each device publishes in its own snapshot. The watermark rides
// the shared snapshot too, so a phone that joins later inherits it instead of
// re-ingesting a batch the family already dealt with.
//
// Ingest additionally refuses to reopen anything already done or deleted, so
// correctness never rests on the watermark alone.

export const isPeerInboxSlot = (dev) => /^inbox/i.test(String(dev || ''));
export function peerAckMap() { return state.peerAck || (state.peerAck = {}); }
// externalId -> the id of the item it actually lives on, for the case where a
// peer line merged into a row the family had already added by hand. Without it
// the peer's px_ id and the family's row are two names for one thing, and a
// delete of the row would not stop the next batch re-creating it.
export function peerAdoptMap() { return state.peerAdopt || (state.peerAdopt = {}); }
// '<slot>:<externalId>' -> when the family took that line private. This is the
// one refusal that is NOT on the 90-day tombstone clock: a deletion is allowed
// to age out, but "I do not want this app to see this" has to hold for good, or
// the contract's promise that unsharing puts a row permanently beyond a peer is
// only true until some other phone's tombstone prunes and re-mints the row.
export function peerRefusedMap() { return state.peerRefused || (state.peerRefused = {}); }

// Keep the adoption map bounded. Two kinds of entry are dead:
//   - the row is gone AND its tombstone has aged out — there is nothing left to
//     protect, so the record can go with it;
//   - the row is alive but no longer carries that externalId — the family
//     cleared it, or a different line took it over, so the record is stale.
// What remains is one entry per LIVE merged row, which is bounded by the size
// of the family's own list rather than by how long the integration has run.
function pruneAdoptMap(tomb) {
  const adopt = peerAdoptMap();
  for (const [k, itemId] of Object.entries(adopt)) {
    const row = getItem(itemId);
    if (!row) { if (!tomb[itemId]) delete adopt[k]; continue; }
    // A row the family made private is no longer the peer's business — and the
    // map is published in the shared file, so leaving the entry there tells the
    // app its line is still alive on a list it can no longer see.
    if (row.visibility !== 'shared') { delete adopt[k]; continue; }
    const eid = k.slice(k.indexOf(':') + 1);
    if (row.externalId !== eid) delete adopt[k];
  }
}

// applySync only runs for OTHER devices' slots, so a household with a single
// phone would never prune anything at all. hsync calls this on every sync.
export function pruneSyncMaps() {
  // Past the first sync. This lives here rather than only in applySync because
  // applySync runs solely for OTHER devices' slots: in a household with one
  // phone it never ran at all, so newsInit stayed false for ever and every peer
  // delivery card was swallowed by the first-sync seeding path.
  state.newsInit = true;
  const cutoff = Date.now() - 90 * 86400e3;
  const notFuture = Date.now() + 5 * 60e3;
  for (const kind of ['shared', 'private']) {
    const tomb = tombFor(kind);
    for (const [id, ts] of Object.entries(tomb)) if (ts > notFuture) tomb[id] = notFuture;
    for (const [id, ts] of Object.entries(tomb)) if (ts < cutoff) delete tomb[id];
  }
  for (const [k, ts] of Object.entries(state.newsSeen || {})) if (ts < cutoff) delete state.newsSeen[k];
  pruneAdoptMap(tombFor('shared'));
}

// A peer's identity is its SLOT NAME, never anything inside the payload. The
// Apps Script decides and sanitises the slot key; the `peer` field in a batch
// is self-declared and therefore worthless as an identity — two apps that both
// call themselves "familymix" must not share a watermark, an id space, or a
// byline. Everything below keys off the slot.
export const peerSlotId = (dev) => clip(dev, 64).toLowerCase().replace(/[^a-z0-9]/g, '') || 'peer';
// The byline shown to the family. Prefixed 'app:' so a peer that names its slot
// "inboxanna" still can't be mistaken for Anna: isFamilyMember() stays false and
// memberName() strips the prefix for display only.
export const peerByline = (slot) => 'app:' + (slot.replace(/^inbox/, '') || slot);

// FNV-1a: a small deterministic hash so every device derives the SAME Stratos
// id from a peer's externalId. Two phones ingesting the same batch therefore
// mint identical ids and the ordinary newest-wins merge collapses them instead
// of leaving the family with two of everything.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
// Always prefixed 'px_' and namespaced by the peer's slot. uid() only ever mints
// 'i<seq>_<base36>', so the two id spaces cannot overlap: a peer can never
// address — let alone rewrite — an item the family created, whatever externalId
// it chooses. Folding the slot into the hash means two peer apps that pick the
// same externalId get separate items instead of fighting over one.
export function peerItemId(peerSlot, externalId) {
  const slot = peerSlotId(peerSlot);
  const e = String(externalId);
  // ':' is a safe hash separator because a slot is [a-z0-9] only, so
  // (slot, externalId) can never be re-split ambiguously into another pair.
  return 'px_' + slot.slice(0, 16) + '_' + e.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) +
    '_' + hash32(slot + ':' + e);
}

// Only strings and numbers are accepted — anything else (object, array, boolean)
// becomes '' rather than being stringified, so a peer can't smuggle
// "[object Object]" into a title or "400,500,600" into an amount by sending the
// wrong JSON type for a field.
//
// The strip covers more than C0: U+0085 and the C1 block are controls too, and
// the bidi overrides (U+202E and friends) are a display-spoofing primitive —
// one of those in a title reverses the rendering of the rest of the shopping
// row. Zero-width and BOM go with them, since they are invisible by definition
// and only ever arrive here by accident or on purpose.
// Whitespace is collapsed BEFORE the length cap, so the cap counts characters
// the family will actually see.
const PEER_STRIP = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const clip = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
  .replace(PEER_STRIP, '').replace(/\s+/g, ' ').trim().slice(0, n);

// Fields a peer may influence. Everything else is Stratos's to decide and is
// forced here rather than trusted — a peer must not be able to tick things off,
// reorder the family's list, or reach into their private items.
function peerNormalize(raw) {
  const text = clip(raw.text || raw.title || raw.name, 200).replace(/\s+/g, ' ');
  if (!text) return null;
  const type = raw.type === 'task' ? 'task' : 'supply';
  const scope = state.family.some(f => f.id === raw.scope) ? raw.scope : 'house';
  const category = clip(raw.category, 40).toLowerCase() || (type === 'supply' ? 'groceries' : 'errands');
  // a JSON number, not "400" and not { amount: 400 } — a peer that sends the
  // wrong type gets no grams rather than a coerced guess
  const grams = typeof raw.quantityGrams === 'number' ? raw.quantityGrams : NaN;
  // A date is the one peer-settable value that reaches an HTML attribute, so it
  // is clipped to a plain string and format-checked here as well as escaped at
  // the sink. What we store is the checked string, never the caller's object.
  // Clipped generously and THEN checked whole — clipping to 10 would truncate
  // `2026-01-01" onfocus=...` into a date that passes, which is exactly backwards.
  const neededOn = validDue(clip(raw.neededOn, 40));
  return {
    title: text.replace(/^(.)/, c => c.toUpperCase()),
    quantity: clip(raw.quantity, 40) || null,
    quantityGrams: Number.isFinite(grams) && grams > 0 ? grams : null,
    type, scope, category,
    notes: clip(raw.note || raw.notes, 500),
    source: clip(raw.source, 40) || null,
    neededOn,
  };
}

const PEER_BATCH_MAX = 200;   // a runaway peer must not be able to inflate state

// Ingest one peer batch. Returns
// { added, updated, skipped, dropped, ignoredBatch, reason }.
// Never throws on a malformed entry — a peer's bad line must not be able to
// stop the family's sync. `slot` is the inbox slot name, which is the peer's
// only identity here (see peerSlotId).
export function ingestPeerItems(slot, list, batchAt) {
  const peerId = peerSlotId(slot);
  const res = { added: 0, updated: 0, skipped: 0, dropped: 0, ignoredBatch: false, reason: null };
  if (!Array.isArray(list)) { res.ignoredBatch = true; res.reason = 'inbox is not a list'; return res; }

  // Watermark: a batch is consumed once per device. Re-reading the same
  // standing inbox on every sync is therefore free, and a replayed older batch
  // is refused outright. `at` is required — without it there is nothing to
  // watermark against, so we refuse the batch loudly instead of re-ingesting it
  // on every sync for ever.
  const ack = peerAckMap();
  const now = Date.now();
  const at = Number(batchAt) || 0;
  if (!(at > 0)) { res.ignoredBatch = true; res.reason = 'batch has no usable "at" timestamp'; return res; }
  // Refused, not clamped. One batch stamped the year 2087 would otherwise park
  // the watermark in the far future and shut the peer channel for this
  // household permanently. Clamping instead would be quietly worse: the peer
  // would read back an ack lower than the `at` it sent and re-send for ever,
  // never learning why. Refusing tells it something is wrong with its clock.
  if (at > now + 5 * 60e3) {
    res.ignoredBatch = true;
    res.reason = 'batch "at" is in the future — check the sending clock';
    return res;
  }
  if (at <= (ack[peerId] || 0)) { res.ignoredBatch = true; res.reason = 'already consumed'; return res; }

  // Refuse an oversized batch WHOLE rather than taking the first 200 and acking
  // the lot. Truncate-and-ack is the one behaviour that loses data silently:
  // the peer reads the watermark, believes all 250 landed, prunes its outbox,
  // and the tail is gone for ever. Refusing leaves the watermark where it was,
  // so the peer's own delivery check tells it to re-send in smaller batches.
  if (list.length > PEER_BATCH_MAX) {
    res.ignoredBatch = true;
    res.dropped = list.length;
    res.reason = 'batch of ' + list.length + ' refused — send at most ' + PEER_BATCH_MAX + ' items per batch';
    return res;
  }

  // Validate the WHOLE batch before touching anything. A batch is atomic: if
  // any line is malformed we ingest none of it and leave the watermark alone.
  // The alternative — skip the bad lines, ack the batch — is the same silent
  // loss as truncate-and-ack: the peer reads a successful ack, prunes its
  // outbox, and the dropped lines are gone with nobody the wiser. There is no
  // per-item feedback channel back to a peer, so all-or-nothing is the only
  // shape in which the ack can mean what §4 of the contract says it means.
  const prepared = [];
  for (let n = 0; n < list.length; n++) {
    const raw = list[n];
    const externalId = raw && typeof raw === 'object' ? clip(raw.externalId, 120) : '';
    const norm = externalId ? peerNormalize(raw) : null;
    if (!norm) {
      res.ignoredBatch = true;
      res.dropped = list.length;
      res.reason = 'item ' + (n + 1) + ' of ' + list.length +
        ' is malformed (needs a non-empty externalId and text) — batch refused';
      return res;
    }
    prepared.push([externalId, norm]);
  }

  const tomb = tombFor('shared');
  const adopt = peerAdoptMap();

  for (const [externalId, norm] of prepared) {
    const id = peerItemId(peerId, externalId);

    // A line the peer pushed may not live under its px_ id at all: the twin
    // path below merges it into a row the family had already written by hand.
    // Both names have to be checked, for the refusals and for the lookup.
    const adoptKey = peerId + ':' + externalId;
    const adoptedId = adopt[adoptKey];

    // --- refusals: never bring something back from the dead ---
    if (peerRefusedMap()[adoptKey]) { res.skipped++; continue; }   // taken private, for good
    if (tomb[id] || (adoptedId && tomb[adoptedId])) { res.skipped++; continue; }   // deleted here
    // Both lookups take the SAME visibility guard. A peer may only ever touch
    // the shared household surface, and unsharing a row has to put it beyond a
    // peer permanently — not merely until its shared tombstone ages out of the
    // 90-day prune window, after which a re-push would land squarely on it.
    // This applies to a row the peer minted itself just as much as to a family
    // row it merged into: once the family makes it private it is theirs.
    //
    // Three ways this line may already be on the list, in order of certainty:
    // the px_ row we minted; the row the adopt map says we merged into; or —
    // when that map has been pruned or never reached this phone — a row still
    // carrying our own (externalId, externalPeer) stamp. The third is what
    // stops a phone without the map minting a duplicate beside a row that is
    // already ours.
    const minted = getItem(id);
    const adopted = adoptedId ? getItem(adoptedId) : null;
    const rebound = minted || adopted ? null :
      state.items.find(i => i.externalId === externalId && i.externalPeer === peerId);
    const local = minted || adopted || rebound;
    if (local && local.visibility !== 'shared') { res.skipped++; continue; }
    if (local && local.status === 'done') { res.skipped++; continue; }  // already bought
    if (rebound) adopt[adoptKey] = rebound.id;      // put the record back

    if (local) {
      // Same item pushed again with a corrected amount. Update only what the
      // peer owns; the family's own edits — sizing, source, claim, snooze —
      // are left completely alone. The TITLE is only the peer's to correct on a
      // row the peer itself minted: if this is the family's own row that a peer
      // batch merged into, they named it, and a re-push must not rename it.
      //
      // Absent means "no opinion", never "clear it". A correction batch that
      // omits `quantity` must not blank an amount — least of all one the family
      // typed onto their own row. Peers add and correct; they never erase.
      //
      // On a row the FAMILY wrote, the peer may fill a blank and may correct a
      // value it put there itself — but it must not overwrite one a human
      // changed. Without that distinction the "only if still empty" rule at the
      // merge lasts exactly one push: the standing outstanding set §4 tells
      // peers to re-send would silently revert an amount Anna typed by hand,
      // every week, with no change on the peer's side at all. Comparing against
      // what the peer last wrote (peerLast) tells the two cases apart. On a row
      // Stratos minted for the peer, corrections apply outright — it is theirs.
      let dirty = false;
      const last = local.peerLast || (local.peerLast = {});
      const set = (k, v) => {
        if (v == null || local[k] === v) return;
        // family's row, and the value there is not the one we left → theirs
        if (!minted && local[k] != null && local[k] !== last[k]) return;
        local[k] = v; dirty = true;
      };
      if (minted && norm.title && local.title !== norm.title) { local.title = norm.title; dirty = true; }
      set('quantity', norm.quantity);
      set('quantityGrams', norm.quantityGrams);
      set('due', norm.neededOn);
      // remember what we pushed, whether or not it was applied
      last.quantity = norm.quantity; last.quantityGrams = norm.quantityGrams; last.due = norm.neededOn;
      if (dirty) { touch(local); res.updated++; } else res.skipped++;
      continue;
    }

    // Not on the list under the peer's id — but the family may already have it
    // by hand ("mælk"). Attach the amount to that rather than adding a second
    // line. Both devices resolve to the same existing item, so this converges.
    //
    // The visibility guard is the important one: without it a peer that guesses
    // a phrase could write into a PRIVATE item — one it must never be able to
    // see, let alone edit. A peer may only ever touch the shared household
    // surface. We also stay off items that already belong to a peer: px_ rows
    // are another app's to correct, and a row already carrying an externalId is
    // claimed — matching on the bare string would let one app reach a row a
    // different app adopted, since externalIds are not namespaced between apps.
    //
    // The claim is recorded ON THE ROW (externalPeer), not only in the
    // device-local adopt map — see the rebound lookup above. A row already
    // carrying someone's externalId is therefore never a candidate here: this
    // path is only ever for a row nobody has claimed yet.
    //
    // normPhrase drops tokens of two characters or fewer, so a short name like
    // "Æg" normalises to nothing. Falling back to the plain lowercased title
    // keeps those matching instead of silently adding a second row beside the
    // family's.
    const phrase = normPhrase(norm.title) || norm.title.trim().toLowerCase();
    const samePhrase = (t) => (normPhrase(t) || String(t || '').trim().toLowerCase()) === phrase;
    // Lowest id among the candidates, not "first in the array". Two phones hold
    // state.items in different orders, so `find` would let them pick different
    // rows for the same line and stamp the same externalId on both, with no way
    // back. Sorting by id makes the choice identical everywhere.
    const twin = !phrase ? null : state.items
      .filter(i => i.visibility === 'shared' && !String(i.id).startsWith('px_') && !i.externalId &&
        !i.parent && i.status !== 'done' && i.scope === norm.scope &&
        i.type === norm.type && samePhrase(i.title))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (twin) {
      adopt[adoptKey] = twin.id;      // remember where this line ended up
      let dirty = false;
      if (norm.quantity && !twin.quantity) { twin.quantity = norm.quantity; dirty = true; }
      if (norm.quantityGrams && !twin.quantityGrams) { twin.quantityGrams = norm.quantityGrams; dirty = true; }
      // Stamp BOTH, together: the externalId without the owning slot is what
      // let a second app reach this row by guessing the same string.
      if (!twin.externalId) { twin.externalId = externalId; twin.externalPeer = peerId; dirty = true; }
      // what we left on their row, so a later push can tell its own value from
      // one the family has since changed
      twin.peerLast = { quantity: twin.quantity, quantityGrams: twin.quantityGrams, due: twin.due };
      // Nothing new to add: don't touch() it, or every sync would bump
      // updatedAt and republish the whole item to the other phone for ever.
      if (dirty) { touch(twin); res.updated++; } else res.skipped++;
      continue;
    }

    const item = {
      id,
      createdAt: at || now,
      updatedAt: now,
      createdBy: peerByline(peerId),   // 'app:familymix' — never a family id
      externalId,
      externalPeer: peerId,            // which app owns this line, on the row itself
      raw: norm.title,
      title: norm.title,
      label: null,
      quantity: norm.quantity,
      quantityGrams: norm.quantityGrams,
      type: norm.type,
      scope: norm.scope,
      category: norm.category,
      visibility: 'shared',            // forced: an inbox is a household surface
      due: norm.neededOn,              // "needed on" is a due date in Stratos terms
      source: norm.source,
      loop: null,
      parent: null,                    // forced: peers cannot nest into family trees
      notes: norm.notes,
      media: [],
      dims: {},
      status: 'active',
    };
    // supplies land at "Getting low" like any other, so they reach the shopping
    // list at a sensible urgency instead of sitting unsized
    if (item.type === 'supply') {
      const rs = state.dims.restock.strata[3];
      if (rs) item.dims.restock = { s: rs.id, f: 0.5, at: now };
    }
    state.items.push(item);
    res.added++;
  }

  ack[peerId] = at;                    // consumed — never ingest this batch again

  // Tell the family a delivery arrived. applySync raises the same card for a
  // phone that learned about the batch second-hand (it inherits the watermark
  // before it ever reads the inbox, so it never ingests) — both paths key the
  // card on the batch time, so whichever gets there first wins and there is
  // exactly one card per delivery.
  if (res.added) {
    pushNews({ itemId: 'peer:' + at, kind: 'peer', by: null,
      title: res.added + ' item' + (res.added === 1 ? '' : 's') + ' from ' + peerByline(peerId).slice(4),
      note: 'Added to the shopping list', at }, !state.newsInit);
  }
  save();
  return res;
}

// ---------- news (the other person's changes, waiting to be reviewed) ----------
export function newsItems() { return (state.news || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0)); }
export function reviewNews(key) { state.news = (state.news || []).filter(n => n.key !== key); save(); }
export function clearNews() { state.news = []; save(); }
export function otherUsers() { return state.family.filter(f => f.user && f.id !== state.profile); }
export function partnerName() { const o = otherUsers()[0]; return o ? o.name : 'the household'; }

export function syncConfig() { return state.sync || (state.sync = {}); }
export function saveState() { save(); }

// ---------- packing lists ----------
// Two shapes: reusable *templates* (the core list you brain-dump into and edit
// as the kids grow) and *trips* — a checklist instance spun off a template that
// you tick as you pack and can still add to. Trips are kept after the trip so
// you always have the old lists. Lives in state so it's backed up, exported,
// and imported with everything else — and it rides the shared household file,
// so both phones share lists and can pack a trip together (see packSnapshot /
// applyPackSync, with per-item newest-wins so simultaneous checks both stick).
function packStore() {
  if (!state.packing) state.packing = { templates: [], trips: [] };
  if (!state.packing.templates) state.packing.templates = [];
  if (!state.packing.trips) state.packing.trips = [];
  if (!state.packing.del) state.packing.del = {};   // list-level tombstones (id -> ts)
  return state.packing;
}
function pkId(p) { return p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36); }
function splitLines(text) { return String(text || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean); }
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// per-item timestamps let two phones pack the same trip and merge correctly:
// `c` is a stable creation order (never changes), `at` is last-touched, `ord`
// is the sort position (defaults to creation order; changed by drag / A–Z).
function newPackItem(text, checked, group) { const now = Date.now(); return { id: pkId('ki'), text, checked: !!checked, group: group || null, c: now, at: now, ord: now }; }
function listDel(l) { return l.del || (l.del = {}); }
const ordOf = (i) => (i.ord != null ? i.ord : (i.c != null ? i.c : 0));

export function packTemplates() {
  return packStore().templates.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
export function packTrips() {
  return packStore().trips.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
export function getTemplate(id) { return packStore().templates.find(t => t.id === id) || null; }
export function getTrip(id) { return packStore().trips.find(t => t.id === id) || null; }

export function addTemplate(name) {
  const t = { id: pkId('pt'), name: (name || '').trim() || 'Packing list', items: [], del: {}, createdAt: Date.now(), updatedAt: Date.now() };
  packStore().templates.push(t); save(); return t;
}
export function renameTemplate(id, name) {
  const t = getTemplate(id); if (!t) return;
  t.name = (name || '').trim() || t.name; t.updatedAt = Date.now(); save();
}
export function deleteTemplate(id) {
  const P = packStore();
  P.templates = P.templates.filter(t => t.id !== id); P.del[id] = Date.now(); save();
}
// Append one or many items (newline/comma separated), skipping ones already
// present so re-dumping the core list doesn't duplicate it.
export function addTemplateItems(id, text) {
  const t = getTemplate(id); if (!t) return 0;
  const have = new Set(t.items.map(i => norm(i.text)));
  let n = 0;
  for (const line of splitLines(text)) {
    if (have.has(norm(line))) continue;
    have.add(norm(line)); t.items.push(newPackItem(line)); n++;
  }
  if (n) { t.updatedAt = Date.now(); save(); }
  return n;
}
export function editTemplateItem(id, itemId, text) {
  const t = getTemplate(id); if (!t) return;
  const it = t.items.find(i => i.id === itemId); if (!it) return;
  const v = (text || '').trim();
  if (!v) { t.items = t.items.filter(i => i.id !== itemId); listDel(t)[itemId] = Date.now(); }
  else { it.text = v; it.at = Date.now(); }
  t.updatedAt = Date.now(); save();
}
export function removeTemplateItem(id, itemId) {
  const t = getTemplate(id); if (!t) return;
  t.items = t.items.filter(i => i.id !== itemId); listDel(t)[itemId] = Date.now();
  t.updatedAt = Date.now(); save();
}

// Spin a trip checklist off a template (or off nothing, for a blank list).
export function startTrip(templateId, name) {
  const tpl = templateId ? getTemplate(templateId) : null;
  const items = (tpl ? tpl.items : []).map(i => newPackItem(i.text, false, i.group)); // groups carry over
  const trip = {
    id: pkId('tr'), name: (name || '').trim() || (tpl ? tpl.name : 'Trip'),
    templateId: tpl ? tpl.id : null, items, del: {}, done: false,
    createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
  };
  packStore().trips.push(trip); save(); return trip;
}
export function renameTrip(id, name) {
  const t = getTrip(id); if (!t) return;
  t.name = (name || '').trim() || t.name; t.updatedAt = Date.now(); save();
}
export function toggleTripItem(id, itemId, on) {
  const t = getTrip(id); if (!t) return;
  const it = t.items.find(i => i.id === itemId); if (!it) return;
  it.checked = on === undefined ? !it.checked : !!on;
  it.at = Date.now(); t.updatedAt = Date.now(); save();
}
export function addTripItems(id, text) {
  const t = getTrip(id); if (!t) return 0;
  const have = new Set(t.items.map(i => norm(i.text)));
  let n = 0;
  for (const line of splitLines(text)) {
    if (have.has(norm(line))) continue;
    have.add(norm(line)); t.items.push(newPackItem(line, false)); n++;
  }
  if (n) { t.updatedAt = Date.now(); save(); }
  return n;
}
export function editTripItem(id, itemId, text) {
  const t = getTrip(id); if (!t) return;
  const it = t.items.find(i => i.id === itemId); if (!it) return;
  const v = (text || '').trim();
  if (!v) { t.items = t.items.filter(i => i.id !== itemId); listDel(t)[itemId] = Date.now(); }
  else { it.text = v; it.at = Date.now(); }
  t.updatedAt = Date.now(); save();
}
export function removeTripItem(id, itemId) {
  const t = getTrip(id); if (!t) return;
  t.items = t.items.filter(i => i.id !== itemId); listDel(t)[itemId] = Date.now();
  t.updatedAt = Date.now(); save();
}
export function setTripDone(id, done) {
  const t = getTrip(id); if (!t) return;
  t.done = !!done; t.doneAt = done ? Date.now() : null; t.updatedAt = Date.now(); save();
}
export function deleteTrip(id) {
  const P = packStore();
  P.trips = P.trips.filter(t => t.id !== id); P.del[id] = Date.now(); save();
}
// Push a trip item back into its source template so next time it's already
// there (e.g. you realized you always need it). No-op without a template.
export function saveTripItemToTemplate(tripId, itemId) {
  const t = getTrip(tripId); if (!t || !t.templateId) return false;
  const it = t.items.find(i => i.id === itemId); if (!it) return false;
  return addTemplateItems(t.templateId, it.text) > 0;
}
// Reuse a past trip as a fresh checklist (everything unchecked again).
export function reuseTrip(id, name) {
  const src = getTrip(id); if (!src) return null;
  const trip = {
    id: pkId('tr'), name: (name || '').trim() || src.name,
    templateId: src.templateId, done: false, del: {},
    items: src.items.map(i => newPackItem(i.text, false, i.group)), // groups carry over
    createdAt: Date.now(), updatedAt: Date.now(), doneAt: null,
  };
  packStore().trips.push(trip); save(); return trip;
}

// Reorder: assign each listed item its position as `ord` (bumping `at` so the
// new order wins in a merge). Only the ids passed are repositioned — for a trip
// that's the to-pack items; checked ones keep their place.
export function setPackListOrder(kind, id, orderedIds) {
  const l = kind === 'template' ? getTemplate(id) : getTrip(id);
  if (!l) return;
  const pos = new Map(orderedIds.map((x, i) => [x, i]));
  const now = Date.now();
  let changed = false;
  for (const it of l.items) {
    if (!pos.has(it.id)) continue;
    const nx = pos.get(it.id);
    if (it.ord !== nx) { it.ord = nx; it.at = now; changed = true; }
  }
  if (changed) { l.updatedAt = now; save(); }
  return changed;
}
// Put an item into a named group (or null to ungroup). Bumps `at` so it wins.
export function setPackItemGroup(kind, id, itemId, group) {
  const l = kind === 'template' ? getTemplate(id) : getTrip(id);
  if (!l) return;
  const it = l.items.find(i => i.id === itemId); if (!it) return;
  const g = (group || '').trim() || null;
  if (it.group === g) return;
  it.group = g; it.at = Date.now(); l.updatedAt = Date.now(); save();
}
// Rename a group across the whole list (blank `to` dissolves it — items go
// back to Ungrouped). Bumps each member's `at` so the rename wins in a merge.
export function renamePackGroup(kind, id, from, to) {
  const l = kind === 'template' ? getTemplate(id) : getTrip(id);
  if (!l || !from) return 0;
  const g = (to || '').trim() || null;
  if (g === from) return 0;
  const now = Date.now();
  let n = 0;
  for (const it of l.items) if (it.group === from) { it.group = g; it.at = now; n++; }
  if (n) { l.updatedAt = now; save(); }
  return n;
}
// Distinct group names present in a list (for the group picker).
export function packListGroups(kind, id) {
  const l = kind === 'template' ? getTemplate(id) : getTrip(id);
  if (!l) return [];
  return [...new Set(l.items.map(i => i.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
// One-tap A–Z of a list (or of a trip's unchecked items, if scopeIds given).
export function sortPackList(kind, id, scopeIds) {
  const l = kind === 'template' ? getTemplate(id) : getTrip(id);
  if (!l) return;
  const pool = scopeIds ? l.items.filter(i => scopeIds.includes(i.id)) : l.items.slice();
  const ids = pool.sort((a, b) => norm(a.text).localeCompare(norm(b.text))).map(i => i.id);
  return setPackListOrder(kind, id, ids);
}

// ---------- packing sync (folded into the shared household file) ----------
// Snapshot of everything packing-related, carried inside the shared sync blob.
export function packSnapshot() {
  const P = packStore();
  return { templates: P.templates, trips: P.trips, del: { ...P.del } };
}
// Merge one list (a=local, b=remote). name/done/meta from whichever was
// touched last; items unioned by id with newest `at` winning per item, honoured
// against per-item tombstones; stable order by creation stamp `c`.
function mergeList(a, b) {
  if (!a) return b; if (!b) return a;
  const base = (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
  const del = { ...(a.del || {}), ...(b.del || {}) };
  for (const [id, ts] of Object.entries(a.del || {})) if (!del[id] || ts > del[id]) del[id] = ts;
  const map = new Map();
  for (const it of a.items || []) map.set(it.id, it);
  for (const it of b.items || []) { const ex = map.get(it.id); if (!ex || (it.at || 0) > (ex.at || 0)) map.set(it.id, it); }
  const items = [...map.values()]
    .filter(it => !(del[it.id] && del[it.id] >= (it.at || 0)))
    .sort((x, y) => (ordOf(x) - ordOf(y)) || ((x.c || 0) - (y.c || 0)));
  return { ...base, items, del };
}
function mergeCollection(localArr, remoteArr, listDelMap) {
  const byId = new Map((localArr || []).map(l => [l.id, l]));
  for (const r of remoteArr || []) byId.set(r.id, mergeList(byId.get(r.id), r));
  return [...byId.values()]
    .filter(x => !(listDelMap[x.id] && listDelMap[x.id] >= (x.updatedAt || 0)))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
// A signature over only the fields users see, so we can tell whether a merge
// actually changed anything (and avoid a self-perpetuating sync loop).
function packSig(P) {
  const sig = l => l.id + '|' + (l.name || '') + '|' + (l.done ? 1 : 0) + '|' +
    (l.items || []).map(i => i.id + ':' + i.text + ':' + (i.checked ? 1 : 0) + ':' + (i.group || '') + ':' + ordOf(i)).join(',');
  const col = arr => (arr || []).map(sig).sort().join(';;');
  return col(P.templates) + '###' + col(P.trips);
}
export function applyPackSync(remoteP) {
  if (!remoteP || typeof remoteP !== 'object') return false;
  const P = packStore();
  const before = packSig(P);
  for (const [id, ts] of Object.entries(remoteP.del || {})) if (!P.del[id] || ts > P.del[id]) P.del[id] = ts;
  P.templates = mergeCollection(P.templates, remoteP.templates, P.del);
  P.trips = mergeCollection(P.trips, remoteP.trips, P.del);
  const cut = Date.now() - 90 * 86400e3;
  for (const [id, ts] of Object.entries(P.del)) if (ts < cut) delete P.del[id];
  return before !== packSig(P);
}
