// The v1 "agent": heuristic classification with local learning on top.
// Learned associations (from the user's corrections) always win over rules.
// v2 swaps the inside of classifyOne() for a Claude endpoint call with this
// as the offline fallback — see DESIGN.md for the contract.

import { state, tokens, learnedGuess, exactGuess } from './store.js';

const GROCERY = new Set(('milk eggs egg bread butter cheese yogurt yoghurt skyr kefir apples apple bananas banana coffee tea sugar flour rice pasta cereal cereals cornflakes flakes muesli weetabix porridge cheerios granola oats oatmeal chicken beef pork bacon sausage sausages mince turkey lamb fish salmon cod tuna shrimp prawns herring onions onion garlic potatoes potato tomatoes tomato lettuce salad spinach kale carrots carrot cucumber peppers pepper broccoli cauliflower mushrooms mushroom zucchini courgette celery leek leeks cabbage corn peas juice ham jam honey nutella hummus pesto olives snacks crackers chips cookies biscuits chocolate popcorn nuts raisins berries strawberries blueberries raspberries grapes oranges orange lemons lemon limes lime melon watermelon pineapple mango avocado avocados tortillas wraps pita bagels croissants muffins beans lentils chickpeas tofu ketchup mustard mayo mayonnaise salsa soy salt pepper oil vinegar wine beer seltzer soda yeast noodles broth stock frozen icecream ice-cream buttermilk cream margarine quinoa couscous coconut ginger cilantro parsley basil dill cinnamon vanilla syrup mælk letmælk sødmælk minimælk kærnemælk fløde piskefløde ost smør æg cremefraiche hytteost mel sukker gær havregryn gryn ris nudler linser kikærter bønner dåsetomater tomatpuré bouillon suppe kanel vanilje bagepulver kokosmælk sojasauce soya olie olivenolie eddike sennep remoulade honning marmelade syltetøj peanutbutter rugbrød franskbrød brød boller knækbrød pitabrød kage kiks æbler æble bananer banan appelsiner appelsin citron citroner jordbær blåbær hindbær druer vandmelon ananas løg rødløg hvidløg kartofler kartoffel tomat tomater agurk salat spinat grønkål gulerødder gulerod peberfrugt blomkål squash champignon svampe porre kål majs ærter ingefær persille dild basilikum koriander purløg kylling oksekød svinekød pølser pølse skinke spegepølse kalkun lammekød fisk laks torsk tun rejer sild frikadeller medister hakket saft vand danskvand sodavand kaffe te øl vin kakao slik chokolade småkager lakrids nødder tyggegummi flødeis').split(' '));

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

// explicit routing prefix: "ebbe: call the plumber" or "@ebbe fix the gate"
// hands the item to that person and strips the prefix from the title.
function stripAssignee(raw) {
  const s = String(raw);
  const m = s.match(/^\s*@?([\p{L}]+)\s*(?::|-|–)\s+(.+)$/u) || s.match(/^\s*@([\p{L}]+)\s+(.+)$/u);
  if (m) {
    const f = state.family.find(x => x.name && x.name.toLowerCase() === m[1].toLowerCase());
    if (f && f.id !== 'house') return { scope: f.id, text: m[2].trim() };
  }
  return { scope: null, text: s };
}

function matchSupply(t) {
  for (const s of SUPPLY) if (t.includes(s)) return true;
  return false;
}

