// The v1 "agent": heuristic classification with local learning on top.
// Learned associations (from the user's corrections) always win over rules.
// v2 swaps the inside of classifyOne() for a Claude endpoint call with this
// as the offline fallback — see DESIGN.md for the contract.

import { state, tokens, learnedGuess, exactGuess } from './store.js';

const GROCERY = new Set(('milk eggs egg bread butter cheese yogurt yoghurt apples apple bananas banana coffee tea sugar flour rice pasta cereal oats oatmeal chicken beef pork fish salmon shrimp onions onion garlic potatoes potato tomatoes tomato lettuce spinach carrots carrot cucumber peppers juice ham jam honey snacks crackers chips cookies berries strawberries blueberries grapes oranges lemons limes avocado avocados tortillas beans lentils tofu granola ketchup mustard mayo salsa salt pepper oil vinegar wine beer seltzer soda yeast noodles broth stock frozen icecream ice-cream buttermilk cream').split(' '));

const SUPPLY = ['toilet paper', 'paper towels', 'detergent', 'dish soap', 'dishwasher', 'soap', 'shampoo', 'conditioner', 'toothpaste', 'toothbrush', 'floss', 'batteries', 'light bulb', 'lightbulb', 'trash bags', 'sponges', 'sponge', 'laundry', 'wipes', 'diapers', 'sunscreen', 'band-aids', 'bandaids', 'tissues', 'napkins', 'foil', 'plastic wrap', 'ziploc', 'vacuum bags', 'filters', 'filter'];

const CATEGORY_RULES = [
  { cat: 'health',   re: /\b(dentist|doctor|dr\.|pediatric|appointment|checkup|check-up|vaccine|shot|prescription|meds|medicine|pharmacy|therap|optometrist|glasses|allergy)\b/i },
  { cat: 'school',   re: /\b(school|homework|teacher|class|classroom|recital|practice|tryout|permission slip|field trip|pta|tutoring|camp)\b/i },
  { cat: 'finance',  re: /\b(pay|bill|invoice|tax|taxes|renew|insurance|bank|budget|refund|subscription|mortgage|rent)\b/i },
  { cat: 'home',     re: /\b(fix|repair|leak|gutter|lawn|garden|garage|paint|plumber|electrician|hvac|clean out|declutter|organize|furnace|smoke detector|gate|fence)\b/i },
  { cat: 'errands',  re: /\b(pick up|drop off|return|mail|post office|package|dmv|dry cleaning|library)\b/i },
  { cat: 'planning', re: /\b(plan|book|schedule|reserve|trip|vacation|flight|hotel|birthday|party|gift|present|holiday)\b/i },
];

// Where things are typically bought/ordered — detected in dump text,
// learnable via corrections, filterable in the House view.
const SOURCES = {
  'netto': 'Netto', 'føtex': 'Føtex', 'fotex': 'Føtex', 'rema': 'Rema 1000',
  'bilka': 'Bilka', 'lidl': 'Lidl', 'aldi': 'Aldi', 'meny': 'Meny',
  'brugsen': 'Brugsen', 'coop': 'Coop', 'irma': 'Irma',
  'amazon': 'Amazon', 'wolt': 'Wolt', 'nemlig': 'Nemlig',
  'apotek': 'Apotek', 'pharmacy': 'Apotek', 'matas': 'Matas',
  'ikea': 'IKEA', 'bauhaus': 'Bauhaus', 'jem og fix': 'Jem & Fix',
  'harald nyborg': 'Harald Nyborg', 'normal': 'Normal',
};

export function detectSource(t) {
  for (const [k, name] of Object.entries(SOURCES)) {
    if (new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)) return name;
  }
  return null;
}

const TASK_VERBS = /^(buy|call|email|text|fix|schedule|book|pay|clean|make|send|sign|register|return|plan|order|pick|get|take|bring|find|research|renew|cancel|update|write|ask|check|drop|set|finish|start|organize|declutter|print|fill|submit|read|review|prep|prepare|install|replace|water|walk|wash|sell|donate|remind|rsvp|look)\b/i;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// ---------- dump splitting ----------

export function parseDump(text) {
  const out = [];
  for (let line of text.split(/\n+/)) {
    line = line.trim().replace(/^[-*•]\s*/, '');
    if (!line) continue;
    // short comma lists ("milk, eggs, coffee") become separate items
    const parts = line.split(/,\s*/);
    if (parts.length >= 2 && parts.every(p => p.trim().split(/\s+/).length <= 3)) {
      for (const p of parts) if (p.trim()) out.push(p.trim());
    } else {
      out.push(line);
    }
  }
  return out;
}

// ---------- date parsing ----------

function isoDaysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export function parseDue(text) {
  const t = text.toLowerCase();
  if (/\btoday\b|\btonight\b/.test(t)) return isoDaysFromNow(0);
  if (/\btomorrow\b/.test(t)) return isoDaysFromNow(1);
  if (/\bnext week\b/.test(t)) return isoDaysFromNow(7);
  if (/\bthis weekend\b|\bweekend\b/.test(t)) {
    const dow = new Date().getDay();
    return isoDaysFromNow(((6 - dow) + 7) % 7 || 7);
  }
  for (let i = 0; i < 7; i++) {
    if (new RegExp('\\b(by |before |on )?' + WEEKDAYS[i] + '\\b').test(t)) {
      const dow = new Date().getDay();
      let diff = (i - dow + 7) % 7;
      if (diff === 0) diff = 7;
      return isoDaysFromNow(diff);
    }
  }
  const md = t.match(/\b(\d{1,2})\/(\d{1,2})\b/); // 6/12
  if (md) {
    const d = new Date();
    d.setMonth(+md[1] - 1, +md[2]);
    if (d < new Date()) d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  }
  for (let m = 0; m < 12; m++) {
    const re = new RegExp('\\b' + MONTHS[m] + '\\.?\\s+(\\d{1,2})\\b|\\b(\\d{1,2})\\s+' + MONTHS[m] + '\\b');
    const hit = t.match(re) || t.match(new RegExp('\\b' + MONTHS[m].slice(0, 3) + '\\.?\\s+(\\d{1,2})\\b'));
    if (hit) {
      const day = +(hit[1] || hit[2]);
      const d = new Date();
      d.setMonth(m, day);
      if (d < new Date()) d.setFullYear(d.getFullYear() + 1);
      return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

// ---------- classification ----------

function detectScope(text) {
  const t = text.toLowerCase();
  for (const f of state.family) {
    if (f.id === 'house') continue;
    if (f.name && new RegExp('\\b' + f.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)) return f.id;
  }
  return null;
}

function matchSupply(t) {
  for (const s of SUPPLY) if (t.includes(s)) return true;
  return false;
}

function isGrocery(t) {
  const words = t.split(/\s+/);
  return words.length <= 4 && words.some(w => GROCERY.has(w.replace(/[^a-zæøå]/g, '')));
}

export function classifyOne(raw) {
  const t = raw.toLowerCase().trim();
  const toks = tokens(raw);
  const due = parseDue(raw);
  const words = t.split(/\s+/);

  let type, scope, category, dimension;

  if (isGrocery(t)) {
    type = 'supply'; scope = 'house'; category = 'groceries'; dimension = 'restock';
  } else if (matchSupply(t)) {
    type = 'supply'; scope = 'house'; category = 'supplies'; dimension = 'restock';
  } else if (TASK_VERBS.test(t) || due) {
    type = 'task'; dimension = 'priority';
  } else if (/\b(want to|goal|learn|start (doing|being)|habit)\b/.test(t)) {
    type = 'goal'; dimension = 'priority';
  } else if (words.length <= 3) {
    // bare noun-ish phrase with no action verb reads as a difficulty ("insomnia")
    type = 'issue'; dimension = 'difficulty';
  } else {
    type = 'task'; dimension = 'priority';
  }

  if (!category) {
    for (const r of CATEGORY_RULES) {
      if (r.re.test(t)) { category = r.cat; break; }
    }
  }
  if (!category) category = type === 'issue' ? 'wellbeing' : 'general';

  if (!scope) scope = detectScope(raw) || state.profile;
  if (/\b(house|home|kitchen|bathroom|garage|yard)\b/.test(t) && !detectScope(raw)) {
    if (category === 'home') scope = 'house';
  }

  // household default is shared — but a struggle is yours until you share it
  let visibility = type === 'issue' ? 'private' : 'shared';
  let source = detectSource(t);
  if (source && !isGrocery(t) && !matchSupply(t) && type === 'task') {
    // "order dog food on wolt" style lines are usually purchases
    if (/\b(order|buy|get|pick up)\b/.test(t)) category = category === 'general' ? 'shopping' : category;
  }

  // learned corrections override everything (that's the point):
  // exact phrase memory first (one correction is enough), then
  // token generalization (needs corroboration to beat the rules)
  for (const field of ['type', 'category', 'scope', 'visibility', 'source']) {
    const ex = exactGuess(field, raw);
    const lg = ex ? null : learnedGuess(field, toks, 2);
    const v = ex || (lg && lg.value);
    if (v) {
      if (field === 'type') type = v;
      else if (field === 'category') category = v;
      else if (field === 'scope') scope = v;
      else if (field === 'source') source = v;
      else visibility = v;
    }
  }

  const title = raw.trim().replace(/\s+/g, ' ').replace(/^(.)/, c => c.toUpperCase());

  return { raw, title, type, scope, category, visibility, due, dimension, source };
}

export function defaultDimension(item) {
  return { task: 'priority', goal: 'priority', issue: 'difficulty', supply: 'restock' }[item.type] || 'priority';
}
