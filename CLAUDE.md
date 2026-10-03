# CineRadar — handoff for Claude Code

Last verified: 2026-09-25 (Europe/Rome)

This file is the operational handoff for continuing CineRadar. Read it together
with `README.md`, `CODEX_SETUP.md`, `.env.example`, the Supabase migrations, and
the code in `scripts/cineradar/` before changing the architecture.

## Product objective and constraints

CineRadar is a public radar of actionable, source-backed opportunities for
filmmakers working with AI and emerging media. It covers festivals, contests,
platform and branded challenges, grants, residencies, labs, fellowships,
animation, music video, experimental/new media and related open calls.

Current priorities, in order:

1. make the existing review queue usable and publish a small set of genuinely
   verified opportunities;
2. run acquisition continuously and cheaply;
3. improve useful discovery coverage using source-first monitoring;
4. measure benchmark recall and independent control-search recall separately;
5. only then consider product expansion or forecasting.

Do not seed production from the benchmark workbook, manually insert benchmark
opportunities, or put benchmark titles into discovery queries. Never invent an
official URL, application URL, deadline, fee, prize, status, eligibility rule or
other factual field. Unknown facts stay unknown and every automated lead remains
behind human review.

Owner decision 2026-09-29: human review is the exception, not the default.
`auto-review.mjs` (daily, after triage) approves a pending record only when its
official page is re-fetched and reachable, shows an open call, still states the
confirmed future deadline, names an organizer, and there is no conflict; it
rejects listing/programme/past-edition pages, archives duplicates, keeps records
without a live deadline under automatic watch, and flags only undecidable
records `needs-human` (the default `/team` view). Decisions go through the
audited RPC as `auto-review@cineradar.invalid`, are reversible, and are capped
at 15 approvals per run. Facts are still never invented.
Incident 2026-09-29: the first auto-review run (v1) published 11 bad records
(deadline-tier titles, a listing page, an accreditation, a youth jury, an
illustration contest, a duplicate, general art residencies read from a news
listing). They were reopened within the hour and re-decided under v2, which
adds: deadline-label and multi-plural titles rejected, non-submission calls
rejected, film/moving-image relevance required (else human; other disciplines
rejected), listing URLs as official page escalated, duplicates among pending.
Public catalogue after correction: 11 records.
Update 2026-09-30 (auto-review v3): scheduled runs were failing (monitor: a
1,000-UUID IN list returned 400, now chunked by `selectIn`; discovery: series
organizer/last_seen conflicts aborted runs after ingest, now isolated per record
and pages are marked processed right after ingest). v3 approves only when the
official page's domain belongs to the call (title or non-publication organizer
in the domain), requires the extractor itself to re-find the same deadline on
the page (quotes from site-wide banners no longer count), names bare category
titles after the organizer, cleans entities/suffixes, treats film institutions'
names/domains as film context, and re-checks every earlier auto-approval each
run (withdraws, archives duplicates, renames). Dataset sources are `official`
only when taken from `official_url` (98 re-typed). Public catalogue: 17.
Update 2026-10-01: scheduled discovery verified green after three fixes
(observation key reuse across provenance counted as `observationsRefused`;
series last_seen_at keeps Postgres microseconds; triage/auto-review write only
changed rows). Discovery job ~3 min (timeout 15), monitor twice daily x 1,000
sources (timeout 12); worst-case Actions minutes 1,794/month.
Update 2026-10-02 (coverage throughput, after comparing with aifilmcontests.com):
AFC listed 90 open AI contests; we held 34 (5 published). 36 of the 90 exist
only on FilmFreeway (never fetched). The other misses were ours: pages already
fetched but stuck (535 LLM_RUN_LIMIT, 198 BUDGET_BLOCKED). Cause: Cloudflare
429s (capacity) were booked `uncertain` at the full 4,000-token reservation, so
the 9,000-neuron daily limit blocked the day after ~60 calls (real use ~65
neurons/call). Fixes: 429 retried and booked `released` (3036 = daily
allocation stops the run), max_tokens/reservation 2,500, 70 LLM calls/run;
pending queue ordered AI sources first, then source priority; AI sources get a
lenient call gate (`call-signal-v2`, button wording such as "SUBMIT NOW" is a
call phrase for all) and lenient child-link selection (path + text, not host).
New `harvest-directories.mjs` (daily step in discovery, 180 s): reads
directory sitemaps/detail pages, registers the official page each one points
to (JSON-LD event/organizer url or labelled outbound link) as a source; no fact
is copied. Scheduler: GitHub starts schedules 1.5-7 h late (not failures);
`202610020001_pipeline_dispatcher.sql` adds pg_cron + pg_net dispatch of
monitor/discovery at the exact times, GitHub schedules become a guarded
fallback (skip if a dispatched run exists in the last 10 h). Owner action:
create a fine-grained PAT (this repo only, Actions read/write), store it with
`vault.create_secret(..., 'cineradar_github_dispatch_token')`, apply the
migration. Worst-case minutes with guards: 1,856/month.
First harvest + dispatched runs (2026-10-02): 139 sources registered (40 AI),
89 records inserted in one discovery run, AFC match 34 -> 43 of 90, public
catalogue 17 -> 25. The guard verified in production (late schedule skipped).
Update 2026-10-02 (features, owner: "procedi con le altre automazioni e
feature"): auto-review v4 maintains every published record daily (archive a
day after a passed deadline, archive same organizer+deadline+name duplicates,
strip page labels from names such as "Submit"/"Regulations –", AI category
from the event's own name). Public site: `/o/[slug]` page per opportunity
(quoted deadline, links, last check, JSON-LD without invented dates), quick
filters with counts (AI film, closing in 14 days, free entry, cash prize),
countdown badges, entry fee on cards, `sitemap.xml`, `robots.txt`; the public
query never returns a passed deadline. Weekly brief (roadmap P4):
`weekly-brief.mjs` runs Sundays in the revalidate workflow, stored in
`weekly_briefs` (`202610020002_weekly_briefs.sql`, owner must apply), shown at
`/team/brief` and in the `/team` sidebar. These UI changes need a Sites deploy
(Codex). Known next lever: 562 pending records have no deadline; only 20 quote
a day/month without a year (7 AI) - most need the call's subpage, not year
inference.
Update 2026-10-02 (afternoon, owner approved points 1-4 and 6; FilmFreeway
still no): `hunt-deadlines.mjs` runs daily in discovery before triage/review
and reads deadlines on each pending call's own Submit/Rules/Dates pages
(`deadline-hunt.mjs`: dated extractor, JSON-LD validThrough, year-less dates
only when the page names that year -> `estimated`, published as `verified`
and shown "About <date>"; on sites with several calls a date belongs to the
call named closest to it). The first live pass attributed dates to sibling
calls; it was rolled back and the rules fixed (tests cover the cases).
Deterministic extraction reads JSON-LD/og:site_name/description. Cloudflare
Browser Rendering works with the existing token (free allowance, ledgered at
EUR 0, `BROWSER_RENDER_DAILY_LIMIT` 40) for JS-only AI/priority sites.
Cloudflare Workers AI usage inside the 10,000 neurons/day allowance is now
booked at EUR 0 (`cloudflareCharge`); Groq (llama-4-scout, free tier) takes
over only after a Cloudflare refusal before inference, but the GROQ_API_KEY in
`.env.local` is INVALID (401) and there is no Actions secret: owner must create
a key at console.groq.com and add it as Actions secret `GROQ_API_KEY`.
Auto-review: official-page film context or "all disciplines" makes
residencies/labs relevant; theatre/dance, finalists/official-selection pages
rejected; rolling calls need the current/next year on the page (copyright
footers ignored); same official page + same deadline (or page-label name) =
duplicate. Monitor gives 30% of each run to priority sources. Result: public
catalogue 23 -> 43 (first CI run with the hunt: 113 inserted, 55 deterministic,
7 more approvals). Free LLM ceiling observed: ~135 Cloudflare extractions/day. Making the GitHub repo public (owner approved, history
scanned clean) was blocked by the local permission classifier: the owner must
switch visibility in GitHub settings; then monitor frequency and LLM calls per
run can be raised (the minutes test assumes the private 2,000 cap).
Update 2026-10-02 (evening): the GitHub repo is PUBLIC (free runners); runs are
sized by free provider quotas: monitor 2,500 sources/run (paged reads), discovery
130 LLM calls within a 15-minute LLM budget, hunt 150, harvest 25 directories.
The GROQ_API_KEY Actions secret exists but Groq answers 401 invalid_api_key
(probably an xAI "Grok" key, not a Groq key): Groq stays unused (releases cost 0).
Auto-review now rejects aggregator pages (directory sources with an aggregator
name or 3+ unrelated organizers), closed titles, and watches not-yet-open calls;
names lose website chrome/entities/announcements; the daily re-check no longer
flips approvals on film relevance. Public catalogue: 59.
Update 2026-10-03 (owner: 90% coverage target "senza spendere nulla"; plan of
8 free points approved with "procediamo"; FilmFreeway still never fetched):
ZERO SPEND. Exa is off (`DISCOVERY_QUERY_LIMIT` 0; the 9/month pool below is
unused). LLMs: Cloudflare inside its free daily neurons (booked 0), then Groq
free tier rotating across the account's models (each has its own quota; a long
429 retires a model for the run, "request too large" teaches its token limit;
booked 0 via `GROQ_FREE_TIER`, default true - set false only on a paid Groq
plan). Browser Rendering free (40/day). Free-tier terms: Gemini free is not
usable for EEA users; Mistral/GitHub Models free tiers are evaluation-only.
Pipeline additions (all no-LLM): series-anchored extraction
(`series-extraction.mjs`: a registered series' own site -> deadline from the
page or its Submit/Rules subpages, platform submission link, explicit
open/closed); Festhome connector (`harvest-platforms.mjs` daily step, ~585
open festivals, final deadline from the organizer's calendar, own website
registered as a source); deadline tier lists ("DEADLINES: Earlybird ...
Extended: Dec 31") read as one calendar; the hunt reads a call's own page first
and never borrows a date when that page's own calendar has passed; series
homepages that link a Submit/Rules page pass the gates; the queue query pages
past deferred rows (it had processed ~230 of ~1,580 ready pages per run).
Auto-review v5: up to 50 approvals/run (AI first, then soonest deadline);
Festhome calendars re-read on the platform; "open on platform" calls (organizer
says submissions are open + links its platform page, no date anywhere) are
published as `verified` with no date and re-read every run; section headings
("The festival in numbers") and craft categories take the organizer's name.
Monitor: up to 4,500 sources/run (24 concurrent, 33-min budget, job 36 min);
discovery job 75 min. `requeue-pages.mjs` (dry run by default) puts series
pages settled by older processors back in the queue once.
Coverage on the owner's datasets (evaluation only; datasets stay local, run
`work/miss-diagnosis.mjs` and `coverage.mjs` with `CINERADAR_SEED_DATASETS`):
2026-10-03 before the fixes: found 22.6% (held-out 12%), published 4.2%;
after two runs: found 31.1% (held-out 24%), published 4.4%. Remaining misses:
page queued 36% (5,938 older series pages requeued once with
`REQUEUE_PROCESSED_BEFORE=2026-10-02T22:30:00Z`; ~1,500 pages/run), found but
not published 25% (mostly no deadline yet), FilmFreeway-only 10%, never
checked 9%, fetch failures 6%. Live counts 2026-10-03 01:00 UTC: 2,775
records, 1,794 pending, 148 public (anon-visible).
Quality fixes after the first 50 v5 approvals: names (site name over a foreign
registry name, call-page headings), blog/news posts never read as a series'
call page, castings/actors' residencies are not film dates, aggregator news
posts (On the Move) go to a human, name/organizer-swapped duplicates archived;
5 calls withdrawn a day before their deadline by a re-check bug were
re-approved (published calls now stay until their deadline).
UI (needs a Sites deploy via Codex, commit `ac13ef4` or later; archive
`work/deploy-ac13ef4-20261003.tar.gz`): "Submissions open - deadline on
<platform>" badge and "Apply on <platform>" link for the platform-open calls
(`deadlinePlatform` in `lib/opportunity-format.ts`).
Update 2026-10-03 (afternoon; owner: TAVILY_KEY added to Actions secrets, Exa
gives USD 10 of free credits every month - verified on exa.ai: monthly reset,
402 when used up, no card on file). Still zero spend:
- Exa back on inside its free credits: DB pool 9 (optional work stops at
  8.1 < 10); requests priced by shape (instant 0.004, auto 0.007, +0.001 per
  result over 10); 402/422/429 never billed and a 402 stops Exa for the run.
  Discovery: 3 gap queries/run x 10 results. Owner should confirm in the Exa
  dashboard that auto-recharge is off and no other tool uses the same team.
