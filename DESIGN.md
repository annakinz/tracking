# Stratos — a family life-tracking app

*Working title. A brain-dump-first tracker whose job is to **alleviate cognitive load**: get it out of your head instantly, trust an agent to file it, and express importance spatially instead of filling out forms.*

This document is the **source of truth**. The app is intentionally "composable software": small, dependency-free, and rebuildable from this spec at any time. If we ever want to rewrite it (different framework, native, whatever), this file — not the code — is what we rebuild from.

## Users

- **Anna** and **Ebbe** are the two *users* (log in, dump, size, filter).
- The two kids and the **House** are *scopes*: people/places items belong to, but not users.
- Privacy: items are **shared by default**; either user can mark an item private. The agent learns over time which kinds of items each user tends to keep private and starts suggesting/applying it.

## The three moments

The product is the strict separation of three mental modes. Never mix them.

### 1. Dump — zero-friction capture
- One big text box (plus mic later). Type or dictate anything, multiple items at once.
- **No fields, no dropdowns, no decisions.** The agent splits the text into items and files each one: title, type, scope (person/house), category, visibility, due date if one is mentioned.
- Every filed item is shown briefly with its classification so you *see* the trust being earned; tap to correct. Corrections feed the agent's learning.
- Newly dumped items land in the **Inbox** (unsized).

### 2. Size — the magnitude interface
Sizing is a dedicated, game-like session. Items from the inbox appear one at a time as a **bubble** floating in a **stratosphere**.

- **Gesture**: two-finger pinch grows/shrinks the bubble (one-finger vertical drag and mouse wheel also work). Growing past the top of the current stratum makes the bubble **jump scopes** — it leaves the current band and enters the next stratosphere up, where it appears small again among that band's (bigger) items. Shrinking does the reverse.
- **Strata are discrete and exponential.** Default 7 bands per dimension; each band represents roughly double the magnitude of the one below. Within a band, the bubble's size is continuous (stored as a fraction), so ordering *within* a stratum is preserved too.
- **Peers**: entering a stratum shows the other items already living there, at their relative sizes. Comparison ("is this bigger than *that*?") is the whole judgment.
- **Insertable strata**: if something belongs *between* 6 and 7, insert a new stratum; everything above renumbers automatically. (Items reference strata by stable id, not number, so renumbering is free.)
- Tap **OK** → magnitude recorded → next inbox item appears. When the queue is empty you're returned to your list.

**Typed magnitude — what the size *means* depends on the item:**

| Item type | Default dimension |
|---|---|
| task | **priority** (importance) |
| issue/difficulty (e.g. "insomnia") | **difficulty** |
| supply/grocery | **restock urgency** |
| goal | **priority** |

When entering the sizing mode from a list, you can switch which dimension you're sizing (priority / effort / difficulty / dread / restock) via chips — e.g. do an *effort pass* over your tasks. Every dimension is independently sortable and filterable.

Dimensions (extensible):
- **priority** — how important
- **effort** — how long it'll take
- **difficulty** — how hard
- **dread** — activation energy / how avoided (surfaces small-but-avoided tasks)
- **restock** — how urgently a supply needs replenishing

### 3. Live — lists that organize themselves
- Filter by person (Anna / Ebbe / each kid / House), by visibility (shared / private), by category, by status.
- Sort by any magnitude dimension, due date, or recency.
- **Deadline gravity**: items with a due date self-inflate as the date nears. Effective priority = sized priority + gravity boost (0 beyond 14 days, ramping to +3 strata when due/overdue). Gravity is visual (item swells, flame indicator) and affects sorting — an approaching dentist appointment climbs into "on fire" without anyone touching it.
- Tap an item → detail sheet: correct category/type/scope/visibility, set due date, resize any dimension, mark done, delete. Every correction teaches the agent.
- **Surfacing, never nagging**: surfacing is a UX stance, not a notification setting. When something needs your eyes, **the app visibly changes its normal patterns** because it cares that you see it: the Dump screen (the landing tab) grows a glowing "👁 surfacing now" strip, the Lists tab itself glows, and surfaced items sit above everything with the reason attached. What surfaces: (a) items whose due date is inside the gravity window, and (b) **stale high-dread items** — sized dread ≥ stratum 5 and sitting untouched a week+. Dread is the signal for *why something isn't getting done*; making it impossible to not-see inside the app is the whole intervention. Nothing ever pushes outside the app, and there are no red badges or guilt mechanics.
- **Done** items are archived, not deleted — the archive is training data.

