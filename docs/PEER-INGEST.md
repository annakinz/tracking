# Peer ingest: adding items to a Stratos household from another app

**Status:** implemented and shipped in Stratos v68. Code against v68, not v67 —
v67 shipped with a different `inboxAck` key and several bugs found in review,
and the differences are not backward-compatible.
**Audience:** an app that wants to put items on a family's Stratos list — FamilyMix
is the first, but nothing here is specific to it.

This is the contract asked for in the FamilyMix handoff. It answers all five
questions, corrects the parts of the reverse-engineered model that were wrong,
and describes what Stratos now does.

**Nothing needs redeploying.** The mechanism uses the `put` action that already
exists on the Apps Script. The household's `apps-script.gs` is unchanged.

---

## 0. Corrections to the inferred model

The handoff's crypto and addressing were exactly right. Four things were not.

| Inferred | Actually |
|---|---|
| "the only call is `get`" | **A write already exists.** `{action:"put", household, device, data}` → `{ok:true}`. That is the whole transport you need. |
| plaintext is `{items:{…}}` | The envelope is `{v:1, items:{…}, deleted:{…}, at:<ms>}`, plus `packing`, `inboxAck` and `inboxAdopt` on the shared file. `deleted` is the **only** delete channel; a payload without it can never remove anything. |
| `status` is `"open"｜"done"` | Statuses are **`inbox`｜`active`｜`done`**. `"open"` matches no view and the item would be invisible. |
| merge is last-writer-wins with no ordering | It is **per-item newest-wins on `updatedAt`**, and it honours tombstones. An item with a missing or stale `updatedAt` is silently ignored forever. |

Two further traps worth stating plainly:

- **`text` is not a field.** Items carry `title`. (Peers may send `text`; ingest maps it.)
- **The Apps Script strips non-alphanumerics from `device`.** `inbox:familymix`
  becomes `inboxfamilymix` server-side. If you keep the unsanitised form locally
  you will read back your own slot as if it were someone else's.
- **`visibility` decides sharing**, and the handoff omitted it. Only
  `visibility:"shared"` items are exported to the household file. Ingest forces it.

### The hazard, restated correctly

The handoff's resurrection story assumed no per-item ordering. Stratos has it, so
a stale slot loses to a later `done` — **but the hazard is real anyway**, for two
reasons the handoff didn't reach:

1. A peer that re-writes its slot each week does so with **fresh timestamps**,
   which beat the old `done`. That resurrects reliably, not occasionally.
2. Delete tombstones are **pruned after 90 days**. After that a standing
   assertion wins again.

So the instinct was right even though the mechanism wasn't. The fix below removes
the first reason entirely — a bought or deleted item is refused by identity, not
out-raced on timestamps. The second still bounds it: after 90 days the tombstone
is pruned and a standing assertion creates a fresh item. That is Stratos's
deletion window for everything, not a peer-specific weakness, and it is stated
again in §3 and §9 rather than quietly hoped away.

---

## 1. The mechanism: a single-writer inbox with a watermark

> The handoff proposed a *drain* — clients ingest, then blank the slot. We
> implemented something close but deliberately different, because blanking is
> unsafe here: the Apps Script has **no compare-and-swap**, so a batch written
> between a client's read and its blanking write is destroyed silently, with the
> peer believing delivery succeeded. That is a data-loss bug with no error
> anywhere. Instead:

**The inbox is single-writer. The peer writes it; Stratos never does.**

Each Stratos device keeps a **watermark** per peer and ingests a batch only when
`batch.at` is newer than that watermark. A standing inbox is therefore consumed
exactly **once per device**, no writes race, and re-reading it on every sync is
free. The watermark travels inside each device's shared snapshot (`inboxAck`), so
a phone that joins later inherits it instead of re-ingesting a batch the family
already dealt with.

Delivery is confirmed by reading `inboxAck` back (§4).

### Reserved slot — and your identity

Write the device slot **`inboxfamilymix`** — the literal string.

- Must match `/^inbox/i`. Stratos treats any such slot as a peer inbox: it is
  ingested rather than merged, and excluded from the "N other devices linked"
  count so it can't mask a mistyped household code.
