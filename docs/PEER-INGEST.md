# Peer ingest: adding items to a Stratos household from another app

**Status:** implemented and shipped in Stratos v67.
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
| plaintext is `{items:{…}}` | The envelope is `{v:1, items:{…}, deleted:{…}, at:<ms>}`, plus `packing` and `inboxAck` on the shared file. `deleted` is the **only** delete channel; a payload without it can never remove anything. |
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
the whole class rather than tuning timestamps.

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

| Field | Notes |
|---|---|
| `externalId` | **Required.** Stable, ≤120 chars. See identity rules below. |
| `text` | **Required.** ≤200 chars. Mapped to `title`. (`title`/`name` also accepted.) |
| `quantity` | Display string, ≤40 chars — `"400 g"`, `"2"`, `"1 l"`. Send it whenever you know it. |
| `quantityGrams` | Optional number, for summing without parsing. |
| `category` | ≤40 chars, lowercased. Defaults `groceries` (supply) / `errands` (task). |
| `type` | `supply` (default) or `task`. Anything else → `supply`. |
| `scope` | A household member id, else forced to `house`. |
| `note` | ≤500 chars → the item's notes. |
| `source` | ≤40 chars — a shop name, e.g. `"Netto"`. Enables the store filter. |
| `neededOn` | `YYYY-MM-DD` only. Becomes the item's due date. Anything else is dropped. |

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
(or numbers). Send an array or an object and the field is dropped — you will not
find `[object Object]` or `"a,b,c"` on the family's shopping list. Control
characters are stripped from every string.

### Batch limits — read this one

- **At most 200 items per batch.**
- A batch of 201+ is **refused whole**. Not truncated: nothing is ingested, and
  **the watermark does not move**, so §4 will correctly tell you the batch was
  never delivered and you can re-send it in chunks. (An earlier draft took the
  first 200 and acked all 250. That silently loses the tail — you would prune
  your outbox believing it landed. Refusing is the honest failure.)
- `at` is **required**, must be > 0, and must **not be in the future**. A batch
  stamped ahead of the receiving phone's clock (more than 5 minutes) is refused
  with the watermark untouched, rather than parking the watermark in the future
  and killing the channel for good.

### Identity

Stratos derives its own id from your slot **and** your `externalId`:

```
slot = "inboxfamilymix"                       // normalised, see §1
id   = "px_" + slot.slice(0,16)
     + "_"  + externalId.replace(/[^a-zA-Z0-9]/g,"_").slice(0,40)
     + "_"  + fnv1a(slot + ":" + externalId)      // fnv1a as .toString(36)
```

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
  by name or any other route;
- the row was **not** minted by a peer (no `px_` id) and carries no other app's
  `externalId`;
- it has no parent, is not `done`, and matches on normalised name, `scope` and
  `type`.

When it merges, the peer may fill in `quantity` and `quantityGrams` **only if
those are still empty**, and stamp its `externalId` on the row. It cannot rename
the row, resize it, change its category, or complete it. Corrections you push
later update the amount; the family's title stands.

Once merged, the row *is* your line. Delete it and Stratos remembers: the same
`externalId` is refused on every later batch rather than reappearing as a new
`px_` item.

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
- Incoming tombstone timestamps are clamped to now — and tombstones already
  stored are repaired on the next sync — so no slot can plant a far-future
  tombstone that never prunes and permanently blocks an item.
- Watermarks are clamped the same way, and a future-dated batch is refused
  outright, so one bad `at` cannot shut the channel down permanently.
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

async function householdId(code) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode('stratos.hh.' + norm(code)));
  return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
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
      data: 'v1:' + btoa(String.fromCharCode(...out)),
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
  update the amount but never the name. You cannot tell from the outside which
  of your lines merged.
- **Refusals are visible to the family, not to you.** An oversized batch or a
  future-dated `at` shows on the phone's sync line ("⚠ send at most 200 items per
  batch"). Your only signal is the absence of an ack, so treat a stalled
  watermark as an error worth logging on your side.
