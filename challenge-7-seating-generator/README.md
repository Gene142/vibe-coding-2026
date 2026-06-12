# Seating Group Generator

**Vibe Coding Workshop — Challenge #7 (Operations).**
Generates daily table configurations for program participants: gender-balanced, maximally mixed, and provably valid — replacing hours of manual shuffling in Excel with a two-minute upload → configure → download flow.

## Quick start

Open `index.html` in any modern browser. That's it — no install, no server, no internet connection needed.

1. **Upload** the participant list (Excel or CSV) using the standard template:
   `Name · Industry · Gender · Nationality · Coaching Group`
   (Download a blank template from the app, or press *Try with sample data*. Header synonyms like "Sector", "Country", "Sex", "Coaching group (A-F)" are recognised; extra columns are ignored.)
2. **Choose** the number of tables and daily configurations.
3. **Generate**, review the mix score + verification checks, and **download the Excel** — one sheet per day, plus a summary sheet and a by-participant overview.

**Privacy:** everything runs locally in the browser. No login, no upload, no storage — participant data never leaves the machine. The SheetJS library is vendored (`xlsx.full.min.js`) so the page also works fully offline.

## What the tool guarantees

A deterministic algorithm — not a free-form LLM — builds the plan, so the failure modes that got AI tools rejected (same person at two tables, quietly broken balance rules) are *structurally impossible*:

| Property | How |
|---|---|
| Everyone seated exactly once per day | Each day is a true partition of the roster |
| Table sizes within ±1 | Continuous round-robin dealing |
| Each gender spread ±1 per table | Gender-stratified dealing; the optimiser only ever swaps same-gender pairs |
| Same input → same output | Fixed-seed PRNG (mulberry32); no `Math.random`, no timestamps |

On top of those hard guarantees, an optimiser (multi-start + iterated local search) **minimises repeat pairings across days and same-attribute clustering** (coaching group, industry, nationality). After generating, the app **re-verifies its own output** independently of how it was constructed and shows the checklist — the PC doesn't need to re-check anything.

## The mix score

The 0–100 score tells the coordinator how good the best-found arrangement is:

- **Fresh pairings (40%)** — repeat encounters vs. the *theoretical minimum*. When tables are larger than the number of tables, some repeats are mathematically unavoidable (pigeonhole); the score accounts for that, so a provably optimal plan scores 100, and the caption reports e.g. "121 repeat pairings — theoretical minimum is 120".
- **Coaching group / industry / nationality spread (20/15/15%)** — same-attribute pairs at a table, normalised between the best possible spread and a worst-case clustering.
- **Gender balance (10%)** — recomputed from the output (structurally always ±1).

Criteria whose column is missing from the upload are skipped and the weights renormalise.

## Project layout

```
index.html          The app (open this)
app.js              UI layer: file parsing, rendering, Excel download
mixer.js            The engine: parsing, algorithm, scoring, verification (browser + Node, zero deps)
sample-data.js      Embedded sample cohort for the "Try with sample data" button (generated from the CSV)
xlsx.full.min.js    Vendored SheetJS 0.20.3 (Apache-2.0)
sample-data/        participants_sample.csv / .xlsx (48-person realistic cohort), participant_template.xlsx
test/run-tests.cjs  69-check test suite:  node test/run-tests.cjs
test/serve.cjs      Dev-only static server for previewing (the app itself needs no server)
```

The engine is pure JavaScript with no dependencies and runs in Node too — `test/run-tests.cjs` re-implements every guarantee check independently (plus determinism, random-baseline comparison, edge cases, performance, and an end-to-end re-read of the generated .xlsx).

## Roadmap (deliberately not built yet)

- **AI-assisted column mapping** — let an LLM read any participant file and map it to the standard fields, removing the need for the template. The deterministic engine stays untouched: AI would only *label columns*, never *assign seats*, preserving the trust guarantee. (`Mixer.parseParticipants` is already the single seam where this plugs in.)
- **Adjustable weights** — e.g. make *coaching group* variety dominate. The engine already accepts them: `Mixer.generate(people, { tables, days, weights: { coachingGroup: 6, industry: 1, nationality: 1 } })` — only the UI controls are missing (see the marked call site in `app.js`).
- Deferred per the brief: fixed-seat / accessibility constraints, room layouts, name badges.