## Household mode
- The **House** scope has its own view: groceries and supplies with quick-add, sorted by restock urgency.
- "Bought" checks an item off; a re-add button resurrects a past item into the inbox (recurring purchases without recurrence machinery).

## The agent

### v1 (client-side, no server)
- Heuristic classifier: splits dump text into items (newlines, short comma lists), detects type (verb-led → task; bare noun like "insomnia" → issue; grocery/supply lexicon → supply), scope (family member names, house items), category (health, school, errands, home, finance, planning, groceries, supplies, …), and due dates (natural phrases: "tomorrow", "by Friday", "June 12").
- **Local learning loop**: every user correction is recorded as token→field-value evidence. The classifier consults learned associations *before* built-in rules, so it genuinely adapts to how this family classifies. Visibility is learned the same way (repeatedly marking a kind of item private teaches the default).

### v2 (Gemini, no backend) — shipped
Dumps are filed by **Gemini** (`gemini-2.5-flash`, free tier) called **directly from the device** — no server at all. Each device holds its own API key (Settings → agent; free from aistudio.google.com/apikey), stored only in that device's localStorage and excluded from data exports.

The prompt carries: today's date, who is dumping, the family roster with ids, categories already in use, and the **last ≤50 corrections** — so the model personalizes to how this family classifies without any training infrastructure. Output is schema-constrained JSON (`responseSchema`), sanitized on the client (unknown scopes/types fall back safely), and the user's own **exact-phrase corrections still override the model**.

Fallback chain: no key / offline / any API error → the local heuristic classifier. The app is never blocked on the network.

## Data model (JSON, localStorage in v1)

```js
item = {
  id, createdAt, createdBy,        // 'anna' | 'ebbe'
  raw,                             // original dump text, never lost
  title, type,                     // task | issue | supply | goal
  scope,                           // family member id | 'house'
  category, visibility,            // 'shared' | 'private'
  due,                             // ISO date or null
  dims: { priority: { s: stratumId, f: 0.62, at }, ... },
  status,                          // inbox | active | done
  agentGuess: { ... }              // what the agent originally said (for learning)
}
dims  = { priority: { label, strata: [{id, label}, …] }, … }   // insertable, renumber-safe
learned = { category: { token: { value: count } }, scope: {…}, visibility: {…}, type: {…} }
```

## Platform & architecture

- **PWA**, installable, offline-first (service worker, cache-first). No build step, no dependencies: plain HTML/CSS/JS modules — trivially hostable (GitHub Pages), trivially rebuildable.
- Viewport pinch-zoom is disabled so the sizing gesture owns the pinch.
- v1 storage is per-device (localStorage) with JSON export/import for moving data.
- Profiles: device picks Anna or Ebbe at first run (switchable in settings). Private items are hidden from the other profile. *Note: on a shared device this is curtains, not a vault — real enforcement arrives with the sync backend.*

## Roadmap

1. **v1 (shipped)**: dump → heuristic agent → bubble sizing → lists, household mode, deadline gravity, two profiles + visibility, local learning, export/import.
2. **v2 (shipped)**: Gemini classification from the device (above); surfacing section (deadline gravity + stale high-dread).
3. **Sync**: small backend (Supabase or a worker + KV) so Anna's and Ebbe's phones share one household in real time; real per-user auth makes privacy enforceable.
4. **Voice dump**: Web Speech API where available; keyboard dictation works today.
5. Maybe: nudges (opt-in only — e.g. "this small dreaded thing is 3 weeks old"), kid accounts, recurring items, shared sizing sessions ("couch triage").

## Design principles

- Capture must never ask a question.
- Magnitude is felt, not picked from a list.
- The agent proposes, the human corrects, the agent learns. Corrections are the product's fuel — make correcting *one tap cheaper* than tolerating a mistake.
- No guilt engine: no red badges for overdue except true deadline gravity; done is archive, not judgment.
- Surface, never nag: when something matters *now*, the app's own patterns visibly change so you can't help but see it — but nothing ever pushes outside the app into your life.