- Tavily (`tavily.mjs`): free plan 1,000 credits/month, booked at EUR 0 with
  credits in usage_units; the client stops at TAVILY_MONTHLY_CREDIT_CAP 900
  (the DB RPC does not cap Tavily credits) and on 432/433. Key only in CI
  (secret TAVILY_KEY -> env TAVILY_API_KEY). Tavily's terms forbid publishing
  its performance figures: keep Tavily-vs-Exa comparisons out of the repo.
- `resolve-names.mjs` (daily step): own sites for names from the DB only
  (Festhome records' declared websites re-read for free; pending records
  without an own page; Wikidata sources marked DEAD_DOMAIN). Tavily 15 + Exa
  instant 15 per run; a site needs a distinctive name word or initials in
  its domain and its homepage must name the series; only sources are
  registered (seed resolver:*). First run 3/7 wrong -> rules tightened, the 3
  disabled. `resolve-sites.mjs` (local, datasets, seeded only) now uses Exa
  instant: 32 sites for 129 FilmFreeway-only series (USD 0.52).
- Monitor: a host that does not resolve twice in a row -> DEAD_DOMAIN
  (blocked, out of rotation; ~1,200 lapsed Wikidata domains expected).
- FestAgent connector (in `harvest-platforms.mjs`, with Festhome): free
  default listing only (never subscription filters), 1.5 s/request; ~1,520
  cards with own websites registered as sources; open festivals' pages give
  the final deadline. Its footer requires a link to the source: records keep
  the FestAgent page as source/deadline source, never as application link;
  /o/[slug] shows "Where we found it: FestAgent", "Deadline from FestAgent",
  "As stated on FestAgent". Auto-review accepts its calendar only on
  organizer-managed pages. Old generic FestAgent sources were disabled.
