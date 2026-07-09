// List / dump / house / settings / detail-sheet rendering.

import {
  state, save, uid, addItem, getItem, updateItem, deleteItem, markDone, attachDoneNote, addMessage,
  uOf, effectivePriority, gravityBoost, effDueISO, memberName, visibleTo,
  inboxItems, childrenOf, exportJSON, importJSON, resetAll, DIM_ORDER, BUILD,
  newsItems, reviewNews, clearNews, otherUsers, partnerName,
  claimItem, snoozeItem, isSnoozed, setDailyChore, finishedToday, openLoad, digestSeenToday, markDigestSeen,
} from './store.js';
import { parseDump, classifyOne } from './classify.js';
import { agentClassify, agentPhotoTasks, getKey, setKey } from './agent.js';
import { openSizer } from './bubbles.js';
import * as gsync from './gsync.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let personFilterVal = 'all';
let wellbeingOpen = false;
let snoozeOpen = false;
let groupMode = false; // false = flat ranked list; true = grouped by category
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
    // is a call to action, and a struggle isn't actionable the same way;
    // snoozed items stay out of sight until their time comes
    .filter(i => i.status === 'active' && i.type !== 'issue' && !isSnoozed(i))
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

// Once-a-day household digest: a warm good-morning with what's on your plate,
// a celebratory recap of what you two finished today, and who's carrying what.
// Returns true if it showed (so the ember takeover can stand down for it).
export function renderDigest() {
  if (!state.profile || digestSeenToday()) return false;
  const plate = allSurfaced().slice(0, 4);
  const fin = finishedToday();
  if (!plate.length && !fin.length) { markDigestSeen(); return false; }
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const load = openLoad();

  let html = '<div class="dg-greet">' + greet + ', ' + esc(memberName(state.profile)) + '</div>';
  if (plate.length) {
    html += '<div class="dg-head">on the horizon</div>' +
      plate.map(s => '<div class="dg-row"><span class="dg-title">' + esc(s.i.title) + '</span>' +
        '<span class="dg-why">' + esc(s.why) + '</span></div>').join('');
  }
  if (fin.length) {
    html += '<div class="dg-head">knocked out today 🎉</div>' +
      fin.slice(0, 6).map(i => '<div class="dg-row done"><span class="dg-check">✓</span>' +
        '<span class="dg-title">' + esc(i.title) + '</span>' +
        (i.doneBy && i.doneBy !== state.profile ? '<span class="dg-by">' + esc(memberName(i.doneBy)) + '</span>' : '') +
        '</div>').join('');
  }
  const lk = Object.keys(load);
  if (lk.length) html += '<div class="dg-load">' + lk.map(k =>
    '<span class="dg-load-item"><b>' + load[k] + '</b> ' + esc(memberName(k)) + '</span>').join('') + '</div>';
  html += '<button id="dgClose" class="primary big">Let’s go →</button>';

  const wrap = $('#digestWrap');
  $('#digestCard').innerHTML = html;
  wrap.hidden = false;
  const close = () => { markDigestSeen(); wrap.hidden = true; };
  $('#dgClose').onclick = close;
  $('#digestShade').onclick = close;
  return true;
}

export function changed() {
  document.dispatchEvent(new CustomEvent('stratos:changed'));
}

