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

### 2. Size — the bubble universe
The Size tab opens the **universe**: every active item at once, as a bubble whose **size and height are set by its priority** — the biggest, most urgent things crowd the top ("on fire ↑"), tapering down to small "someday" bubbles at the bottom, each in its category color, over a warm-to-cool sky. Unsized items wait in a tray at the very bottom. It's the surfacing idea made total — you *see* the whole shape of your obligations at a glance.

Bubbles gently drift (each its own speed/phase) and a relaxation pass keeps them from overlapping — so it stays legible. Three gestures on a bubble:
- **Tap → peek**: a little card with the item's full title + meta and quick **resize / edit** actions. (So small bubbles need no text; tap reveals them.)
- **Two-finger pinch → size**: pinch a bubble and you drop straight into the stratosphere sizer *already resizing* — the universe stays mounted underneath so the same pinch keeps driving the size while the sizer fades in over it (no "resize" tap). Release to commit to the sizer.
- **Long-press → edit**: straight to the full edit sheet.
- **Flick → nudge**: shove a bubble aside; the others settle around it.

From the peek's **resize** (or a list row) you **zoom into the item's stratum** — the sizer, its band's peers visible for comparison (below), pinch to resize; **tap the hero there again → edit**; **"◯ all" (top-left) zooms back out**.

Zoomed in, it's the magnitude interface — a **bubble** in a **stratosphere**:

- **Gesture**: two-finger pinch grows/shrinks the bubble (one-finger vertical drag and mouse wheel also work). Growing past the top of the current stratum makes the bubble **jump scopes** — it leaves the current band and enters the next stratosphere up. Crucially the bubble is sized by **absolute magnitude on one continuous exponential curve** (a small seed at the bottom, bursting past the screen edges at the top) — so growth *never resets*. When it crosses into a higher band it keeps its size; it looks "small again" only because that band's peers are genuinely bigger. The effect is flying up past the little ones rather than snapping back to tiny. A springy pulse + the new band's peers rushing up mark each crossing.
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
The app opens here. Two modes via a segmented toggle:
- **Priority (default)**: one **flat, global ranked list** across every category. Priority is what you actually do with your time — a work thing and a home thing compete for the same hours, so they belong in one ranking, not siloed. Each row keeps its category color, so the ranked list is still a legible mix.
- **Categories**: grouped by category, ranked within each (for when you want to work a single area).

The sort dropdown chooses the dimension in either mode (default priority); filter by person, visibility, status.