// ---------- store aisles ----------
// Rough store-geography grouping for Shop mode: things you'd find together.
// First matching section wins; multi-word phrases are checked before single
// words so "ice cream" lands in Frozen, not Dairy via "cream".
const AISLES = [
  ['Produce', 'apple apples banana bananas orange oranges lemon lemons lime limes grapes berries strawberries blueberries raspberries melon watermelon avocado avocados onion onions garlic potato potatoes tomato tomatoes lettuce salad spinach kale carrot carrots cucumber peppers pepper broccoli cauliflower zucchini squash mushroom mushrooms herbs cilantro parsley basil dill ginger fruit fruits vegetable vegetables leek leeks cabbage beets celery corn scallions æbler æble bananer banan appelsiner appelsin citron citroner lime jordbær blåbær hindbær druer melon vandmelon ananas mango avocado løg rødløg hvidløg kartofler kartoffel tomat tomater agurk salat spinat grønkål gulerødder gulerod peberfrugt broccoli blomkål squash champignon svampe porre kål majs ærter ingefær persille dild basilikum koriander purløg frugt grønt grøntsager'],
  ['Frozen', 'frozen icecream ice-cream "ice cream" popsicles "fish sticks" "frozen pizza" frost frossen frostvarer flødeis isterninger "frosne ærter" "frossen pizza"'],
  ['Dairy & eggs', 'milk buttermilk cream "whipping cream" cheese yogurt yoghurt skyr butter eggs egg margarine "cream cheese" "cottage cheese" kefir mælk letmælk sødmælk minimælk kærnemælk fløde piskefløde ost "revet ost" yoghurt skyr smør æg cremefraiche "creme fraiche" hytteost margarine mejeri'],
  ['Meat & fish', 'chicken beef pork bacon sausage sausages ham salami turkey lamb mince meatballs fish salmon cod tuna shrimp prawns herring "deli meat" hotdogs frikadeller kylling oksekød "hakket oksekød" hakket svinekød bacon pølser pølse skinke spegepølse kalkun lammekød fisk laks torsk tun rejer sild frikadeller medister kød pålæg'],
  ['Bread & bakery', 'bread rolls buns bagels baguette croissant croissants rugbrød tortillas pita "hot dog buns" cake pastry pastries rugbrød franskbrød brød boller knækbrød pitabrød kage bagværk'],
  ['Drinks', 'juice soda seltzer "sparkling water" water coffee tea beer wine kombucha lemonade cocoa "oat milk" "almond milk" "soy milk" juice saft vand danskvand sodavand kaffe te øl vin kakao drikkevarer'],
  ['Snacks & sweets', 'snacks chips crackers cookies candy chocolate licorice gum popcorn "granola bars" nuts raisins "dried fruit" biscuits sweets marzipan slik chokolade chips småkager lakrids nødder popcorn tyggegummi kiks'],
  ['Pantry', 'pasta noodles rice oats oatmeal cereal granola flour sugar yeast salt oil vinegar ketchup mustard mayo mayonnaise salsa jam honey "peanut butter" nutella beans lentils chickpeas tofu broth stock soup "canned tomatoes" "tomato paste" spices cinnamon vanilla "baking powder" "baking soda" couscous quinoa tahini "soy sauce" curry pesto mel sukker gær havregryn gryn ris pasta nudler linser "røde linser" kikærter bønner dåsetomater "hakkede tomater" tomatpuré bouillon suppe kanel vanilje bagepulver couscous kokosmælk sojasauce soya olie olivenolie eddike ketchup sennep remoulade mayonnaise honning marmelade syltetøj peanutbutter krydderi kolonial'],
  ['Household', '"toilet paper" "paper towels" detergent "dish soap" dishwasher "trash bags" sponges sponge foil "plastic wrap" ziploc batteries "light bulb" lightbulb candles matches laundry napkins "vacuum bags" cleaner bleach toiletpapir køkkenrulle opvaskemiddel vaskemiddel skyllemiddel affaldsposer karklude opvaskesvampe stanniol husholdningsfilm batterier pære lys tændstikker rengøring'],
  ['Personal care', 'soap shampoo conditioner toothpaste toothbrush floss deodorant lotion sunscreen "band-aids" bandaids tissues wipes diapers razors "cotton pads" vitamins painkillers plasters medicine tandpasta tandbørste shampoo balsam sæbe deodorant barberblade creme solcreme bleer vådservietter bind tamponer plaster håndsprit'],
];
// parse a [name, spec] table into { name, words:Set, phrases:[] } once
function parseSpecs(table) {
  return table.map(([name, spec]) => {
    const phrases = [], words = new Set();
    for (const m of spec.match(/"[^"]+"|\S+/g) || []) {
      if (m.startsWith('"')) phrases.push(m.slice(1, -1).replace(/"$/, ''));
      else words.add(m);
    }
    return { name, words, phrases };
  });
}
// phrases beat single words across ALL sections — "peanut butter" is Pantry
// even though "butter" alone is Dairy
function matchSpecs(defs, title) {
  const t = ' ' + String(title || '').toLowerCase() + ' ';
  const words = t.split(/[^a-zæøåöä-]+/).filter(Boolean);
  for (const a of defs) for (const p of a.phrases) if (t.includes(p)) return a.name;
  for (const a of defs) for (const w of words) if (a.words.has(w)) return a.name;
  return null;
}
const AISLE_DEFS = parseSpecs(AISLES);
export function aisleOf(title) { return matchSpecs(AISLE_DEFS, title) || 'Other'; }

// ---------- packing groups ----------
// Auto-categorizer for packing lists: suitcase geography instead of store
// geography. Anything mentioning a child's name goes to Kids first — that
// beats every keyword ("Kiva's charger" is Kids, not Electronics).
const PACK_GROUPS = [
  ['Electronics', 'ipad ipads tablet phone phones charger chargers "charging cable" "charging cables" cable cables "power adapter" "power adapters" adapter adapters powerbank "power bank" headphones earbuds airpods kindle "e-reader" ereader laptop macbook camera gopro "memory card" batteries "travel plug" plug plugs switch nintendo controller drone'],
  ['Documents & money', 'passport passports tickets ticket visa visas "boarding pass" "boarding passes" insurance id "id cards" wallet cash money "credit card" "credit cards" "travel card" itinerary reservations "drivers license" license bookings currency'],
  ['Health & meds', 'inhaler inhalers medicine medicines medication medications meds painkillers ibuprofen paracetamol antihistamine "band-aids" bandaids plasters "first-aid" "first aid" thermometer vitamins prescription prescriptions "motion sickness" seasickness epipen "hand sanitizer"'],
  ['Toiletries', 'toothbrush toothbrushes toothpaste floss shampoo conditioner soap deodorant razor razors "shaving cream" hairbrush comb makeup "make-up" moisturizer lotion sunscreen "after sun" aftersun "lip balm" perfume tweezers "nail clippers" "contact lenses" contacts "lens solution" glasses sunglasses "hair ties" wipes'],
  ['Clothes & shoes', 'socks underwear undies bras shirts shirt "t-shirts" tshirts tops shorts pants trousers jeans dresses dress skirts sweater sweaters hoodie hoodies jacket jackets coat rainjacket "rain jacket" pajamas pyjamas nightwear belt hats hat cap scarf gloves shoes sneakers sandals flipflops "flip flops" boots swimsuit swimsuits bikini "swim trunks" trunks rashguard "laundry bag"'],
  ['Beach & pool', 'towel towels "beach towel" "beach towels" goggles snorkel "snorkel gear" floaties "water wings" "beach toys" "beach bag" "sand toys" bucket spade parasol "beach umbrella" "swim diapers" "pool noodles"'],
  ['Kids', 'diapers nappies stroller "car seat" "baby monitor" pacifier dummy bottles formula bib bibs "baby food" toys toy legos lego "coloring books" crayons "card games" "board games" games puzzles "stuffed animal" "stuffed animals" teddy blanket blankie'],
  ['Food & snacks', 'snacks water "water bottle" "water bottles" thermos "travel mug" coffee tea "granola bars" fruit sandwiches gum "trail mix" cooler "lunch box"'],
  ['Comfort & travel', 'pillow "neck pillow" "eye mask" earplugs "ear plugs" book books magazine magazines journal notebook pen umbrella "day pack" daypack backpack "packing cubes" locks "luggage tags" "sleeping bag" "travel blanket"'],
];
const PACK_DEFS = parseSpecs(PACK_GROUPS);
export function packGroupOf(title) {
  const t = String(title || '').toLowerCase();
  // the household's own kids outrank every keyword
  for (const f of state.family) {
    if (f.user || f.id === 'house' || !f.name) continue;
    if (t.includes(f.name.toLowerCase())) return 'Kids';
  }
  return matchSpecs(PACK_DEFS, title); // null when nothing matches — stays ungrouped
}

// felt states / struggles that belong in wellbeing rather than as to-dos
const ISSUE_CUES = /\b(insomnia|sleepless|can'?t sleep|anxious|anxiety|stress(ed)?|overwhelm(ed)?|exhaust(ed|ion)|burn ?out|burnt ?out|tired|fatigue|drained|depress(ed|ion)|sad|lonely|lonel|down|worried|worry|fear|afraid|panic|grief|griev|angry|frustrat|restless|headache|migraine|nausea|dizzy|mood|unmotivated|procrastinat|overwhelmed|guilt|shame|resentment)\b/i;

function isGrocery(t) {
  const words = t.split(/\s+/);
  return words.length <= 4 && words.some(w => GROCERY.has(w.replace(/[^a-zæøå]/g, '')));
}

export function classifyOne(raw) {
  const assign = stripAssignee(raw);
  const body = assign.text;                 // the task text without any "name:" prefix
  const t = body.toLowerCase().trim();
  const toks = tokens(body);
  const due = parseDue(body);
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
  } else if (ISSUE_CUES.test(t)) {
    // a felt struggle ("insomnia", "so stressed") is a wellbeing issue…
    type = 'issue'; dimension = 'difficulty';
  } else {
    // …but a bare noun ("cornflakes", "new tires") is just a to-do. Defaulting
    // these to a visible task (not a hidden wellbeing issue) means a
    // misfile is easy to spot and correct — and the correction is what teaches.
    type = 'task'; dimension = 'priority';
  }

  if (!category) {
    for (const r of CATEGORY_RULES) {
      if (r.re.test(t)) { category = r.cat; break; }
    }
  }
  if (!category) category = type === 'issue' ? 'wellbeing' : 'general';

  if (!scope) scope = assign.scope || detectScope(body) || state.profile;
  if (/\b(house|home|kitchen|bathroom|garage|yard)\b/.test(t) && !assign.scope && !detectScope(body)) {
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
  // exact phrase memory first (one correction is always enough), then
  // token generalization. Category/scope/source apply after a SINGLE
  // correction (a shared distinctive word is enough — "remember it"),
  // while type/visibility want corroboration since they're more structural
  // and privacy shouldn't flip from one stray match.
  // One correction is enough to generalize everything except privacy, which
  // still wants corroboration (a stray match must never expose a private item).
  // Type used to need two — that's what made "this is a grocery, not a task"
  // feel like it never sank in.
  const MIN_SCORE = { type: 1, category: 1, scope: 1, visibility: 2, source: 1 };
  for (const field of ['type', 'category', 'scope', 'visibility', 'source']) {
    const ex = exactGuess(field, body);
    const lg = ex ? null : learnedGuess(field, toks, MIN_SCORE[field]);
    const v = ex || (lg && lg.value);
    if (v) {
      if (field === 'type') type = v;
      else if (field === 'category') category = v;
      else if (field === 'scope') scope = v;
      else if (field === 'source') source = v;
      else visibility = v;
    }
  }
  if (assign.scope) scope = assign.scope;      // an explicit "name:" prefix wins

  const title = body.trim().replace(/\s+/g, ' ').replace(/^(.)/, c => c.toUpperCase());

  return { raw, title, type, scope, category, visibility, due, dimension, source };
}

// ---------- batch context ----------
// A brain dump is usually ONE kind of list. When you dump a grocery run, most
// lines are recognizable food — so the odd unknown ("bran flakes", "skyr", a
// brand name) shouldn't land as a stray task just because it isn't in the
// vocabulary. If the dump reads as a shopping list, unknown short noun-ish
// lines join it. Task-shaped lines (a verb, a due date) are never absorbed.
export function classifyDump(text) {
  const lines = parseDump(text);
  const out = lines.map(classifyOne);
  const shoppy = out.filter(c => c.type === 'supply').length;
  // "mostly groceries": at least 2 recognized, and they're the plurality
  if (shoppy < 2 || shoppy * 2 < out.length) return out;
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c.type !== 'task' || c.due) continue;              // keep real to-dos
    const t = (lines[k] || '').toLowerCase().trim();
    if (TASK_VERBS.test(t)) continue;                      // "call the plumber" stays a task
    if (t.split(/\s+/).length > 4) continue;               // long lines aren't groceries
    if (exactGuess('type', lines[k])) continue;            // you've already taught this one
    c.type = 'supply'; c.scope = 'house'; c.dimension = 'restock';
    if (c.category === 'general') c.category = 'groceries';
    c.viaBatch = true;                                     // for the "filed as groceries" note
  }
  return out;
}

export function defaultDimension(item) {
  return { task: 'priority', goal: 'priority', issue: 'difficulty', supply: 'restock' }[item.type] || 'priority';
}