- Must be alphanumeric, because the Apps Script strips everything else.
- Convention: `inbox` + your app's name, lowercase.

**The slot name is your identity.** Not the `peer` field inside the payload —
that is self-declared, so it is worth nothing as an identity and Stratos ignores
it for every decision that matters. The slot name is the one part of the write
the transport controls, so it is what keys your watermark, namespaces your item
ids, and forms your byline. Two apps that both call themselves `familymix`
inside their payloads stay completely separate as long as their slots differ.

Concretely, Stratos normalises the slot to `[a-z0-9]`, max 64 chars. So
`inboxfamilymix` is the string you will see as the `inboxAck` key in §4.

---

## 2. What to write

`POST <gasUrl>` with `Content-Type: text/plain;charset=utf-8` (deliberately a
CORS-simple request — do not send `application/json`, the preflight cannot be
answered), and follow the `/exec` redirect.

```jsonc
{
  "action": "put",
  "household": "<householdId>",
  "device":   "inboxfamilymix",
  "data":     "v1:<base64(iv||ciphertext)>"
}
```

The plaintext inside `data`:

```jsonc
{
  "v": 1,
  "kind": "inbox",              // REQUIRED — this is what marks it as an inbox
  "peer": "familymix",          // optional label only — your identity is the SLOT
  "at": 1756040000000,          // REQUIRED batch timestamp, epoch ms, MONOTONIC
  "items": {},                  // REQUIRED and MUST stay empty  ┐ see below
  "deleted": {},                // REQUIRED and MUST stay empty  ┘
  "inbox": [                    // the actual payload
    {
      "externalId": "familymix:2026-08-24:roede-linser",
      "text": "Røde linser",
      "quantity": "400 g",
      "quantityGrams": 400,
      "category": "groceries",
      "type": "supply",
      "scope": "house",
      "note": "Mon dinner — lentil sauce",
      "neededOn": "2026-08-25"
    }
  ]
}
```

**`items` and `deleted` must be present and empty.** This is not decoration: a
Stratos client that predates v67 will decrypt your slot and hand it to the
ordinary merge. With both maps empty that is a verified strict no-op — nothing is
added, nothing is deleted. Put anything in them and you are writing directly into
the family's list through a path with none of the checks below.

Never send a `deleted` map with contents. It is a delete instruction to every
device in the household, including old ones, and it bypasses every safeguard here.

---

## 3. The item contract

**Yes, `quantity` is its own field** — you were right to push for it, and it is
now first-class: stored on the item, rendered on the shopping row next to the
name, editable in the sheet, and tappable to change. Nothing string-parses it.

### A peer may set