- EU connector (`harvest-eu-funding.mjs`): Creative Europe MEDIA topics from
  the Funding & Tenders public search API (apiKey=SEDIA is the portal's
  public key; robots allow; CC BY 4.0 credit on record pages). Scope:
  development, co-development, video games/immersive, TV/online, innovation
  labs (6 open topics today); industry topics with EU_FT_INCLUDE_INDUSTRY.
  Auto-review re-reads the topic JSON and accepts ec.europa.eu for the
  Commission. Known limit: a multi-cut-off topic is archived after its first
  cut-off (the next one is not re-published automatically yet).
- 20 film funds/commissions from Wikidata registered (family film-funding);
  Wikidata residencies were too noisy to import.
- Ledger/registry reads now page past PostgREST's 1,000-row cap.
- Groq account models in rotation: gpt-oss-20b, gpt-oss-120b, qwen3.8-27b.
Deploy target for the UI (FestAgent/EU attribution, platform badges): latest
main (`4ef0cac` or later), archive `work/deploy-4ef0cac-20261003.tar.gz`.
Update 2026-10-03 (evening; owner sent a source survey PDF and the example
"AI Horizons" from ticonsiglio.com):
- UPDATE (same evening, owner decision): Festhome is read again for the TEAM
  ONLY. Its records are flagged `team-only` (triage), listed in the /team tab
  "Team only (Festhome)", and can never be published: auto-review keeps them
  on watch, publicationBlockers adds "team-only-source" and the server action
  refuses to approve them (`isTeamOnlyRecord` in lib/review-workflow.mjs;
  the SQL gate does not know this rule). The terms risk below was explained
  and accepted by the owner. Superseded text follows:
