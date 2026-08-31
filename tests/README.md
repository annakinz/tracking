# Peer-ingest tests

These cover the contract in [`docs/PEER-INGEST.md`](../docs/PEER-INGEST.md).
They exist because that document is a public promise another team codes
against: if the code drifts from it, something here should go red.

Plain Node, no dependencies, no build. From the repo root:

```sh
node tests/peer-ingest-test.js
node tests/peer-transport-test.js
node tests/doc-example-test.js
node tests/upgrade-test.js
```

Each prints `N passed, 0 failed` and exits non-zero on a failure.

**`peer-ingest-test.js`** — the ingest rules themselves, against the real
`store.js` with `localStorage` stubbed and the clock frozen. Two and three
simulated devices where convergence matters. Covers every refusal, every
forced field, the watermark, the name-match path, and the privacy guarantees.

**`peer-transport-test.js`** — end to end over the real transport. A simulated
FamilyMix, written *only* from the doc, encrypts a batch and writes the inbox
slot through a faithful mock of `apps-script.gs`; Stratos syncs for real. Also
re-implements the published item-id formula from §3 and asserts it matches
Stratos byte for byte.

**`doc-example-test.js`** — extracts the worked example from §8 of the markdown
at run time and executes it. Not a copy of the example: the example itself. If
the code in the doc stops working, this fails.

**`upgrade-test.js`** — a phone sitting on an older build force-updates: its
stored state loads, renders and syncs with none of the new maps present, and a
peer batch lands on top of it correctly.

**`apps-panel-test.mjs`** — needs Playwright, so run it with
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/apps-panel-test.mjs`.
Drives the real UI against a fake household file and checks that Settings →
connected apps tells the failure modes apart: no app writing, an app writing
under the wrong household code, a batch missing `kind:"inbox"`, and a batch
already taken in. Those four look identical from the outside — "I pressed sync
and nothing happened" — so each has to name itself.

The other browser-level tests (escaping, the delivery card, the UI smoke pass)
live outside the repo.