| Field | When | Notes |
|---|---|---|
| `externalId` | — | **Required.** Stable, ≤120 chars, truncated silently past that (so don't rely on a shared 120-char prefix). See identity rules below. |
| `text` | correctable\* | **Required.** ≤200 chars. Whitespace collapsed, first character upper-cased, then stored as `title`. (`title`/`name` also accepted.) |
| `quantity` | correctable | Display string, ≤40 chars — `"400 g"`, `"2"`, `"1 l"`. Send it whenever you know it. |
| `quantityGrams` | correctable | Optional JSON number, **> 0**, for summing without parsing. `0` and negatives are dropped. |
| `neededOn` | correctable | `YYYY-MM-DD`, and a real calendar date. `2026-13-45` and `2026-02-30` are dropped. Becomes the due date. |
| `category` | create-only | ≤40 chars, lowercased. Defaults `groceries` (supply) / `errands` (task). |
| `type` | create-only | `supply` (default) or `task`. Anything else → `supply`. |
| `scope` | create-only | A household member id, else forced to `house`. |
| `note` | create-only | ≤500 chars → the item's notes. (`notes` also accepted.) |
| `source` | create-only | ≤40 chars — a shop name, e.g. `"Netto"`. Enables the store filter. |

\* `text` is correctable only on a row Stratos minted for you. If your line
merged into a row the family wrote by hand (see the name-match path below),
their wording is permanent.

**"create-only" means exactly that:** the value is used when the item is first
created and ignored on every later push of the same `externalId`. Correcting a
category or a shop is not possible through this channel; the ack will still
advance and nothing will change. If that turns out to matter, say so and we will
widen it — we started narrow because the family edits these fields themselves.

**Absent means "no opinion", never "clear it".** Omitting `quantity` on a
correction leaves the existing amount alone rather than blanking it. A peer can
add and correct values; it can never erase one. There is no way to unset a field
through this channel.

### A peer may **not** set — these are forced, not merely ignored

`id`, `status`, `visibility`, `parent`, `dims`, `createdBy`, `doneAt`/`doneBy`/
`doneNote`, `loop`, `claimedBy`, `snoozeUntil`, `messages`.

Ingested items are always `status:"active"`, `visibility:"shared"`,
`parent:null`, and `createdBy:"app:<your slot, minus the inbox prefix>"` — e.g.
`app:familymix`. The `app:` prefix is not cosmetic: it guarantees a peer byline
can never equal a household member id, so naming your slot `inboxanna` gets you
`app:anna`, not Anna. Supplies are auto-sized to *Getting low* so they reach the
shopping list at a sensible urgency.

**Types are checked, not coerced.** `quantityGrams` must be a JSON number;
`text`, `quantity`, `category`, `source`, `note` and `neededOn` must be strings
(or numbers). Send an array or an object and the value is dropped — you will not
find `[object Object]` or `"a,b,c"` on the family's shopping list. Control
characters are stripped from every string.

For the two **required** fields that is fatal rather than cosmetic: if
`externalId` or `text` ends up empty — wrong JSON type, empty string, or nothing
but control characters — the item is malformed, and **the whole batch is
refused** (see below).

### Batch limits — read this one

**A batch is atomic. It is ingested whole or refused whole**, and the watermark
moves only when it was ingested. That is what makes the ack in §4 mean something:
you never have to wonder whether *some* of a batch landed.

A batch is refused, with the watermark left exactly where it was, when:

- **it holds more than 200 items.** Not truncated to 200 — refused. (An earlier
  draft took the first 200 and acked all 250. That silently loses the tail: you
  would prune your outbox believing it landed.) Re-send in chunks of ≤200,
  waiting for the ack between them.
- **any item is malformed** — `externalId` or `text` missing, empty, or the wrong
  JSON type. One bad line refuses the batch rather than being skipped past,
  because there is no channel to tell you *which* line was dropped, so a partial
  ack would be a lie. The family sees which item index was at fault.
- **`at` is missing, ≤ 0, or in the future.** More than 5 minutes ahead of the
  receiving phone's clock is refused rather than clamped: clamping would park
  the watermark ahead of you and stall the channel with no explanation.
- **`at` is not newer than the watermark** — the replay defence.

Individual items *are* still declined without refusing the batch, but only for
reasons that are the family's decision rather than your error: the item was
bought, or deleted. Those are described under "what ingest refuses" below, and
the ack advancing over them is correct — they were delivered, and the family
said no.

### Identity

Stratos derives its own id from your slot **and** your `externalId`:

```js
// `externalId` below is the CLIPPED one: control characters stripped,
// trimmed, then truncated to 120 characters.
const slot = "inboxfamilymix";                 // normalised, see §1

// FNV-1a, 32-bit, over UTF-16 code units (charCodeAt) — NOT UTF-8 bytes.
// This matters: your example domain is Danish, and a textbook byte-wise
// FNV-1a gives a different answer for any externalId containing æ, ø or å.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const id = "px_" + slot.slice(0, 16)
         + "_"  + externalId.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)
         + "_"  + fnv1a(slot + ":" + externalId);
```

(Our test suite re-implements this from the block above and asserts it matches
Stratos byte for byte, including on non-ASCII input, so you can rely on it.)

Three consequences you can rely on:

- **Deterministic.** Two phones ingesting the same batch mint the *same* id, so
  the ordinary merge collapses them. No duplicates from concurrency.
- **Namespaced against the family.** Stratos's own ids are `i<seq>_<base36>`. A
  `px_` id can never collide with one, so no `externalId` — however chosen or
  crafted — can *address* a family-created item by id.
- **Namespaced against other apps.** The slot is in the id and in the hash, so if
  another connected app picks the same `externalId` string you get two separate
  items rather than fighting over one. Neither can read or overwrite the other's
  lines.

> One honest caveat on the second point, because an earlier draft of this doc
> overstated it: id-namespacing means a peer cannot *address* a family item. It
> does not mean a peer can never affect one — the name-match path below can
> attach an amount to a row the family wrote by hand. That path is bounded and
> described exactly; it is never able to reach a **private** item.

**Make `externalId` unique per intended occurrence.** Your dated form
(`familymix:2026-08-24:roede-linser`) is exactly right. Reusing an id across weeks
means Stratos treats it as the same item — and it will refuse to reopen it once
bought (§ next). Rotate the date and next week's milk is genuinely a new line.

### What ingest refuses

Beyond the watermark, each item is checked individually, so correctness never
depends on having won a race:

- item is **`done`** → ignored (it was bought; it does not come back)
- item is **tombstoned** (deleted here) → ignored
- item **already exists** → only `title`, `quantity`, `quantityGrams` and the due
  date are updated. Sizing, source, claim, snooze and notes the family edited are
  untouched.
- the family **already has it by hand** (same normalised name, scope and type) →
  the amount is attached to *their* row instead of adding a second line.

### The name-match path, stated precisely

That last rule is the only way a peer ever touches something it did not create,
so here is exactly what it can and cannot do. A batch line merges into an
existing row only when **all** of these hold:

- the row is `visibility: "shared"` — a peer can **never** reach a private item,
  by name or any other route. Every lookup path applies this check, so unsharing
  a row puts it permanently beyond a peer;
- the row was **not** minted by a peer (no `px_` id), and carries no
  `externalId` unless it is one *you* previously adopted (recorded under your
  slot). `externalId`s are not namespaced between apps, so a bare string match
  would let one app reach a row another app had claimed;
- it has no parent, is not `done`, and matches on `scope`, `type` and normalised
  name.

**Normalised name** means: lowercased, everything outside `[a-z0-9æøåäöü\s]`
stripped, tokens of two characters or fewer dropped, and these stopwords dropped
— `the and for with this that from about need get buy some new`. So `"Buy milk"`
and `"Milk"` are the same name. If that leaves nothing (a short name like `Æg`),
the plain lowercased title is used instead.

When it merges, the peer may fill in `quantity` and `quantityGrams` **only if
those are still empty**, and stamp its `externalId` on the row. It cannot rename
the row, resize it, change its category, or complete it. Corrections you push
later update the amount; the family's title stands.

Once merged, the row *is* your line. Delete it and Stratos remembers: the same
`externalId` is refused on later batches rather than reappearing as a new `px_`
item. That memory lasts **90 days** — the same window Stratos keeps any deletion
for. After that the record is pruned along with the tombstone and a re-push
creates a fresh item, exactly as it would for a family item deleted that long
ago.

---

## 4. Confirming delivery

Stratos does not write your slot, so read the **device** slots to see how far
you've been consumed. Each device's shared snapshot carries:

```jsonc
{ "inboxAck": { "inboxfamilymix": 1756040000000 } }
```

Note the key: it is your **slot name**, not the `peer` string in your payload.

**Read the maximum, not the minimum:**

```
delivered = max(inboxAck["inboxfamilymix"]) over all readable device slots
          >= your batch's at
```

- **Delivered** when that maximum reaches your `at`. The batch is in the
  household's shared list, and ordinary sync carries it to every phone.
- **Not yet seen** when no slot has reached it. Leave your slot as it is.

> Take the **max**, not the min. An earlier draft of this doc said min; that is
> not a satisfiable condition and would have stalled you for ever. Two reasons:
> device slots are never pruned, so a phone that was replaced two years ago sits
> in the file at watermark 0; and a Stratos client older than v67 publishes no
> `inboxAck` at all. The watermark is also **not a per-device ingest record** —
> it is a household-wide value: whichever phone ingests first publishes it, and
> the others adopt it on merge without reading your inbox. So max across slots is
> the accurate reading of "someone in this household consumed this batch."

### Seeing which of your lines merged

The same shared snapshot also carries `inboxAdopt` — the record of lines that
merged into a row the family had already written by hand (§3):

```jsonc
{ "inboxAdopt": { "inboxfamilymix:familymix:2026-08-24:maelk": "i412_k3x9" } }
```

Keys are `<slot>:<externalId>`; values are the Stratos item id the line actually
lives on. If your `externalId` appears here, that line is on a family row, not a
`px_` item of its own — which is why its title is theirs and not yours. Read it
if you want to reflect that back in your own UI; ignore it otherwise. It is
pruned on the same 90-day schedule as the tombstones.

Since the slot is yours alone, the safe pattern is: **keep writing your
outstanding set, in batches of at most 200**, with a fresh, monotonically
increasing `at`. Items the family has already bought or deleted are refused
individually, so re-listing them is harmless. Prune your outbox once the acks
cover them.

If your outstanding set exceeds 200, send the first 200, wait for the ack, then
send the next chunk with a new `at`. Sending 250 in one batch delivers **nothing**
(§3) — deliberately, so you find out rather than losing the tail.

`at` **must increase**. A batch whose `at` is not newer than the watermark is
ignored wholesale — that is the replay defence.

---

## 5. Auth, honestly

**The household code is the credential, and it is also the AES key.** There is no
separate write scope to issue, because a writer must hold the key to encrypt at
all.

We considered the write-scoped token you offered. Here is the honest accounting,
because it would have been easy to ship it and imply more safety than it buys:

- A token **cannot** buy confidentiality. Anyone with the code can `get` the whole
  store and decrypt every slot. FamilyMix already has full read access to the
  household — items, notes, messages, completion notes and packing lists — and a
  token changes none of that.
- A token **cannot** meaningfully buy revocation. Rotating the household code
  changes the `householdId`, so the phones start writing a *new* file — but the
  old file is never deleted and remains decryptable by the ex-peer forever.
  Rotation stops future writes reaching them; it is not revocation.
- The Apps Script authenticates **nothing**. Anyone who learns the URL and the
  household id can write any slot, token or no token.

So: **the household code is the trust boundary, and holding it is equivalent to
being a family device.** Take that seriously on your side.

What we *did* build, because it is real rather than theatre:

- Peer ids are namespaced (`px_` + slot), so a peer cannot *address* a
  family-created item, nor another app's items. The one bounded exception — the
  name-match path — is spelled out in §3 and can never reach a private item.
- A peer's byline is `app:<slot>`, which cannot collide with a household member
  id, so a slot named `inboxanna` cannot author items as Anna.
- Every peer-settable field is type-checked, clamped, length-capped and
  control-character stripped; `neededOn` must be a real calendar date, not merely
  a well-shaped one.
- Incoming tombstone timestamps are clamped to now + 5 minutes of clock skew —
  and tombstones already stored are repaired on the next sync — so no slot can
  plant a far-future tombstone that never prunes and permanently blocks an item.
- Watermarks adopted from another phone are clamped to now exactly (no skew
  allowance — a watermark parked even minutes ahead would refuse live batches),
  and a future-dated batch is refused outright, so one bad `at` cannot shut the
  channel down permanently.
- Batches over 200 items are refused whole and left unacked, never truncated and
  acked.

If write-only ever becomes a genuine requirement, the answer is **not** a bearer
token — it is public-key sealing: publish an X25519 public key derived from the
household code, and have the peer seal batches to it with an ephemeral key. The
peer could then write what it cannot read. That is a larger change and nobody has
asked for it yet.

---

## 6. Answers to the five questions

1. **Is there already a write action?** Yes — `action:"put"`, four keys, shown in
   §2. No new endpoint, no redeploy.
2. **Ingest mechanism.** A reserved `inbox*` slot, written only by the peer,
   consumed once per device via a watermark. §1.
3. **Who drains, and when.** Nobody drains — that was unsafe. Every client
   *ingests* on its normal sync (on change, on focus, and every 60s). No
   designated device, no single point of failure, no server-side step (the server
   cannot decrypt).
4. **Item contract.** §3, including what is forced rather than trusted.
5. **Auth.** Household code. §5 explains why a token would be misleading here.

---

## 7. What this looks like to the family

Groceries arrive on the **House → 🛒 Shop** tab, grouped by aisle in store-walk
order, with the amount beside each name. Stratos's aisle vocabulary now covers
Danish shelf terms, so *rugbrød*, *havregryn*, *hakket oksekød*, *æg* and *mælk*
sort correctly rather than falling into "Other".

A delivery raises **one** summary card — "↯ A connected app delivered · 12 items
from familymix" — not one notification per carrot. Both phones get exactly one:
the card is keyed on your batch's `at`, so the phone that ingested and the phone
that learned about it over sync raise the same card rather than two.

---

## 8. A worked example

```js
const CODE = 'ABCD-EFGH-JKLM-NPQR';               // the household code
const norm = c => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const enc  = new TextEncoder();

// Loop, don't spread. `String.fromCharCode(...bytes)` passes every byte as a
// separate argument and throws RangeError once a batch gets big — a bug you
// would not hit on a one-item self-check and would hit on a real week's shop.
const b64 = (buf) => {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);                                  // standard base64, WITH padding
};

async function householdId(code) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode('stratos.hh.' + norm(code)));
  return b64(h).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
}

async function key(code) {
  const base = await crypto.subtle.importKey('raw', enc.encode(norm(code)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('stratos.household.v1'), iterations: 120000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function push(gasUrl, code, items) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = {
    v: 1, kind: 'inbox', peer: 'familymix', at: Date.now(),
    items: {}, deleted: {},                        // must stay empty
    inbox: items,
  };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(code), enc.encode(JSON.stringify(body)));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(ct), iv.length);

  const res = await fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // CORS-simple, no preflight
    redirect: 'follow',
    body: JSON.stringify({
      action: 'put',
      household: await householdId(code),
      device: 'inboxfamilymix',
      data: 'v1:' + b64(out),
    }),
  });
  return res.json();                                // { ok: true }
}
```

Self-check before your first real write: push a **single** throwaway item, confirm
it appears on a phone under House → Shop, then confirm `inboxAck.inboxfamilymix`
catches up to your `at`. If the item never appears, the usual cause is the crypto:
standard base64 **with** padding (not base64url), a 12-byte IV, the GCM tag
appended to the ciphertext, and `stratos.hh.` with its trailing dot.

---

## 9. Known limits

Stated plainly so nobody is surprised:

- **Old clients count your inbox as a device.** A phone that hasn't updated to
  v67 will include your slot in "N other devices linked". Harmless but confusing;
  it resolves when both phones update. Updated clients report connected apps
  separately.
- **No delete channel for peers.** You can add and correct, never remove. If a
  meal plan changes, the stale line stays until someone ticks or deletes it. We'd
  rather that than give a peer a delete primitive.
- **Ordering across peers is by `at` only.** Two peers writing inboxes are
  independent; there is no global ordering between them.
- **A batch that fails to decrypt is skipped silently** — it does not break sync
  (updated clients exclude inboxes from the code-mismatch check), but you will
  get no error either. Use the ack to detect it.
- **Old clients publish no `inboxAck` at all.** A pre-v67 phone in the household
  simply never appears in your delivery check. This is why §4 says take the max
  across slots and not the min.
- **Stale device slots are never pruned.** A replaced phone's slot stays in the
  file at whatever watermark it last published, possibly 0, for ever. Same
  reason: max, not min.
- **A merged line loses its own title.** When your line merges into a row the
  family wrote by hand (§3), their wording wins permanently — later corrections
  update the amount but never the name. `inboxAdopt` (§4) tells you which lines
  those are.
- **Refusals are visible to the family, not to you.** A refused batch shows on
  the phone's sync line — e.g. `⚠ inboxfamilymix: batch of 250 refused — send at
  most 200 items per batch`. Your only signal is the absence of an ack, so treat
  a stalled watermark as an error worth logging on your side.
- **No per-item feedback.** You cannot learn *which* items the family bought or
  deleted, only that the batch was consumed. Re-listing them is harmless — they
  are refused individually — but you will keep re-sending until you notice they
  never come back on your own side.
- **The resurrection guarantee has a 90-day horizon.** Deletions stop a re-push
  for 90 days, after which the tombstone is pruned and a re-push creates a new
  item. This is Stratos's general deletion window, not something specific to
  peers.
- **`v` is accepted but unused.** There is no version negotiation. Send `1`.