// transient toast with an optional action (used for undo)
let toastTimer = null;
export function showToast(msg, actionLabel, fn) {
  const t = $('#toast');
  $('#toastMsg').textContent = msg;
  const btn = $('#toastAction');
  if (actionLabel) {
    btn.textContent = actionLabel;
    btn.hidden = false;
    btn.onclick = () => { t.hidden = true; fn(); };
  } else {
    btn.hidden = true;
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

// finish/unfinish with an undo toast, so an accidental tap is recoverable.
// Finishing a SHARED task instead opens a little popover to (optionally) leave
// a note for the other person — the note rides along in their review blob.
function finishItem(id, done) {
  const it = getItem(id);
  if (done && it && it.visibility === 'shared' && otherUsers().length) {
    openDonePop(id);
    return;
  }
  markDone(id, done);
  changed();
  if (done) {
    showToast('Done: ' + (it ? it.title : 'item'), 'Undo', () => { markDone(id, false); changed(); });
  }
}

// ---------- completion note to the other person ----------
function openDonePop(id) {
  const it = getItem(id);
  if (!it) return;
  markDone(id, true);            // it's done immediately; the note is a bonus
  changed();
  const who = partnerName();
  const wrap = $('#donePopWrap'), pop = $('#donePop');
  pop.innerHTML =
    '<div class="dp-title">Done <span class="dp-check">✓</span></div>' +
    '<div class="dp-item">' + esc(it.title) + '</div>' +
    '<textarea id="dpNote" rows="2" placeholder="Leave a note for ' + esc(who) + ' (optional)…"></textarea>' +
    '<div class="dp-actions">' +
      '<button id="dpUndo" class="dp-undo">Undo</button>' +
      '<button id="dpSkip" class="dp-skip">Done, no note</button>' +
      '<button id="dpSend" class="primary">Send note ✎</button>' +
    '</div>';
  wrap.hidden = false;
  const close = () => { wrap.hidden = true; };
  $('#dpUndo').onclick = () => { markDone(id, false); changed(); close(); };
  $('#dpSkip').onclick = close;
  $('#dpSend').onclick = () => {
    const n = $('#dpNote').value.trim();
    if (n) { attachDoneNote(id, n); changed(); showToast('Note on its way to ' + who + ' ✓'); }
    close();
  };
  $('#donePopShade').onclick = close;
  setTimeout(() => { const t = $('#dpNote'); if (t) t.focus(); }, 60);
}

// ---------- "while you were away": the jelly review blob ----------
export function initNews() {
  $('#newsBlob').onclick = openNews;
  $('#newsShade').onclick = () => { $('#newsWrap').hidden = true; };
  $('#newsAll').onclick = () => {
    // pop every card in a quick satisfying cascade, then clear
    const cards = [...document.querySelectorAll('.news-card:not(.popped)')];
    cards.forEach((c, i) => setTimeout(() => c.classList.add('popped'), i * 70));
    if (navigator.vibrate) navigator.vibrate(20);
    setTimeout(() => { clearNews(); renderNewsBlob(); $('#newsWrap').hidden = true; }, cards.length * 70 + 320);
  };
}

export function renderNewsBlob() {
  const n = newsItems().length;
  $('#newsBlob').hidden = n === 0;
  $('#newsBlobCount').textContent = n;
  if (n === 0) $('#newsWrap').hidden = true;
}

function openNews() {
  const items = newsItems();
  if (!items.length) return;
  const list = $('#newsList');
  list.innerHTML = '';
  for (const ev of items) {
    const who = esc(memberName(ev.by));
    const sub = ev.kind === 'message' ? (ev.subkind || 'msg') : ev.kind;
    let line;
    if (sub === 'done') line = '<b>' + who + '</b> finished';
    else if (sub === 'added') line = '<b>' + who + '</b> added';
    else if (sub === 'ask') line = '<b>' + who + '</b> asked you to take';
    else if (sub === 'thanks') line = '<b>' + who + '</b> sent you';
    else if (sub === 'claim') line = '<b>' + who + '</b> is on it —';
    else line = '<b>' + who + '</b> messaged about';
    const showHeart = sub === 'done';                    // react to a completion
    const card = document.createElement('div');
    card.className = 'news-card ' + sub;
    card.innerHTML =
      '<div class="nc-body">' +
        '<div class="nc-line">' + line + '</div>' +
        '<div class="nc-title">' + esc(ev.title) + '</div>' +
        (ev.note ? '<div class="nc-note">' + (sub === 'thanks' ? '' : '“') + esc(ev.note) + (sub === 'thanks' ? '' : '”') + '</div>' : '') +
      '</div>' +
      (showHeart ? '<button class="nc-heart" title="say thanks">♥</button>' : '') +
      '<button class="nc-pop" title="reviewed">✓</button>';
    card.querySelector('.nc-pop').onclick = () => popNews(card, ev.key);
    const heart = card.querySelector('.nc-heart');
    if (heart) heart.onclick = () => {
      if (getItem(ev.itemId)) { addMessage(ev.itemId, 'thanks!', 'thanks'); changed(); showToast('❤ sent to ' + memberName(ev.by)); }
      popNews(card, ev.key);
    };
    card.querySelector('.nc-body').onclick = () => {
      if (getItem(ev.itemId)) { $('#newsWrap').hidden = true; openSheet(ev.itemId); }
    };
    list.appendChild(card);
  }
  $('#newsWrap').hidden = false;
}

function popNews(card, key) {
  if (card.classList.contains('popped')) return;
  card.classList.add('popped');
  if (navigator.vibrate) navigator.vibrate(12);
  setTimeout(() => {
    card.remove();          // let the panel reflow once it has splatted away
    reviewNews(key);
    renderNewsBlob();
    if (!newsItems().length) $('#newsWrap').hidden = true;
  }, 320);
}

// ---------- DUMP ----------

export function initDump() {
  const btn = $('#dumpBtn');

  // focus mode: tapping into the dump box expands it and fades the rest of
  // the world away, so a brain dump is the only thing in front of you
  const ta = $('#dumpText');
  ta.addEventListener('focus', () => document.body.classList.add('dump-focus'));
  ta.addEventListener('blur', () => document.body.classList.remove('dump-focus'));

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
  // Priority (flat) vs Categories (grouped) — priority is what you do with
  // your time, across every category, so it's the default.
  document.querySelectorAll('#listMode .seg').forEach(b => {
    b.classList.toggle('on', (b.dataset.mode === 'cat') === groupMode);
    b.onclick = () => { groupMode = b.dataset.mode === 'cat'; renderLists(); };
  });

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
  const active = topActive.filter(i => i.type !== 'issue' && !isSnoozed(i));
  const snoozed = topActive.filter(i => i.type !== 'issue' && isSnoozed(i));
  const done = items.filter(i => i.status === 'done' && !i.parent && i.type !== 'issue');

  const dc = $('#doneCount');
  if (dc) dc.textContent = done.length ? 'done (' + done.length + ')' : 'done';

  active.sort(sorter(sort));

  const body = $('#listBody');
  body.innerHTML = '';

  if (!active.length && !done.length && !snoozed.length) {
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

  if (groupMode) {
    // Categories mode: grouped by category, ranked within each
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
  } else {
    // Priority mode: one flat ranked list across every category
    for (const i of active) body.appendChild(itemRow(i, sort));
  }

  if (showDone && done.length) {
    const h = document.createElement('div');
    h.className = 'group-head';
    h.textContent = 'done';
    body.appendChild(h);
    done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    for (const i of done) body.appendChild(itemRow(i, sort));
  }

  if (snoozed.length) {
    const sb = document.createElement('button');
    sb.className = 'wb-chip snoozed-chip' + (snoozeOpen ? ' open' : '');
    sb.textContent = '😴 snoozed · ' + snoozed.length;
    sb.onclick = () => { snoozeOpen = !snoozeOpen; renderLists(); };
    body.appendChild(sb);
    if (snoozeOpen) {
      snoozed.sort((a, b) => (a.snoozeUntil || 0) - (b.snoozeUntil || 0));
      for (const i of snoozed) {
        const row = itemRow(i, sort);
        row.style.opacity = '.66';
        body.appendChild(row);
      }
    }
  }
}

function sorter(sort) {
  if (sort === 'new') return (a, b) => b.createdAt - a.createdAt;
  if (sort === 'due') return (a, b) => (effDueISO(a) || '9999') < (effDueISO(b) || '9999') ? -1 : 1;
  if (sort === 'priority') return (a, b) => effectivePriority(b) - effectivePriority(a);
  return (a, b) => (uOf(b, sort) ?? -1) - (uOf(a, sort) ?? -1);
}

// A row: tap the body to resize (bubble), tap a chip to edit that field
// inline, tap the progress ring to open its steps, ✓ to finish, ✎ for the
// full edit sheet.
function itemRow(i, sort, opts = {}) {
  const el = document.createElement('div');
  el.className = 'row' + (i.status === 'done' ? ' done' : '');
  const sw = catSwatch(i.category);
  el.style.background = sw.bg;
  el.style.boxShadow = '0 4px 0 ' + sw.dot + '66';
  const resizeDim = ['priority', 'effort', 'difficulty', 'dread', 'restock'].includes(sort) ? sort : 'priority';
  const u = resizeDim === 'priority' ? effectivePriority(i) : (uOf(i, resizeDim) ?? null);
  const n = state.dims[resizeDim].strata.length;
  const dot = u === null ? 10 : 10 + (u / n) * 26;
  const boost = gravityBoost(i);
  const kids = childrenOf(i.id);

  el.innerHTML =
    '<span class="dot" style="width:' + dot + 'px;height:' + dot + 'px;' +
      'background:radial-gradient(circle at 32% 30%, #ffffffb3, ' + sw.dot + ')"></span>' +
    '<span class="row-main"><span class="row-title">' + esc(i.title) + '</span>' +
    '<span class="row-chips">' +
      rchip('category', esc(i.category)) +
      (i.scope !== state.profile ? rchip('scope', esc(memberName(i.scope))) : '') +
      (i.due && !opts.noDue ? rchip('due', (boost >= 1.5 ? '⚑ ' : boost > 0 ? '◷ ' : 'due ') + i.due, boost > 0 ? 'hot' : '') : '') +
      (i.source ? rchip('source', '@ ' + esc(i.source)) : '') +
      (i.loop?.every && !opts.noDue ? rchip('loop', i.loop.every <= 1 ? '↺ daily' : '↺ ~' + i.loop.every + 'd') : '') +
      (kids.length ? '<button class="rchip" data-steps>◉ ' + kids.filter(k => k.status === 'done').length + '/' + kids.length + '</button>' : '') +
      (i.claimedBy ? '<span class="minichip claim">🙌 ' + esc(memberName(i.claimedBy)) + (i.claimedBy === state.profile ? ' (you)' : '') + '</span>' : '') +
      rchip('visibility', i.visibility === 'private' ? 'private' : 'shared') +
      (i.status === 'inbox' ? '<span class="minichip unsized">unsized</span>' : '') +
    '</span></span>' +
    '<button class="row-icon" data-done title="done">' + (i.status === 'done' ? '↺' : '✓') + '</button>' +
    '<button class="row-icon edit" data-edit title="edit all">✎</button>';

  el.onclick = (e) => {
    if (e.target.closest('[data-done]')) { finishItem(i.id, i.status !== 'done'); return; }
    if (e.target.closest('[data-edit]')) { openSheet(i.id); return; }
    if (e.target.closest('[data-steps]')) { openBubble(i.id); return; }
    const chipBtn = e.target.closest('.rchip[data-field]');
    if (chipBtn) { openQuickEdit(i.id, chipBtn.dataset.field, chipBtn); return; }
    // body tap → resize on the dimension the list is ranked by
    window.stratosGoto('size');
    openSizer([getItem(i.id)], () => window.stratosGoto('lists'), resizeDim);
  };
  return el;
}

const rchip = (field, text, cls) =>
  '<button class="rchip ' + (cls || '') + '" data-field="' + field + '">' + text + '</button>';

// ---------- QUICK-EDIT POPOVER ----------

function isoIn(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function isoWeekend() { const dow = new Date().getDay(); return isoIn(((6 - dow) + 7) % 7 || 7); }

function openQuickEdit(id, field, anchor) {
  const i = getItem(id);
  if (!i) return;
  const wrap = $('#quickWrap'), pop = $('#quickPop');
  pop.style.transform = ''; // clear any centring left by the snooze menu
  let title = field, options = [];

  if (field === 'category') {
    title = 'Category';
    const cats = [...new Set(state.items.map(x => x.category))];
    options = cats.map(c => ({ label: c, on: c === i.category, apply: { category: c } }));
  } else if (field === 'visibility') {
    title = 'Visibility';
    options = [
      { label: 'Shared with Ebbe & me', on: i.visibility !== 'private', apply: { visibility: 'shared' } },
      { label: 'Private — only me', on: i.visibility === 'private', apply: { visibility: 'private' } },
    ];
  } else if (field === 'scope') {
    title = 'Who / where';
    options = state.family.map(f => ({ label: f.name, on: f.id === i.scope, apply: { scope: f.id } }));
  } else if (field === 'due') {
    title = 'Due';
    options = [
      { label: 'Today', apply: { due: isoIn(0) } },
      { label: 'Tomorrow', apply: { due: isoIn(1) } },
      { label: 'This weekend', apply: { due: isoWeekend() } },
      { label: 'In a week', apply: { due: isoIn(7) } },
      { label: 'Clear date', on: !i.due, apply: { due: null } },
    ];
  } else if (field === 'source') {
    title = 'Where from';
    const srcs = [...new Set(state.items.map(x => x.source).filter(Boolean))];
    options = srcs.map(s => ({ label: s, on: s === i.source, apply: { source: s } }));
    options.push({ label: 'Clear', on: !i.source, apply: { source: null } });
  } else if (field === 'loop') {
    title = 'Loop';
    const hist = i.loop?.history || [];
    options = [
      { label: 'Not a loop', on: !i.loop, apply: { loop: null } },
      { label: 'every ~7 days', apply: { loop: { every: 7, auto: false, history: hist } } },
      { label: 'every ~14 days', apply: { loop: { every: 14, auto: false, history: hist } } },
      { label: 'every ~30 days', apply: { loop: { every: 30, auto: false, history: hist } } },
    ];
  }

  pop.innerHTML =
    '<div class="qe-head">' + esc(title) + '</div>' +
    '<div class="qe-opts">' +
      options.map((o, idx) => '<button class="chip qe-opt' + (o.on ? ' on' : '') + '" data-i="' + idx + '">' + esc(o.label) + '</button>').join('') +
    '</div>' +
    '<button class="qe-editall" data-editall>✎ edit all…</button>';

  wrap.hidden = false;
  positionPop(pop, anchor);

  pop.querySelectorAll('.qe-opt').forEach(btn => {
    btn.onclick = () => { updateItem(id, options[+btn.dataset.i].apply); wrap.hidden = true; changed(); };
  });
  pop.querySelector('[data-editall]').onclick = () => { wrap.hidden = true; openSheet(id); };
  $('#quickShade').onclick = () => { wrap.hidden = true; };
}

function positionPop(pop, anchor) {
  const pw = Math.min(300, window.innerWidth - 16);
  pop.style.width = pw + 'px';
  pop.style.left = '0px'; pop.style.top = '0px';
  const a = anchor.getBoundingClientRect();
  const ph = pop.offsetHeight;
  const left = Math.min(Math.max(8, a.left), window.innerWidth - pw - 8);
  let top = a.bottom + 6;
  if (top + ph > window.innerHeight - 74) top = Math.max(8, a.top - ph - 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
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
  $('#bubbleResize').onclick = () => {
    wrap.hidden = true;
    window.stratosGoto('size');
    openSizer([getItem(id)], () => window.stratosGoto('lists'), 'priority');
  };
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

// the little message thread that shows on shared items
function threadHtml(i) {
  const ms = i.messages || [];
  if (!ms.length) return '<div class="msg-empty">No messages yet — say hi 👋</div>';
  return ms.map(m => {
    const mine = m.by === state.profile;
    const tag = m.kind === 'ask' ? '🙋 ' : m.kind === 'thanks' ? '❤️ ' : '';
    return '<div class="msg ' + (mine ? 'mine' : 'theirs') + '">' +
      (mine ? '' : '<span class="msg-who">' + esc(memberName(m.by)) + '</span>') +
      (m.photo ? '<img class="msg-photo" src="' + esc(m.photo) + '" alt="">' : '') +
      (m.text ? '<span class="msg-text">' + tag + esc(m.text) + '</span>' : '') + '</div>';
  }).join('');
}
function messagesSection(i) {
  const who = esc(partnerName());
  return '<div class="group-head">message ' + who + '</div>' +
    '<div class="msg-thread" id="shThread">' + threadHtml(i) + '</div>' +
    '<div class="quickadd subadd"><input id="shMsgInput" placeholder="Message ' + who + '…" autocapitalize="sentences">' +
      '<label class="chip" id="shMsgPhotoLbl" title="attach a photo">⊙<input id="shMsgPhoto" type="file" accept="image/*" hidden></label>' +
      '<button id="shMsgSend" class="chip">Send</button></div>' +
    '<button id="shAsk" class="chip big-chip ask-chip">🙋 Ask ' + who + ' to take this</button>';
}

// snooze picker: tonight / tomorrow / weekend, or wake now — reuses the
// quick popover shell, centred on screen.
function openSnoozeMenu(id) {
  const at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d.getTime(); };
  let tonight = at(0, 19); if (tonight < Date.now()) tonight = at(1, 19);
  const satAdd = ((6 - new Date().getDay()) + 7) % 7 || 7;
  const opts = [['Tonight', tonight], ['Tomorrow morning', at(1, 9)], ['This weekend', at(satAdd, 9)]];
  const it = getItem(id);
  const wrap = $('#quickWrap'), pop = $('#quickPop');
  pop.innerHTML = '<div class="qe-head">Snooze until…</div><div class="qe-opts">' +
    opts.map((o, k) => '<button class="chip" data-k="' + k + '">' + o[0] + '</button>').join('') +
    (it && it.snoozeUntil ? '<button class="chip danger" data-clear>Wake now</button>' : '') + '</div>';
  wrap.hidden = false;
  pop.style.left = '50%'; pop.style.top = '42%'; pop.style.transform = 'translate(-50%,-50%)';
  pop.querySelectorAll('[data-k]').forEach(b => b.onclick = () => {
    snoozeItem(id, opts[+b.dataset.k][1]); wrap.hidden = true; $('#sheetWrap').hidden = true; changed();
    showToast('Snoozed · ' + opts[+b.dataset.k][0].toLowerCase());
  });
  const cl = pop.querySelector('[data-clear]');
  if (cl) cl.onclick = () => { snoozeItem(id, null); wrap.hidden = true; changed(); openSheet(id); };
  $('#quickShade').onclick = () => { wrap.hidden = true; pop.style.transform = ''; };
}

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
    })() : 'not sized';
    return '<button class="dimrow" data-resize="' + d + '"><span>' + esc(state.dims[d].label) +
      '</span><b>' + label + '</b><span class="resize-cue">◯ resize</span></button>';
  }).join('');

  // your categories as one-tap chips (robust where the dropdown is flaky)
  const catChips = cats.length
    ? '<div class="catchips">' + cats.slice(0, 12).map(c =>
        '<button type="button" class="minichip catchip' + (c === i.category ? ' on' : '') +
        '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>'
    : '';

  sheet.innerHTML =
    '<div class="sheet-head"><div class="sheet-grab"></div>' +
      '<button id="shClose" class="sheet-x" title="Close">✕</button></div>' +
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
    catChips +
    '<button id="shVis" class="chip big-chip">' + (i.visibility === 'private' ? 'Private — only me' : 'Shared with Ebbe & me') + '</button>' +
    '<div class="sh-quick">' +
      (i.visibility === 'shared' && otherUsers().length
        ? '<button id="shClaim" class="chip' + (i.claimedBy ? ' on' : '') + '">' +
          (i.claimedBy === state.profile ? '🙌 On it — release' : i.claimedBy ? '🙌 ' + esc(memberName(i.claimedBy)) + ' on it' : '🙌 I’m on it') + '</button>'
        : '') +
      '<button id="shDaily" class="chip' + (i.loop && i.loop.every <= 1 ? ' on' : '') + '">🔁 Daily chore</button>' +
      '<button id="shSnooze" class="chip">😴 ' + (i.snoozeUntil ? 'Snoozed' : 'Snooze') + '</button>' +
    '</div>' +
    (i.due ? '<a class="chip big-chip cal" target="_blank" rel="noopener" href="' + gcalUrl(i) + '">↗ Add to Google Calendar</a>' : '') +
    '<div class="group-head">magnitude · tap to resize</div>' +
    '<div class="dimrows">' + dimRows + '</div>' +
    '<div class="group-head">notes</div>' +
    '<textarea id="shNotes" placeholder="Notes, links, anything — paste a URL and it becomes a chip below">' + esc(i.notes || '') + '</textarea>' +
    '<div id="shLinks" class="linkrow"></div>' +
    (i.visibility === 'shared' && otherUsers().length ? messagesSection(i) : '') +
    '<div class="group-head">photos</div>' +
    '<div class="mediagrid" id="shMedia"></div>' +
    '<label class="chip addphoto">⊙ Add photo<input type="file" id="shPhoto" accept="image/*" hidden></label>' +
    '<div class="group-head">steps</div>' +
    '<div id="shKids"></div>' +
    '<div class="quickadd subadd"><input id="shSubInput" placeholder="Break it into steps…">' +
    '<button id="shSubAdd" class="chip">Add</button></div>' +
    '<div class="sheet-actions">' +
      '<button id="shDone" class="primary">' + (i.status === 'done' ? '↺ Not done' : '✓ Done') + '</button>' +
      '<button id="shDelete" class="danger">Delete</button>' +
    '</div>';

  // one-tap category chips set the field and highlight
  sheet.querySelectorAll('.catchip').forEach(c => {
    c.onclick = () => {
      $('#shCat').value = c.dataset.cat;
      sheet.querySelectorAll('.catchip').forEach(x => x.classList.toggle('on', x === c));
    };
  });

  // live link cards as you type/paste; enrich (title + preview image) once
  // you finish the note (on blur), if link previews are turned on in settings
  renderLinks($('#shLinks'), i.notes, i);
  $('#shNotes').addEventListener('input', () => {
    renderLinks($('#shLinks'), $('#shNotes').value, getItem(id));
  });
  $('#shNotes').addEventListener('blur', () => {
    const it = getItem(id); if (!it) return;
    it.notes = $('#shNotes').value; save();
    enrichLinks(it, () => renderLinks($('#shLinks'), it.notes, it));
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

  // message thread with the other person (shared items only)
  if (i.visibility === 'shared' && otherUsers().length) {
    const refreshThread = () => {
      const el = $('#shThread');
      if (el) { el.innerHTML = threadHtml(getItem(id)); el.scrollTop = el.scrollHeight; }
    };
    const send = () => {
      const t = $('#shMsgInput').value.trim();
      if (!t) return;
      addMessage(id, t, 'msg');
      $('#shMsgInput').value = '';
      refreshThread();
      changed();
    };
    $('#shMsgSend').onclick = send;
    $('#shMsgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    $('#shAsk').onclick = () => {
      addMessage(id, 'Can you take this one?', 'ask');
      refreshThread();
      changed();
      showToast('Asked ' + partnerName() + ' to take it');
    };
    $('#shMsgPhoto').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const dataUrl = await shrinkImage(f, 640);   // small so it syncs cheaply
        addMessage(id, $('#shMsgInput').value.trim(), 'msg', dataUrl);
        $('#shMsgInput').value = ''; refreshThread(); changed();
      } catch { alert("Couldn't read that image."); }
      e.target.value = '';
    };
    // "I'm on it" claim (release if it's already mine, else take it)
    const claimBtn = $('#shClaim');
    if (claimBtn) claimBtn.onclick = () => {
      claimItem(id, getItem(id).claimedBy !== state.profile);
      changed(); openSheet(id);
    };
  }

  // daily chore + snooze work on any item
  $('#shDaily').onclick = () => {
    const it = getItem(id);
    setDailyChore(id, !(it.loop && it.loop.every <= 1));
    changed(); openSheet(id);
  };
  $('#shSnooze').onclick = () => openSnoozeMenu(id);

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

  const close = () => { commit(); wrap.hidden = true; sheet.style.transform = ''; };
  $('#sheetShade').onclick = close;
  $('#shClose').onclick = close;

  // pull the top handle down to dismiss
  const head = sheet.querySelector('.sheet-head');
  let dragStart = null;
  head.addEventListener('touchstart', (ev) => {
    dragStart = ev.touches[0].clientY; sheet.style.transition = 'none';
  }, { passive: true });
  head.addEventListener('touchmove', (ev) => {
    if (dragStart === null) return;
    const dy = ev.touches[0].clientY - dragStart;
    if (dy > 0) sheet.style.transform = 'translateY(' + dy + 'px)';
  }, { passive: true });
  const endDrag = (ev) => {
    if (dragStart === null) return;
    const dy = (ev.changedTouches[0]?.clientY ?? dragStart) - dragStart;
    sheet.style.transition = '';
    dragStart = null;
    if (dy > 90) close(); else sheet.style.transform = '';
  };
  head.addEventListener('touchend', endDrag);
  head.addEventListener('touchcancel', endDrag);

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

// ---------- sync settings ----------

function syncSettingsHtml() {
  const c = state.sync || (state.sync = {});
  const connected = gsync.isSignedIn();
  const last = c.lastSync ? new Date(c.lastSync).toLocaleTimeString() : 'never';
  return (
    '<label class="famrow"><input id="syClient" placeholder="Google client ID (…apps.googleusercontent.com)" value="' + esc(c.clientId || '') + '"></label>' +
    '<label class="famrow"><input id="syKey" placeholder="Google API key (for joining a shared household)" value="' + esc(c.apiKey || '') + '"></label>' +
    '<div class="setrow"><button id="syConnect" class="chip">' + (connected ? '✓ Connected' : 'Connect Google') + '</button>' +
    '<button id="sySyncNow" class="chip">Sync now</button>' +
    '<span class="hint" id="syStatus">last sync: ' + last + '</span></div>' +
    '<div class="setrow">' +
      (c.householdFileId
        ? '<button id="syInvite" class="chip">Invite Ebbe (email)</button> <span class="hint">household connected</span>'
        : '<button id="syCreate" class="chip">Create household</button> <button id="syJoin" class="chip">Join Ebbe’s</button>') +
    '</div>' +
    '<label class="toggle" style="padding:6px 0"><input type="checkbox" id="syPriv"' + (c.privateBackup !== false ? ' checked' : '') + '> back up my private items to my own Drive</label>' +
    '<p class="hint">Shared items sync to a household file both of you can read; private items back up only to your own Drive. Set up a free Google Cloud project (client ID + API key) — see the chat instructions.</p>'
  );
}

function wireSyncSettings() {
  const c = state.sync || (state.sync = {});
  if (c.clientId) gsync.preloadLibs(); // warm Google's scripts before the tap
  const setStatus = (s) => { const el = $('#syStatus'); if (el) el.textContent = s; };
  gsync.onSyncStatus((s) => setStatus(s === 'ok' ? 'synced ' + new Date().toLocaleTimeString() : s === 'syncing' ? 'syncing…' : s.startsWith('error') ? s.slice(6) : s));
  $('#syClient').onchange = (e) => { c.clientId = e.target.value.trim(); save(); };
  $('#syKey').onchange = (e) => { c.apiKey = e.target.value.trim(); save(); };
  $('#syPriv').onchange = (e) => { c.privateBackup = e.target.checked; save(); };
  $('#syConnect').onclick = async (e) => {
    const btn = e.currentTarget; const was = btn.textContent; btn.textContent = 'Connecting…';
    try { await gsync.connect(); renderSettings(); }
    catch (err) { btn.textContent = was; alert('Google sign-in failed: ' + err.message); }
  };
  $('#sySyncNow').onclick = async () => { await gsync.syncNow(); renderSettings(); };
  const cr = $('#syCreate'); if (cr) cr.onclick = async () => { try { await gsync.createHousehold(); await gsync.syncNow(); renderSettings(); alert('Household created — now Invite Ebbe.'); } catch (e) { alert(e.message); } };
  const jn = $('#syJoin'); if (jn) jn.onclick = async () => { try { const id = await gsync.joinHousehold(); if (id) { await gsync.syncNow(); renderSettings(); } } catch (e) { alert(e.message); } };
  const iv = $('#syInvite'); if (iv) iv.onclick = async () => { const em = prompt('Ebbe’s Google email:'); if (em) { try { await gsync.invite(em.trim()); alert('Invited ' + em); } catch (e) { alert(e.message); } } };
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

// ---------- rich link cards ----------
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const linkUrls = (notes) => [...new Set((notes || '').match(URL_RE) || [])].slice(0, 3); // 2–3 chips

function linkHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function linkPretty(u) {
  try {
    const url = new URL(u);
    let seg = decodeURIComponent(url.pathname).split('/').filter(Boolean).pop() || '';
    seg = seg.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+]+/g, ' ').trim();
    return seg && seg.length > 1 ? seg.replace(/\b\w/g, c => c.toUpperCase()) : '';
  } catch { return ''; }
}
const favicon = (host) => 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64';

// one row-sized card: preview image (or favicon) + title + subtitle
function linkCardHtml(u, meta) {
  const host = linkHost(u);
  const title = (meta && meta.title) || linkPretty(u) || host;
  const sub = (meta && meta.desc) || (title === host ? u.replace(/^https?:\/\//, '') : host);
  const letter = esc((host[0] || '?').toUpperCase());
  const thumb = meta && meta.image
    ? '<span class="lc-thumb" style="background-image:url(' + esc(JSON.stringify(meta.image)) + ')"></span>'
    : '<span class="lc-fav" data-letter="' + letter + '"><img src="' + esc(favicon(host)) + '" alt=""></span>';
  return '<a class="link-card" href="' + esc(u) + '" target="_blank" rel="noopener">' + thumb +
    '<span class="lc-text"><span class="lc-title">' + esc(title) + '</span>' +
    '<span class="lc-sub">' + esc(sub) + '</span></span><span class="lc-go">↗</span></a>';
}

// render the cards into a container; wire favicon fallback (letter badge)
function renderLinks(container, notes, item) {
  const urls = linkUrls(notes);
  const meta = (item && item.linkMeta) || {};
  container.innerHTML = urls.map(u => linkCardHtml(u, meta[u])).join('');
  container.querySelectorAll('.lc-fav img').forEach(img => {
    img.onerror = () => { img.style.display = 'none'; }; // reveals the letter badge behind it
  });
}

// best-effort unfurl (title/description/image) via a CORS-friendly service,
// only when the user has opted in. Cached on the item so it syncs and never
// re-fetches. Silent on any failure — the favicon card is always the fallback.
async function fetchLinkMeta(url) {
  try {
    const r = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(url), { mode: 'cors' });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== 'success') return null;
    const d = j.data || {};
    return { title: (d.title || '').slice(0, 120), desc: (d.description || '').slice(0, 140),
      image: (d.image && d.image.url) || (d.logo && d.logo.url) || '', at: Date.now() };
  } catch { return null; }
}
async function enrichLinks(item, onDone) {
  if (!state.linkPreviews || !navigator.onLine) return;
  const meta = item.linkMeta || (item.linkMeta = {});
  let got = false;
  for (const u of linkUrls(item.notes)) {
    if (meta[u]) continue;
    const m = await fetchLinkMeta(u);
    if (m) { meta[u] = m; got = true; }
  }
  if (got) { save(); onDone && onDone(); changed(); }
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
    '<div class="group-head">link previews</div>' +
    '<label class="toggle" style="padding:6px 0"><input type="checkbox" id="setLinkPrev"' + (state.linkPreviews ? ' checked' : '') + '> fetch titles &amp; preview images for links in notes</label>' +
    '<p class="hint">Off by default. When on, a link you paste is sent to a preview service (microlink.io) to fetch its title and image; the result is cached and shared with your household. Leave off to keep link URLs private — cards still show the site icon and name.</p>' +
    '<div class="group-head">sync · google drive</div>' + syncSettingsHtml() +
    '<div class="group-head">data</div>' +
    '<div class="setrow"><button id="setExport" class="chip">Export JSON</button> ' +
    '<label class="chip">Import <input type="file" id="setImport" accept=".json" hidden></label> ' +
    '<button id="setReset" class="chip danger">Reset all</button></div>' +
    '<p class="hint">Data lives on this device for now (export/import to move it). Sync between phones is the next milestone — see DESIGN.md.</p>' +
    '<div class="group-head">version</div>' +
    '<div class="setrow">Build <b>v' + BUILD + '</b> ' +
    '<button id="setUpdate" class="chip">Force update</button></div>' +
    '<p class="hint">If you don’t see recent changes, tap Force update — it clears the cached app and reloads the latest. (Your data is untouched.)</p>';

  body.querySelectorAll('[data-fam]').forEach(inp => {
    inp.onchange = () => {
      const f = state.family.find(x => x.id === inp.dataset.fam);
      if (f && inp.value.trim()) { f.name = inp.value.trim(); save(); changed(); }
    };
  });
  $('#setGemini').onchange = (e) => { setKey(e.target.value); };
  $('#setNotes').onchange = (e) => { state.agentNotes = e.target.value.trim(); save(); };
  $('#setLinkPrev').onchange = (e) => { state.linkPreviews = e.target.checked; save(); };
  wireSyncSettings();
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
  $('#setUpdate').onclick = async () => {
    const btn = $('#setUpdate');
    btn.textContent = 'Updating…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) { /* fall through to reload regardless */ }
    location.reload();
  };
}
