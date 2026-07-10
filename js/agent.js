// The v2 agent: Gemini (free tier) called directly from the device.
// The API key is entered in Settings and stored only in this device's
// localStorage — never in exports, never in the repo. When there's no key,
// no network, or any error, the caller falls back to the local heuristics
// in classify.js, so the app degrades gracefully to fully-offline.

import { state, exactGuess } from './store.js';

const MODEL = 'gemini-2.5-flash';
const KEY_STORE = 'stratos.geminiKey';
const TYPES = ['task', 'issue', 'supply', 'goal'];
const TYPE_DIM = { task: 'priority', goal: 'priority', issue: 'difficulty', supply: 'restock' };

export const getKey = () => localStorage.getItem(KEY_STORE) || '';
export const setKey = (k) => {
  if (k && k.trim()) localStorage.setItem(KEY_STORE, k.trim());
  else localStorage.removeItem(KEY_STORE);
};

// Why the last Gemini call fell back to the local rules — surfaced in the dump
// toast and the Settings "Test" button so a misconfigured key is diagnosable
// instead of a silent "unreachable".
let lastError = '';
export const lastAgentError = () => lastError;

// What this family actually does — completed and recurring items teach the
// model the household's patterns (which bags are laundry, what piles up where).
function habitContext() {
  const done = state.items.filter(i => i.status === 'done').slice(-25).map(i => i.title);
  const loops = state.items.filter(i => i.loop?.every).slice(-15).map(i => i.title + ' (~every ' + i.loop.every + 'd)');
  let out = '';
  if (done.length) out += '\nRecently completed by this family: ' + done.join('; ');
  if (loops.length) out += '\nRecurring rhythms: ' + loops.join('; ');
  if (state.agentNotes) out += '\nHousehold notes (written by the family for you — treat as ground truth):\n' + state.agentNotes;
  return out;
}

function familyContext() {
  return state.family.map(f =>
    `- id "${f.id}" = ${f.name}${f.user ? ' (adult user)' : f.id === 'house' ? ' (the household itself: groceries, supplies, house tasks)' : ' (child)'}`).join('\n');
}

function buildPrompt(rawText) {
  const today = new Date();
  const family = familyContext();
  const cats = [...new Set(state.items.map(i => i.category))].join(', ') || 'none yet';
  const corrections = (state.corrections || []).slice(-30)
    .map(c => `- "${c.title}": ${c.field} should be "${c.to}"`).join('\n');

  return `You are the filing agent for a family brain-dump app. The user dumps unstructured
text; you split it into individual items and classify each one. Be decisive; the user
can correct you and your job is to keep them from ever having to think while dumping.

Today is ${today.toISOString().slice(0, 10)} (${today.toLocaleDateString('en-US', { weekday: 'long' })}).
The dump was written by: ${state.profile}.

Family members (use ids for "scope" — who/what the item is for; default to the writer):
${family}

Item types: "task" (an action), "issue" (a difficulty or struggle, e.g. "insomnia"),
"supply" (grocery or household supply to keep stocked — scope "house"), "goal" (an aspiration).

Categories already in use (reuse when it fits, invent short lowercase ones when not): ${cats}

Rules:
- Split comma-separated grocery runs into one item per product.
- "due": ISO date (YYYY-MM-DD) only if the text implies a deadline, else "".
- "visibility": "private" if it's clearly personal/sensitive, a gift/surprise for
  another family member, or an emotional/health struggle (type "issue" defaults to
  private); otherwise "shared".
- "source": where it's bought/ordered when stated or strongly implied (e.g. Netto,
  Føtex, Rema 1000, Bilka, Lidl, Amazon, Wolt, Nemlig, Apotek, IKEA), else "".
- "raw": the exact fragment of the dump this item came from.
${corrections ? '\nThe user has corrected past filings — follow these patterns:\n' + corrections : ''}${habitContext()}

Dump to file:
"""
${rawText}
"""`;
}

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      raw: { type: 'STRING' },
      title: { type: 'STRING' },
      type: { type: 'STRING', enum: TYPES },
      scope: { type: 'STRING' },
      category: { type: 'STRING' },
      visibility: { type: 'STRING', enum: ['shared', 'private'] },
      due: { type: 'STRING' },
      source: { type: 'STRING' },
    },
    required: ['title', 'type', 'scope', 'category', 'visibility'],
  },
};

function sanitize(o) {
  if (!o || !o.title || !o.title.trim()) return null;
  const type = TYPES.includes(o.type) ? o.type : 'task';
  let scope = o.scope;
  if (!state.family.some(f => f.id === scope)) {
    const byName = state.family.find(f => f.name.toLowerCase() === String(scope || '').toLowerCase());
    scope = byName ? byName.id : state.profile;
  }
  const c = {
    raw: o.raw || o.title,
    title: o.title.trim(),
    type,
    scope,
    category: (o.category || 'general').toLowerCase().trim(),
    visibility: o.visibility === 'private' ? 'private' : 'shared',
    due: /^\d{4}-\d{2}-\d{2}$/.test(o.due || '') ? o.due : null,
    source: (o.source || '').trim() || null,
    dimension: TYPE_DIM[type],
  };
  // the user's own exact-phrase corrections beat the model
  for (const field of ['type', 'category', 'scope', 'visibility', 'source']) {
    const ex = exactGuess(field, c.raw);
    if (ex) c[field] = ex;
  }
  return c;
}