**Row interaction model** (the row is the primary surface):
- **Tap the row body → resize** it on the dimension the list is currently ranked by. Re-sizing is the most common act, so it's the default tap.
- **Tap a chip (category, who, due, source, loop, visibility) → a quick-edit popover** for just that field: pick a value inline, or hit "✎ edit all…" to jump to the full sheet. Categories you've used appear as one-tap options.
- **Tap the progress ring (◉ 2/5) → the bubble interior** (the item's steps as bubbles).
- **✓** finishes the item; **✎** (coral pencil, far right) opens the full edit sheet — correct anything, resize any dimension, notes/photos/steps, delete. Every correction teaches the agent.
- **Deadline gravity**: items with a due date self-inflate as the date nears. Effective priority = sized priority + gravity boost (0 beyond 14 days, ramping to +3 strata when due/overdue). Gravity is visual (item swells, flame indicator) and affects the ranking — an approaching dentist appointment climbs to the top without anyone touching it.
- **Surfacing, never nagging**: surfacing is an interruption of the app's own flow, not a labeled list section. When something needs your eyes, **it floats before anything else**: opening the app lands you on a full-screen **takeover** — the surfaced items as gently drifting bubbles, sized by urgency with the reason attached, on a hot ember-orange field (saturated warm orange is the arousal/energy end of the palette — motivating without red's alarm connotations, and the only place the color appears, so it never dilutes). Tapping a bubble opens that item to act on; getting to the rest of the app is the explicit, secondary path ("everything else ↓"). Inside the app, the Lists tab keeps an ember signal and surfaced items sit above all grouping. What surfaces: (a) items inside the deadline/loop gravity window, and (b) **stale high-dread items** — sized dread ≥ stratum 5 and untouched a week+ (dread is the signal for *why something isn't getting done*). Nothing ever pushes outside the app, and there are no red badges or guilt mechanics.
- **Done** items are archived, not deleted — the archive is training data.

## Household mode
- The **House** scope has its own view: groceries and supplies with quick-add, sorted by restock urgency.
- "Bought" checks an item off; a re-add button (or just dumping it again) resurrects the same item.
- **Store-run mode**: when items have sources, the House view grows filter chips (Netto / Føtex / Wolt / Amazon / …) — standing in a shop, filter to what you usually get there.

## Loops — recurrence, set or discovered

Some items aren't tasks that end; they're **rhythms** (milk, dishwasher tabs, cutting the kids' nails). Loops make that first-class:

- **Identity, not duplicates**: dumping something whose normalized name matches an existing item in the same scope *reactivates that item* instead of creating a copy. "Milk" is one living object that cycles forever, accumulating history.
- **Discovery**: every recurrence is timestamped. From 3+ occurrences the app learns the rhythm — median gap in days — and marks the item "🔁 ~5d (learned)". No setup required; buying milk is the setup.
- **Manual**: any item's detail sheet can set/override/remove "loop every N days".
- **Loop gravity**: a completed loop item rests, then automatically reawakens at ~60% of its cycle and inflates toward the predicted run-out date (`last done + cycle`), exactly like deadline gravity — the milk bubble grows as you're probably running low. At full cycle it surfaces ("🔁 every ~5d — probably needed").
- Previously sized loop items keep their magnitudes on reactivation; unsized ones return to the inbox for a sizing pass.

## Sources — where things come from

Items can carry a **source** (Netto, Føtex, Rema 1000, Bilka, Lidl, Amazon, Wolt, Nemlig, Apotek, IKEA, …): detected from dump text ("order dog food on wolt"), learned from corrections like every other field, editable in the detail sheet, and understood by the Gemini agent. Sources power store-run filtering, and over time the correction history teaches the agent this family's shopping map.

## Inside an item — notes, links, photos, steps

Capture stays bare (a dump line is just words), but an item can grow rich once it exists:

- **Notes**: free text on every item. URLs pasted anywhere in the notes automatically become tappable link chips (hostname shown). Items with content show a 📎 in lists.
- **Photos**: attach images (the broken part, the permission slip, the screenshot). Client-side downscaled (~1000px JPEG) and stored inline for now; the sync milestone moves media to real storage.
- **Steps**: any item can be broken into subtasks — real items with their own notes, dates, sizing, and even their own steps. Steps live inside the parent, not as top-level list rows; the parent shows progress (◔ 2/5). Steps can still *surface* on their own merits (a step's due date is a real due date).
- **The bubble interior**: an item with steps *is a bubble containing bubbles*. Opening it — from a list, the takeover, anywhere — enters the parent circle with its steps floating inside, sized by priority. Check a step off in place, tap one to dive deeper (steps can have steps), "＋ step" to add, "details" for the full sheet. A photo dump lands exactly here: tap the filed card and you're inside the job, looking at its visible pieces.
- **Task → goal**: breaking a task into 2+ real steps quietly promotes it to a **goal** — a thing you're working toward rather than doing. Like every agent move, it's visible and correctable (the Type field is right there).

## Visual language — the Sorbet system

Chosen deliberately; **every future feature obeys these rules.** The point of writing them down is discipline: no new colors, fonts, or shadow styles without amending this section first.

1. **Ground & type**: paper ground (`#FBFBF7`), ink type (`#23262E`). Chrome (tab bar, header, inputs) is neutral — paper, white, hairline `#E9E9DF`. Color belongs to *content*, never to chrome.
2. **The category law**: every category owns a sorbet swatch — pale tint washes its whole card, the saturated tone is its dot, the deep tone is its heading. Known categories have fixed homes (health=coral, groceries=mint, school=lilac, planning=lemon, finance=sky, wellbeing=rose, home=sage, errands=peach); new categories hash deterministically into the palette so a category keeps its color forever. The palette is the 8 swatches in `views.js catSwatch` — extend the palette, don't invent one-off colors.
3. **The hot pair = surfacing and primary action, nowhere else.** "Hot" is never a single orange: it is always the **pink→orange gradient** (`#FF4F9A → #FF8A3D`). The takeover field is a full pink-to-orange sunset; surfaced rows wash pink-to-peach with a pink shadow; primary buttons and the brand carry the same pair. Monochrome orange is a bug.
4. **The motif is the hard offset shadow** (`0 4px 0 <deeper tone>`), pressed down on tap. Never blur-glow on the paper theme; depth is physical, like stickers on paper.
5. **Two fonts, strict roles**: **Fraunces** (bundled variable, incl. italic) names *places and moments* — brand, screen titles, stratum names, the takeover's header, sheet titles. **Outfit** (bundled variable) carries *content and work* — item titles everywhere (including inside bubbles), body, chips, buttons, labels. No third font, no faux-bold system fallbacks in designed surfaces.
6. **The sizing stage arc**: strata climb from warm ground → meadow → sky → sunset → dusk → night → space; the world *darkens as things get bigger*. Stage foreground text derives from the stratum (`--stagefg`).
7. Monochrome glyphs only (✎ ◯ ☰ ⌂ ⚑ ◷ ↺ ☾ ◐ ◎ ◔ ✦ @) — they inherit text color. No color emoji in chrome.

## Wellbeing — struggles are not tasks

Things like "insomnia" are type **issue**: real, sized by difficulty, but they don't belong between "buy milk" and "fix the gate", and they never float on the ember takeover (that screen is a call to action; a struggle isn't actionable the same way). Issues live behind a quiet lavender **🌀 wellbeing chip** on the Lists screen — tap to unfold them, sorted by how heavy they feel. Issues also default to **private** (a struggle is yours until you share it), overriding the household's shared-by-default.

## Calendar

- **Now**: any dated item's sheet has "📆 Add to Google Calendar" — a one-tap prefilled event (title, all-day on the due date, notes attached). Zero auth, works today.
- **Later (with the sync milestone)**: true automatic sync — every dated item appearing in a "Stratos" Google calendar, updates propagating — needs Google OAuth (a one-time ~10-minute Google Cloud console setup to create a client ID, then in-app "connect calendar"). Client-side only, no backend required; roughly a day of careful work plus Google's unverified-app warning for personal apps. The one-tap link covers most of the value until then.

## Categories & tags

Categories are **free-form strings**, not a fixed taxonomy: the agent invents short lowercase ones as needed, the detail sheet's category field is free text with autocomplete of everything in use, and corrections teach both the local learner and Gemini. Creating a new category = typing it once. (One category per item for now; if cross-cutting tags earn their keep later, `tags: []` is a straightforward extension of the same learning machinery.)

## The agent

### v1 (client-side, no server)
- Heuristic classifier: splits dump text into items (newlines, short comma lists), detects type (verb-led → task; bare noun like "insomnia" → issue; grocery/supply lexicon → supply), scope (family member names, house items), category (health, school, errands, home, finance, planning, groceries, supplies, …), and due dates (natural phrases: "tomorrow", "by Friday", "June 12").
- **Local learning loop**: every user correction is recorded as token→field-value evidence. The classifier consults learned associations *before* built-in rules, so it genuinely adapts to how this family classifies. Visibility is learned the same way (repeatedly marking a kind of item private teaches the default).

### v2 (Gemini, no backend) — shipped
Dumps are filed by **Gemini** (`gemini-2.5-flash`, free tier) called **directly from the device** — no server at all. Each device holds its own API key (Settings → agent; free from aistudio.google.com/apikey), stored only in that device's localStorage and excluded from data exports.

The prompt carries: today's date, who is dumping, the family roster with ids, categories already in use, and the **last ≤50 corrections** — so the model personalizes to how this family classifies without any training infrastructure. Output is schema-constrained JSON (`responseSchema`), sanitized on the client (unknown scopes/types fall back safely), and the user's own **exact-phrase corrections still override the model**.

Fallback chain: no key / offline / any API error → the local heuristic classifier. The app is never blocked on the network.

### Photo dump (vision)
Gemini is multimodal, so the same key reads pictures: photograph the mess instead of describing it. The **📷 Photo dump** button on the Dump screen sends the (downscaled) image plus any typed context, and the agent returns one parent task named for the overall job ("Organize the hallway closet") **auto-broken into the concrete steps it can actually see** ("put away the clean laundry in the blue IKEA bag", "return the shoes to the rack") — instructed to name real visible items and never invent work it can't see. The photo attaches to the parent, the observation lands in its notes, and 2+ steps promote it to a goal as usual. Without a key the photo still becomes a single task with the image attached.

### What the agent knows about this household
Every Gemini prompt (text and photo) carries, beyond the family roster and corrections log:
- **Habit context**: recently completed items and the learned recurring rhythms — the model sees what this family actually does and how often.
- **Household notes**: a free-text field in Settings, written by the family for the agent and treated as ground truth ("blue IKEA + rainbow bags = clean laundry to put away; bamboo baskets = dirty"). This is the agent's memory, human-curated for now; a later milestone lets the agent *propose* additions to it from patterns it notices, with the family approving.

## Data model (JSON, localStorage in v1)

```js
item = {
  id, createdAt, createdBy,        // 'anna' | 'ebbe'
  raw,                             // original dump text, never lost
  title, type,                     // task | issue | supply | goal
  scope,                           // family member id | 'house'
  category, visibility,            // 'shared' | 'private'
  due,                             // ISO date or null
  source,                          // 'Netto' | 'Wolt' | … | null
  loop,                            // null | { every: days, auto: bool, history: [ts, …] }
  parent,                          // parent item id (this item is a step) | null
  notes,                           // free text; URLs become link chips
  media: [{ id, dataUrl }, …],     // downscaled inline images (until sync)
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
