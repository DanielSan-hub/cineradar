# CineRadar roadmap

Last reviewed: 2026-09-28. Curated from the owner's earlier milestone brief;
only the parts that still add value are kept. Ordered by value to the team
first, then to the public web app. Operational state lives in `CLAUDE.md`.

## Where we are (measured 2026-09-28)

- 79 opportunities: 6 published, 70 pending, 3 rejected/archived. 37 arrived
  in the last 24 hours; the queue will keep growing as the 14.8k-source
  registry is monitored (only 52 checked so far).
- Field completeness is the bottleneck: deadline 20%, application URL 19%,
  eligibility 5%, AI policy 8%, fee 4%, max runtime 5%. Official URL 76%,
  provenance 70%.
- Golden Benchmark recall 0.85% (1/117). Registry coverage of dataset series:
  held-out 60%, seeded 83.6% (see `radar:coverage`).

## Already delivered (do not rebuild)

Source registry with families, priority, adaptive polling, yield counters and
health; incremental crawling with checkpoints; robots.txt compliance;
Wikidata + dataset seeding with a 20% hold-out; multilingual call-signal gate;
gap-driven Exa with its own 9/month pool; provenance and temporal observation
tables with conflict flags; series/edition schema; full editorial workflow
(edit, approve, reject, archive, reopen, audit trail, pagination); budget
ledger with database-enforced ceilings.

## Priority 1 — decision-grade fields (unlocks everything below) — DONE 2026-09-29

Every team feature needs the same facts, and today they are mostly missing.
Extract them from pages we already fetch, source-grounded, UNKNOWN when absent:

- deadline with time zone, opens date, deadline status;
- max/min runtime and accepted formats (short, feature, vertical, XR...);
- AI policy (allowed / required / restricted / unclear) with the quoted rule;
- entry fee and currency; prize or funding amount;
- eligibility: geography, age, career stage, production year window;
- premiere requirement (world / international / European / national / none);
- application URL.

Method: deterministic patterns first, then extend the LLM extraction schema;
store the evidence quote per field; backfill from `raw_payload` where the
value is already grounded. Measure completeness per field in `radar:audit`.
Target: deadline, runtime, AI policy and fee above 60% on published records.

## Priority 2 — queue triage (keeps review possible at scale) — DONE 2026-09-29

- Daily deterministic triage: archive pending records whose deadline has
  passed or whose status is closed (reversible, audited under a pipeline
  identity); flag generic landing pages.
- Rank the pending queue by readiness: passes the publication gate, deadline
  soon, confidence, completeness. "Ready to publish" filter in `/team`.
- Never auto-publish. Automation may only keep records private.

Status of 1–2: `decision-fields.mjs` extracts deadline, runtime, fee, AI
policy, premiere rule and eligibility with verbatim evidence, filling only
empty fields on single-opportunity pages; calibrated on the live pages
(site-wide banners, JSON, per-category rules and negations are rejected).
`radar:audit` reports DECISION_FIELDS completeness. `triage.mjs` runs daily
after discovery: archives expired/closed pending records via the audited
RPC and scores readiness; `/team` gains a "Ready to publish" tab once
`202609300001_review_triage.sql` is applied and the UI is deployed.

## Priority 3 — the team's films and fit (first real team value) — NEXT, not started

- `team_assets`: title, type, runtime, completion date, genre, AI usage,
  production country, languages, premiere status per territory, public
  availability, festival history. Start with Play and The Last Sun.
- Deterministic fit per opportunity x asset with stated reasons:
  REUSE (finished film eligible), ADAPT (subtitles, cut, export), BUILD_NEW
  (requires new work), MONITOR (recurring call not open), SKIP (ineligible),
  UNKNOWN when a deciding field is missing — never a guess.
- Premiere protection: store each asset's premiere status and each call's
  premiere rule; warn on conflicts. No simulation.
- Show "For our films" in `/team` and fit badges on the review page.

## Priority 4 — weekly brief (proactive, not a data dump) — DONE 2026-10-02 (delivery by copy/paste; WhatsApp adapter later)

- Weekly GitHub Actions job builds 5–8 items from the database:
  ACTION NOW (decisions/deadlines in the next 14–30 days), NEW HIGH-VALUE,
  FOR OUR FILMS, CHANGED (deadline/status/rule changes), WATCH (recurring
  high-value series showing signs of reopening). Deterministic selection;
  an LLM may only polish wording.
- Store in `weekly_briefs` (+ `weekly_brief_items` with reason, action,
  priority); show the latest brief in `/team`.
- Delivery: start with "Approve & send" by a human. WhatsApp via OpenClaw
  only as a transport adapter owned by OpenClaw (CineRadar never holds the
  WhatsApp session), one allowlisted team group, outbound only. Build the
  adapter when the brief has proved useful for a few weeks.
- Rare critical alerts only: major call reopened with a short window,
  deadline or eligibility change on a tracked opportunity.

## Priority 5 — public web app — first pass DONE 2026-10-02

Delivered: public page per opportunity (`/o/[slug]`, SEO), quick filters
(AI film, closing in 14 days, free entry, cash prize) with counts, countdown
badges, entry fee on cards, sitemap/robots, passed deadlines never shown.
Still open: format/runtime and region filters (need field completeness).


- Deadline-first home: closing soon, newly verified, rolling calls.
- Filters that matter once fields exist: format/runtime, AI policy, fee
  (free only), region/eligibility, category.
- Clear "last verified" and source links on every card (trust).

## Priority 6 — coverage engine tuning (after 2–3 weeks of registry data)

- Expose coverage and yield by category, region, source family, language
  (source yield = unique valid opportunities / checks; query yield = unique
  valid opportunities / searches; cost per validated opportunity; duplicate
  and false-positive rates) and rotate Exa gap queries toward weak areas.
- Gap queries should discover sources, not single calls; use local-language
  families written for each culture, not translated templates
  (e.g. 映像 公募, 미디어아트 공모, convocatoria audiovisual, edital
  audiovisual, 影像艺术征集), including non-film vocabulary: moving image,
  media art, artist residency, public screen, creative-tech award.
- Add allowed platforms (Festhome and others whose robots.txt permits).
- Dedup across translated titles and platform vs official pages using
  canonical URL, organizer, series identity, edition year, normalized title.

## Measurement rules (keep)

- Golden Benchmark is evaluation only: never seed it, never search its titles.
  Report CORE, MAINSTREAM, HIDDEN, LONG_TAIL and overall separately.
  Near-term targets: CORE >= 90%, overall >= 60–70%, HIDDEN >= 30–40%.
- Keep benchmark recall, high-value recall and estimated market coverage as
  three separate numbers; never present benchmark recall as market coverage.
- Hold-out recall from `radar:coverage` is the honest pipeline measure.

## Later (not now)

Historical backfill (5–20 pages/day, only when discovery is stable),
recurrence forecasting, portfolio/cluster optimisation ("which film would
unlock the most calls"), ML recommendations.

## Dropped or changed from the earlier brief

- FilmFreeway structured crawling: blocked by a bot challenge; only with
  FilmFreeway's permission.
- Cost: owner-approved pools replace the single EUR 5 cap (Exa 9/month,
  everything else EUR 5 with a EUR 3 target).
- "Coverage beyond 100 opportunities" was never the real state; progress is
  tracked with the measurements above.
