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

function buildPrompt(rawText) {
  const today = new Date();
  const family = state.family.map(f =>
    `- id "${f.id}" = ${f.name}${f.user ? ' (adult user)' : f.id === 'house' ? ' (the household itself: groceries, supplies, house tasks)' : ' (child)'}`).join('\n');
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
- "visibility": "private" only if it's clearly personal/sensitive or a gift/surprise
  for another family member; otherwise "shared".
- "raw": the exact fragment of the dump this item came from.
${corrections ? '\nThe user has corrected past filings — follow these patterns:\n' + corrections : ''}

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
    dimension: TYPE_DIM[type],
  };
  // the user's own exact-phrase corrections beat the model
  for (const field of ['type', 'category', 'scope', 'visibility']) {
    const ex = exactGuess(field, c.raw);
    if (ex) c[field] = ex;
  }
  return c;
}

// Returns classified items, or null (caller falls back to heuristics).
export async function agentClassify(rawText) {
  const key = getKey();
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(rawText) }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2,
          },
        }),
      });
    if (!res.ok) {
      console.warn('Stratos agent: Gemini returned', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || !arr.length) return null;
    const items = arr.map(sanitize).filter(Boolean);
    return items.length ? items : null;
  } catch (e) {
    console.warn('Stratos agent: falling back to built-in rules —', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