// Shared Gemini call: parts in, schema-constrained JSON out, null on any
// failure so callers can fall back gracefully.
async function callGemini(parts, schema, timeoutMs = 20000) {
  const key = getKey();
  if (!key) { lastError = 'no API key set'; return null; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0.2,
          },
        }),
      });
    if (!res.ok) {
      lastError = await explainHttp(res);
      console.warn('Stratos agent: Gemini returned', res.status, lastError);
      return null;
    }
    const data = await res.json();
    const txt = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) { lastError = 'Gemini returned no content (was the dump blocked as unsafe?)'; return null; }
    const parsed = JSON.parse(txt);
    lastError = '';
    return parsed;
  } catch (e) {
    lastError = e.name === 'AbortError'
      ? `timed out after ${Math.round(timeoutMs / 1000)}s (slow connection?)`
      : `couldn’t reach Google (${e.message}) — check your connection`;
    console.warn('Stratos agent: falling back —', lastError);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Turn Google's error JSON into one plain sentence pointing at the actual fix.
async function explainHttp(res) {
  let msg = '', status = '';
  try { const j = await res.json(); msg = j.error?.message || ''; status = j.error?.status || ''; }
  catch (e) { try { msg = await res.text(); } catch (e2) {} }
  const m = (msg || '').toLowerCase();
  if (res.status === 400 && m.includes('api key not valid')) return 'that API key isn’t valid — copy it again from aistudio.google.com/apikey';
  if (res.status === 400 && m.includes('api_key')) return 'API key problem — regenerate it at aistudio.google.com/apikey';
  if (res.status === 403 && m.includes('referer')) return 'the key is restricted to certain websites — in Google Cloud, allow annakinz.github.io or remove the HTTP-referrer restriction';
  if (res.status === 403 && (m.includes('service') || m.includes('disabled') || m.includes('has not been used'))) return 'the Generative Language API is turned off for this key’s project — enable it in Google Cloud, then wait a minute';
  if (res.status === 403) return 'access denied (403)' + (msg ? ' — ' + msg : '');
  if (res.status === 404) return 'model “' + MODEL + '” not found for this key — the key may be from a project without access';
  if (res.status === 429) return 'rate-limited (429) — the free tier is temporarily maxed out; try again in a minute';
  return 'Gemini error ' + res.status + (status ? ' ' + status : '') + (msg ? ' — ' + msg : '');
}

// A one-shot health check for the Settings screen: does this key actually work
// right now? Returns { ok, message }.
export async function testKey() {
  if (!getKey()) return { ok: false, message: 'No key entered yet.' };
  const out = await callGemini(
    [{ text: 'Reply with a JSON object {"ok": true}. Nothing else.' }],
    { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] },
    15000);
  return out ? { ok: true, message: 'Working — Gemini is filing your dumps.' }
             : { ok: false, message: lastError || 'unknown error' };
}

// Returns classified items, or null (caller falls back to heuristics).
export async function agentClassify(rawText) {
  const arr = await callGemini([{ text: buildPrompt(rawText) }], RESPONSE_SCHEMA);
  if (!Array.isArray(arr) || !arr.length) return null;
  const items = arr.map(sanitize).filter(Boolean);
  return items.length ? items : null;
}

// Photo → task with auto-breakdown. Show Gemini a picture of the mess and
// get back one parent task plus the concrete steps visible in the image.
const PHOTO_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    scope: { type: 'STRING' },
    category: { type: 'STRING' },
    note: { type: 'STRING' },
    steps: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['title', 'steps'],
};

export async function agentPhotoTasks(dataUrl, hint) {
  const prompt = `You are the filing agent for a family life-tracking app. The user photographs
a situation at home (clutter, a mess, a pile, a broken thing) instead of typing it.
Look carefully at the photo and produce ONE parent task plus concrete steps.

Family members (use ids for "scope"; default "house" for home situations):
${familyContext()}

Rules:
- "title": short name for the overall job (e.g. "Organize the hallway closet").
- "steps": the SPECIFIC actions visible in the photo, one per actual thing that
  needs doing — name the actual items you can see ("put away the clean laundry
  in the blue IKEA bag", "return the shoes by the door to the rack"). 2–8 steps,
  most obvious first. Don't invent work you can't see.
- "note": one or two sentences on what you observed, useful for later.
- "category": short lowercase category (home, laundry, clutter, …).
${hint ? '\nThe user added context with the photo: "' + hint + '"' : ''}${habitContext()}`;

  const b64 = (dataUrl.split(',')[1] || '');
  const out = await callGemini([
    { text: prompt },
    { inline_data: { mime_type: 'image/jpeg', data: b64 } },
  ], PHOTO_SCHEMA, 20000);
  if (!out || !out.title || !Array.isArray(out.steps)) return null;
  let scope = out.scope;
  if (!state.family.some(f => f.id === scope)) scope = 'house';
  return {
    title: out.title.trim(),
    scope,
    category: (out.category || 'home').toLowerCase().trim(),
    note: (out.note || '').trim(),
    steps: out.steps.map(s => String(s).trim()).filter(Boolean).slice(0, 10),
  };
}