- FESTHOME IS BLOCKED. Its Terms of Use (filmmakers.festhome.com/terms-of-use)
  forbid "any systematic or automated data collection activities (including
  ... scraping, data mining, data extraction and data harvesting)" without
  express written consent, and republishing its material. The connector had
  been built on robots.txt alone (mistake). festhome.com is in BLOCKED_HOSTS
  (never fetched by any step); 136 published calls whose deadline came from
  Festhome were reopened and return only if the festival's own site states
  the date; ~590 Festhome-derived records are still stored (owner decision:
  delete them, or ask Festhome for written consent). RULE: read a platform's
  terms before automating it, not only robots.txt.
- Docfilmdepot / ShortFilmDepot legal notice forbids reproducing or
  summarising their content without consent: not integrated.
- Lead feeds (`lead-feeds.mjs`): aggregators whose terms forbid reproduction
  (ticonsiglio.com "Concorsi creativi" RSS) are read only for call NAMES; the
  resolver finds the organizer's page (for leads, a call PDF in the site's
  uploads or a page whose path names the call also counts).
- Italy for Movies connector (`harvest-italy-for-movies.mjs`): national
  portal of Italian film funds; open grants -> records with the funder's page
  as official page; all funders' sites registered as sources.
- Not yet audited: the terms of every directory read by
  `harvest-directories.mjs` (it registers official sites only and copies no
  fact) and of FestAgent beyond its footer ("use only with a link").

Owner approval 2026-09-28: Exa has its own budget pool of at most 9/month
(ledger units; USD is counted 1:1 so real spend stays <= USD 9). All other
providers keep the rules below. Both ceilings are enforced in the database by
`202609290001_exa_budget_pool.sql`.

The preferred recurring API spend is EUR 0–3/month. The technical hard ceiling
for metered provider reservations is EUR 5/month. Do not enable a paid service,
paid fallback, paid GitHub overage, paid Supabase plan, or paid Cloudflare plan
without explicit owner approval.

## Repository and deployed site

- Local repository: `C:\Users\Public\cineradar`
- Current branch: `main`
- Handoff base commit: `4bd2e86fc027614ad6311b05c9c7bfacf9040479`
- Current Git remote `origin`: the ChatGPT Sites source repository at
  `git.chatgpt-team.site`
- Sites project ID: `appgprj_6ab16fb1a1808191930b2f2af75904d2`
- Production URL: `https://cineradar.danielmaker.chatgpt.site`
- Current production version: 11 (review workflow, deployed 2026-09-28 by the owner via Codex)
- Current access mode: public
- Current Sites environment revision: 11
- Production deployment status at handoff: active/succeeded
- Worker errors observed in the last 24 hours at handoff: 0

The two most recent commits fix navigation across the ChatGPT Sites auth
boundary. `Radar -> Team` and `Team -> Radar` deliberately use native `<a>`
navigation rather than Next client-side `Link`; do not revert that without a
real authenticated Sites browser test.

## Credentials and secret handling

No credential value is stored in this document or committed to Git.

Local provider/database configuration is in `.env.local`, which is covered by
`.gitignore`. At handoff it contains these configured variable names:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `EXA_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_AI_MODEL`
- `CLOUDFLARE_DAILY_NEURON_LIMIT`
- `GROQ_API_KEY`
- `GROQ_MODEL`
- `GROQ_FALLBACK_ENABLED`
- the discovery, cost and request limit variables documented in `.env.example`

The production Sites environment has the following entries configured:

