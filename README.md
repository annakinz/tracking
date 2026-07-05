# Stratos 🫧

A family life-tracking app built to **alleviate cognitive load**: brain-dump without organizing, let the agent categorize (and learn from your corrections), then express importance by *pinching bubbles through exponential strata* instead of picking numbers from dropdowns.

**→ Full concept & spec: [DESIGN.md](DESIGN.md)** — the source of truth this app can be rebuilt from.

## Try it

It's a dependency-free PWA (plain HTML/CSS/JS, no build step):

```
cd tracking
python3 -m http.server 8000     # or any static server
# open http://localhost:8000 — best on a phone for the pinch gesture
```

To put it on phones: enable GitHub Pages for this repo (Settings → Pages → deploy from branch), open the URL in Safari/Chrome, and "Add to Home Screen". It works offline after the first load.

## The loop

1. **Dump** — type anything, several things at once. The agent splits, titles, categorizes, detects who it's for, spots due dates. Tap a filed card to correct it — corrections teach the agent.
2. **Size** — each new item appears as a bubble. Pinch it bigger or smaller; crossing a band boundary jumps it into the next stratosphere, where you see the items already living there for comparison. Tap OK, next item.
3. **Live** — lists sorted and filtered by person, magnitude, category, visibility. Items with due dates self-inflate as the date nears (deadline gravity 🔥).

## Status

v1: local-first (per-device storage, JSON export/import), heuristic agent with real correction-learning, two profiles (Anna/Ebbe) with private/shared items, household & groceries mode, insertable strata.

Next milestones (see DESIGN.md roadmap): phone-to-phone sync backend, Claude-powered classification, voice dump.
