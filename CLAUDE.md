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

There is no verified GitHub mirror at handoff. `origin` is only the ChatGPT Sites
remote. GitHub CLI is installed but is not authenticated, and no CineRadar
Windows Scheduled Task was found. Therefore none of the repository schedules
should be assumed to be running automatically.

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