- `CINERADAR_TEAM_EMAILS` (secret)
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN` (secret)
- `EXA_API_KEY` (secret)
- `GROQ_API_KEY` (secret)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (secret)

Sites returns secret values redacted; a redacted value does not mean that it is
missing. Use the Sites environment-variable connector to inspect names/revision
or update values. Never print secret values, copy `.env.local` into source,
include secrets in command output, or place service-role credentials in client
code. `CINERADAR_TEAM_EMAILS` is intentionally server-side and must fail closed
when absent.

The source repository does not have a reusable password. Sites Git write tokens
are short-lived: request a fresh source-repository write credential from the
Sites connector and pass it to Git without persisting or displaying it.

## GitHub mirror and scheduler state

Update 2026-09-29: GitHub had not fired any scheduled run in the first ~12 hours
after activation (0 `schedule` events; manual dispatches work). Check
`gh api repos/DanielSan-hub/cineradar/actions/runs?event=schedule` and add a
fallback trigger if it stays at 0. First checks were compressed to 1–4 days;
monitor now takes 1,000 sources/run (201 sources took 100 s in CI); discovery
runs twice daily (6 Exa queries, 80 LLM calls each). 75 dataset channel hosts
(aggregators serving >= 3 series, e.g. aifilmcontests.com, asianfilmfestivals.com)
are registered as daily directories; they had been wrongly excluded by the
hold-out.

Update 2026-09-28: private mirror `DanielSan-hub/cineradar` is remote `github`
(`origin` stays the Sites remote); GitHub CLI is authenticated. Five Actions
secrets were loaded from `.env.local` without printing. Manual smoke runs all
succeeded: monitor (37 sources checked, 0 LLM), revalidate (76 URL checks),
stale (review-only), discovery (4 Exa queries, 24 LLM calls, 37 new + 3 updated
records, EUR 0.044). Schedules for discovery, monitor, revalidate and stale are
enabled; history stays disabled. Estimated usage is ~185 Actions minutes/month
(free plan: 2,000). The owner still has to confirm the Actions spending limit
is 0 in GitHub billing settings. Start the 7-day monitoring window from
2026-09-28. Month-to-date ledger after the smoke runs: EUR 0.0847.

Original handoff state: there was no verified GitHub mirror. `origin` was only
the ChatGPT Sites remote, GitHub CLI was not authenticated, and no CineRadar
Windows Scheduled Task existed.

Five bounded workflow definitions already exist:

- `.github/workflows/discovery.yml` — daily discovery;
- `.github/workflows/monitor.yml` — source refresh twice daily via HTTP/hash;
- `.github/workflows/revalidate.yml` — weekly URL revalidation, no LLM;
- `.github/workflows/stale.yml` — monthly stale review;
- `.github/workflows/history.yml` — monthly bounded historical backfill.

To activate free automation, first authenticate GitHub CLI (`gh auth login` or a
temporary `GH_TOKEN`), create a private mirror, add it as a second remote (keep
the Sites remote), and add the required encrypted Actions secrets from the
owner's secret stores. Do not paste values into workflow YAML. Configure the
GitHub Actions spending limit at zero, run every workflow manually once, inspect
its database writes and provider counters, and only then leave schedules enabled.
The workflows share the `cineradar-pipeline` concurrency group.

If no GitHub account is available, the EUR 0 fallback is Windows Task Scheduler,
but it only works while the machine is on and online. No task exists yet.

## Verified live state

The following figures were read from live Supabase at handoff:

### Opportunities and publication

- total opportunities: 42;
- statuses: 40 `discovered`, 2 `closed`;
- `review_required=true`: 42;
- human-verified (`verified_at` present): 0;
- anonymously visible/public: 0;
- active by audit definition: 35;
- expired by status/deadline: 7;
- unknown deadline: 39;
- conflicts flagged: 0;
- missing canonical keys: 0;
- categories: 20 traditional festivals, 15 grants, 5 AI film festivals,
  1 residency and 1 platform challenge.

The public API correctly returns an empty live catalogue rather than demo rows:

```text
GET /api/opportunities -> 200
total=0, demoMode=false
```

This is expected from the human-review RLS gate, but it means the released
product currently shows no opportunities to visitors.

### URLs and data quality

- every record has a source URL;
- 13 records have no official URL;
- 24 records have no application URL;
- no currently stored URL was classified as malformed, invalid or unreachable
  by the audit;
- there are no exact canonical-key or strict identity duplicate groups;
- one pair needs review by title/edition/location heuristic;
- 11 records share source URLs across 5 groups, which can be valid for directory
  or multi-call pages and must not be merged on domain/URL alone.

There is legacy projection drift: values present in `raw_payload` are sometimes
not reflected in flat columns. The handoff inspection found recoverable values
for some deadline status, URL status and edition-year fields. Backfill only from
source-grounded existing payload data, then revalidate links; never promote an
unchecked URL to verified merely because a value exists in JSON.

### Sources and acquisition backlog

- sources registered: 42;
- sources enabled: 39;
- checked at least once: 28;
- enabled but never checked: 14;
- currently due according to registry policy: 25;
- health: 38 healthy, 3 degraded and 1 failing;
- known changed URL-cache entries not yet processed: 10;
- source checkpoints: 11;
- provenance rows: 16, covering 15 opportunities;
- productive new sources registered from gap searches so far: 0.

The last known problematic sources were Shortfilmdepot (`EMPTY_PAGE`) and
Higgsfield, Luma AI News and Sundance Submit (`Unexpected end of JSON input`).
Recheck them before treating those historical health messages as current bugs.

The latest source monitor, URL revalidation, stale check and six latest discovery
runs succeeded. Those six discovery runs each stored 1–4 records. Old failed runs
remain in `pipeline_runs` and include pre-fix Supabase 400 failures; do not mistake
historical failures for the present state. A fresh bounded smoke run is still
needed after automation is configured.

### History

- event series: 1;
- edition rows: 1 (2026);
- temporal observations: 13.

Historical architecture exists, but the backfill is barely populated and is a
lower priority than current opportunity coverage. Do not implement forecasting.

## Coverage benchmark

Benchmark workbook:

`C:\Users\Utente\Downloads\Film_Opportunities_DeepResearch_RECOVERY_2026-09-23(1)(1).xlsx`

The last read-only evaluation compared the 42 live database records with 117
golden benchmark rows:

| Segment | Matched | Total | Recall |
|---|---:|---:|---:|
| Overall | 1 | 117 | 0.85% |
| CORE | 1 | 22 | 4.55% |
| MAINSTREAM | 0 | 6 | 0% |
| HIDDEN | 0 | 23 | 0% |
| LONG_TAIL | 0 | 66 | 0% |

Only the platform/branded group had a match (1/6). All benchmark geography
groups except global/international were 0. These figures fail every milestone
gate. They are benchmark recall, not a defensible estimate of global market
coverage: the benchmark contains specific 2026/2027 editions and is not the
whole market.

Run it with:

```powershell
$env:CINERADAR_BENCHMARK_WORKBOOK = 'C:\Users\Utente\Downloads\Film_Opportunities_DeepResearch_RECOVERY_2026-09-23(1)(1).xlsx'
pnpm radar:benchmark
Remove-Item Env:CINERADAR_BENCHMARK_WORKBOOK
```

The benchmark command is evaluation-only. Measure actual market coverage with
independent control searches and additional discovery batches, keeping control
results out of production. Report benchmark recall, major-opportunity recall and
estimated market coverage separately.

## Cost state

The live provider ledger at handoff contained:

- 5 Exa searches: EUR 0.035 estimated;
- 9 Cloudflare extraction calls: EUR 0.00549327 estimated;
- month-to-date total: EUR 0.04049327 estimated;
- observed gap-search cost per validated opportunity: EUR 0.007;
- Groq fallback: disabled by default.

The configured daily plan projects approximately:

| Load | Gross API demand | Enforced maximum |
|---|---:|---:|
| 1x | EUR 1.49/month | EUR 1.49 |
| 2x | EUR 2.97/month | EUR 2.97 |
| 5x | EUR 7.43/month | EUR 5.00 |
| 10x | EUR 14.86/month | EUR 5.00 |

These are conservative ledger estimates, not invoices. The database RPC reserves
cost atomically before provider dispatch, reduces work at EUR 3, disables
optional paid work at EUR 4, and rejects paid reservations above EUR 5. Free HTTP
monitoring and the website continue after paid operations stop.

The ledger does not include Supabase plan fees, the ChatGPT subscription needed
for Sites, another hosting provider, GitHub overages or account-level consumption
outside CineRadar. Verify dashboards and billing limits before claiming an
all-in recurring cost.

The configured Cloudflare model is
`@cf/meta/llama-3.1-8b-instruct-fp8-fast`. The pricing table in
`scripts/cineradar/cost-control.mjs` matched Cloudflare's published rate at the
handoff date. Exa's estimated default cost matches the Search endpoint base price.
Recheck external pricing before changing assumptions.

## Architecture already implemented

- React/Next-compatible frontend built through Vinext for Cloudflare Workers.
- Supabase database, RLS, server-only review reads and live public pagination.
- Public page size 24, maximum page size 50, with server-side filters/sorting and
  Load more; the old apparent limit of eight was demo fallback data.
- Persistent source registry with adaptive polling, cursors/checkpoints and
  rotating child-link windows.
- Exa used as a small gap/source finder rather than the primary crawler.
- Direct HTTP first, content hashing, cross-run cache and conditional requests.
- Deterministic extraction first; Cloudflare AI only for ambiguous pages.
- URL syntax/SSRF controls, bounded redirects, bounded retries, HTTP validation
  and separate source/official/application URL semantics.
- Canonical identity deduplication that does not merge all calls from one domain.
- Provider reservation ledger, per-run ceilings, bounded concurrency and retry
  deferral.
- Discovery provenance, source economics and temporal observations.
- Groq is opt-in and is not attempted after Cloudflare may have consumed usage.
- Automated leads default to `review_required=true`; anonymous RLS exposes only
  human-approved public statuses.

Relevant migrations have been applied to live Supabase through
`202609250001_human_review_gate.sql`. `pnpm radar:audit` reports
`SCHEMA_MODE=integrity-columns`, and the temporal schema assertion passes.

The prioritised product roadmap (team value first) is in `ROADMAP.md`.

Pending owner actions (2026-09-29): apply `202609290001_exa_budget_pool.sql`
and `202609300001_review_triage.sql` in the Supabase SQL editor, then deploy
the current commit through Codex (Team "Ready to publish" tab and badges).
Triage already archived 11 expired pending records under
`pipeline-triage@cineradar.invalid` (reversible with "Back to pending").

## Highest-priority implementation work

### 1. Build the human review workflow

Status 2026-09-26: implemented in the working tree, not yet live. It adds
`supabase/migrations/202609260001_review_workflow.sql` (`review_decision`,
append-only `opportunity_review_events`, atomic `apply_opportunity_review`
RPC, a trigger that stops automated writers from rewriting approved fields,
and an RLS policy that also requires `review_decision='approved'` and
`verified_at`), `/team` tabs with pagination, and `/team/review/[id]`. The
migration was exercised end-to-end in PGlite, but it must still be applied to
live Supabase (SQL editor) before deploying; until then the UI shows the queue
read-only. Publishing still needs a verified official URL, so run
`radar:revalidate` after editing URLs.

Update 2026-09-28: `202609260001` is applied live (verified read-only: 42
pending, anon sees 0, anon cannot call the RPC or read audit events).
`radar:revalidate` ran (76 URL checks, 0 failures, 0 LLM calls).
`202609280001_publication_gate_past_deadline.sql` makes a recorded past
deadline block every public status; it must be applied live too. With it, 22
records pass the gate as `verified` and 1 as `open`. That is not a list to
approve: it contains three likely duplicate pairs (FeatureLab 2027, AIDFF 15th,
BFI Innovation Challenge Fund), a 2016 archive page (`1dc52b64`) and several
generic landing-page URLs. Both migrations and the review UI are now live.

Published 2026-09-28 on the owner's instruction without human review: six
records (FeatureLab 2027 `open`; PixLight, AIDFF 15th, Prix Ars Electronica
2027, AI Filmfest Athens 2026, 54th Athens Int'l Film + Video Festival as
`verified`), each checked against its official page. They are audited under
`claude-code-agent@cineradar.invalid` so they can be re-reviewed by a human.
Two duplicates were archived and the 2016 archive page rejected. The other
pending records had past deadlines, generic pages or old editions.

Original brief: `/team` was read-only and loaded at most 50 rows. Add authenticated,
server-side reviewer actions with no service credential in the browser. At a
minimum the reviewer must be able to:

- edit source-grounded fields;
- mark a record rejected/archived without deleting its evidence;
- approve and publish a valid record;
- set an appropriate public status;
- set `verified_at`, clear `review_required` and record reviewer identity/reason;
- keep records private when required evidence is missing or contradictory;
- paginate the queue.

Add a durable audit trail (migration plus server access) for reviewer, action,
timestamp, before/after fields and reason. Authorize mutations with the same
ChatGPT Sites identity plus exact-email allowlist used by `requireTeamUser`.
Never accept a reviewer email supplied by the client as proof of identity.

After implementation, manually verify and publish a small high-confidence batch.
Do not bulk-approve all 42 records.

### 2. Repair projections and finish the existing backlog

Create a conservative/idempotent backfill for flat columns whose grounded value
already exists in `raw_payload`. Revalidate URLs after backfill. Then:

1. run `pnpm radar:monitor` until all enabled never-checked sources have had a
   bounded attempt;
2. run bounded discovery to process the 10 changed cached pages;
3. investigate the four unhealthy source adapters;
4. run `pnpm radar:audit`, `pnpm radar:cost-report` and the benchmark again;
5. confirm repeated unchanged runs do not call the LLM.

### 3. Activate a zero-cost scheduler

Create and configure the GitHub mirror or local scheduled tasks as described
above. Do not enable unattended runs until manual workflow smoke tests succeed.
After activation, monitor it for at least seven days and record run success,
records added, cache/unchanged rate, cost, false positives and public output.

### Coverage architecture (2026-09-28)

Discovery was rebuilt around a registry of *series* plus cheap call detection,
instead of searching for opportunities one by one:

- `import-registry.mjs` seeds `sources` from Wikidata (14,193 active film
  festival series with an official site, CC0, free) and from the owner's
  deep-research datasets (sources only; never opportunities). A deterministic
  20% of dataset series (`registry-seeds.mjs`, salt `cineradar-holdout-v1`) is
  held out and never seeded; the benchmark workbook is refused outright.
  Registry after import: 14,719 sources. `registry.yml` refreshes Wikidata
  monthly.
- `robots.mjs`: robots.txt is honoured per origin (RFC 9309); FilmFreeway is
  never fetched (Cloudflare bot challenge). Disallowed sources become `blocked`.
- `call-signal.mjs`: multilingual (~25 languages) call/date gate run in the
  monitor on already-fetched text. Pages without a call are marked processed
  for free (`NO_CALL_SIGNAL`); discovery spends LLM calls on the highest
  scores first. Calibrated on real pages: 91% recall on series that were open,
  30% pass rate on random festival homepages. Known miss: JavaScript-only sites.
- Monitor: 3 runs/day x 400 sources, 9-minute time budget. Discovery: 300
  gated pages and 60 LLM calls/day. Worst-case Actions minutes 1,701/month
  (test-enforced < 2,000); realistic ~800. Expected API spend ~EUR 2/month.
- `coverage.mjs` (evaluation only, needs `CINERADAR_SEED_DATASETS`) reports
  registered / monitored / found / published for held-out vs seeded series.
  Baseline right after import: held-out registered 60%, seeded 75.7%,
  monitored ~4% (schedules spread first checks over 1-21 days).
- Site resolution (`resolve-sites.mjs`, ledgered Exa, seeded series only):
  145 own sites registered for 262 platform-only series, EUR 1.83; 92 have no
  own site (FilmFreeway-only). A picker rule requires the series name or
  initials in the domain (precision fix after a 78%-precision first batch).
  Coverage after resolution: held-out registered 60%, seeded 83.6%, all 78.7%.
  Discovery gap search raised to 12 Exa queries/day (~EUR 2.6/month).
- Structural ceiling: 43% of actionable dataset series are recorded only as
  FilmFreeway pages. Next steps: resolve their own sites (ledgered Exa, about
  EUR 2 one-time for seeded series), Festhome/other allowed platforms, and ask
  FilmFreeway for permitted access (owner decision).

### 4. Improve discovery coverage from measured gaps

Coverage is currently the main product-quality failure. Expand productive source
families and local-language sources, especially grants, residencies, labs,
fellowships, music video, animation, experimental/new media, branded/platform
calls and non-European regions. The query matrix already includes ten languages,
but the live source registry currently represents only English, Spanish,
Japanese and Korean. Fix source-registry growth: the gap searches found five
validated opportunities but registered no new durable source.

Use benchmark misses only as post-discovery regression checks. Continue running
independent control searches and measure marginal valid discoveries per batch.

### 5. Expand history slowly

Only after the current radar produces useful public records and stable daily
runs, execute bounded historical checks (5–20 pages/day, monthly schedule) from
2023 onward. Preserve observations; do not overwrite evidence and do not build
forecasting yet.

## Acceptance gates for the next milestone

Do not declare the next milestone complete only because tests pass. Require:

- a working reviewer edit/approve/reject flow with audit history;
- at least one carefully reviewed public opportunity visible anonymously;
- daily discovery and source monitoring running on a verified scheduler;
- seven days of run and cost evidence without unbounded retries or silent errors;
- all enabled sources attempted and changed-page backlog reduced to zero;
- current URLs and factual fields checked on the published sample;
- benchmark and independent control-search reports repeated after discovery;
- provider-side usage/billing limits checked;
- repository lint, typecheck, tests and production build passing.

Original benchmark targets remain CORE >=95%, overall >=80% and HIDDEN >=50%,
but do not overfit or claim market completeness to meet them.

## Commands for verification

```powershell
corepack pnpm verify
corepack pnpm radar:audit
corepack pnpm radar:cost-report
corepack pnpm radar:seed-sources
corepack pnpm radar:monitor
corepack pnpm radar:discover
corepack pnpm radar:revalidate
corepack pnpm radar:stale
corepack pnpm radar:history
corepack pnpm radar:benchmark
```

For a first discovery smoke run, use small temporary limits:

```powershell
$env:DISCOVERY_QUERY_LIMIT = '2'
$env:DISCOVERY_RESULT_LIMIT = '2'
$env:MAX_LLM_CALLS_PER_RUN = '3'
corepack pnpm radar:discover
Remove-Item Env:DISCOVERY_QUERY_LIMIT
Remove-Item Env:DISCOVERY_RESULT_LIMIT
Remove-Item Env:MAX_LLM_CALLS_PER_RUN
```

Every provider run must use the cost ledger. Do not call Exa, Cloudflare or Groq
manually outside the pipeline when measuring CineRadar cost.

## Deployment procedure for ChatGPT Sites

The repository is deployed as a built Worker artifact, not by pushing source
alone. For every production change:

1. run the relevant checks and `corepack pnpm build`;
2. commit the exact source state;
3. request a fresh short-lived Sites source-repository credential;
4. push the exact commit to the Sites `main` branch without printing or storing
   the token;
5. package `.openai/hosting.json` and `dist/` into a tar.gz archive built from
   that commit;
6. save a Sites version using the full pushed commit SHA and archive;
7. deploy the exact saved version while preserving public access;
8. check deployment status, live routes and Worker errors.

Do not create another Sites project while `.openai/hosting.json` contains the
existing project ID. Production `/team` must redirect anonymous requests to
`/signin-with-chatgpt?return_to=%2Fteam`; allowlisted authenticated users can
read the queue and other signed-in users must receive 404.

## Known limitations and cautions

- The public site is empty until humans approve records. This is a product
  blocker, not a database outage.
- Team navigation needs native full-page links across the Sites auth boundary.
- Team review currently has no write actions or pagination.
- The database contains useful raw evidence that is not always projected into
  flat fields.
- Current coverage is far below the benchmark gates and has not reached search
  saturation.
- Source health errors may be old; reproduce before changing adapters.
- `work/`, `dist/`, local runtime directories and `.env.local` are ignored and
  must not be committed.
- Existing local/site secrets are sufficient for current manual runs, but no
  GitHub credentials or Actions secrets are configured.
- Do not expose service-role keys, authenticated-user headers, allowlisted email
  addresses or provider tokens in logs, client bundles, issues or commits.

When handing off again, update this file with the new commit, deployed version,
database/public counts, scheduler state, benchmark result, ledger total and any
new manual action required from the owner.
