# Setting up CineRadar with Codex

This file is written for a future Codex session working inside this repository.

## Goal

Move CineRadar from demo mode to a live, low-cost production system while preserving:

- public read access;
- authenticated team verification;
- Exa only as a small gap/source finder after persistent source monitoring;
- direct fetch + content hashes for known sources;
- Cloudflare Workers AI as the single default extractor; Groq only when explicitly enabled before any Cloudflare attempt;
- Supabase as the source of truth;
- a preferred EUR 0-3 monthly API spend and an EUR 5 reservation ceiling for metered provider calls; this is not an all-in billing cap.

## Before changing code

1. Read `README.md`, `.env.example`, `supabase/schema.sql` and every file in `scripts/cineradar/`.
2. Run `pnpm install` and `pnpm build`.
3. Never add secrets to source files, commits, logs or chat output.
4. Keep the demo fallback working until the live database has at least one verified record.

## Inputs Codex must collect from the owner

Ask only for values that are still missing:

- Supabase project URL;
- Supabase anonymous key;
- Supabase service-role key;
- Exa API key;
- Cloudflare account ID and API token; a Groq key is optional and remains disabled by default;
- preferred production domain, if different from the existing Site URL.

Keys are sensitive. Configure them through the deployment platform and GitHub Actions secret settings; do not paste them into tracked files.

## Ordered setup

### 1. Database

Run `supabase/schema.sql` in a new Supabase project, then apply every migration in filename order. Existing projects must apply every pending migration and run `pnpm radar:backfill-integrity`. Confirm that these tables exist:

- `opportunities`
- `sources`
- `pipeline_runs`
- `saved_opportunities`
- `provider_usage_events`
- `opportunity_provenance`
- `url_fetch_cache`
- `source_checkpoints`, `discovery_attempts`, `discovered_urls`
- `organizers`, `event_series`, `opportunity_editions`, `opportunity_observations`

Confirm row-level security is enabled, `review_required` defaults to true after `202609250001_human_review_gate.sql`, and anonymous users can only select human-approved opportunities.

### 2. Local environment

Create `.env.local` from `.env.example`. At minimum configure:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
EXA_API_KEY
CINERADAR_TEAM_EMAILS
```

Configure Cloudflare Workers AI. Configure Groq only together with an explicit `GROQ_FALLBACK_ENABLED=true`; it is never attempted after Cloudflare. Generate a strong random `INGEST_SECRET` only if the ingestion API will be used; direct Supabase ingestion already works in the scheduled scripts.

### 3. Seed and smoke test

Run:

```bash
pnpm radar:seed-sources
pnpm radar:monitor
DISCOVERY_QUERY_LIMIT=2 DISCOVERY_RESULT_LIMIT=2 MAX_LLM_CALLS_PER_RUN=3 pnpm radar:discover
pnpm radar:cost-report
pnpm radar:benchmark
pnpm build
```

In PowerShell, set the three discovery limits with `$env:NAME = "value"` before running `pnpm radar:discover`, then remove those temporary variables after the smoke test.
Set `CINERADAR_BENCHMARK_WORKBOOK` to the local recovery workbook path before `pnpm radar:benchmark`; the command is read-only and never seeds production.

Inspect the database after each job. Reject any extraction that invented a deadline, fee, prize or official URL. Verify that newly ingested rows have `review_required=true` and remain invisible to anonymous visitors even when a source claims that submissions are open.

### 4. GitHub Actions

Add these repository secrets:

```text
EXA_API_KEY
NEXT_PUBLIC_SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
GROQ_API_KEY
```

`GROQ_API_KEY` is needed only if the optional provider is deliberately enabled later. Only Cloudflare is enabled by default. The current ChatGPT Sites remote cannot execute these workflows; use a GitHub mirror or local Task Scheduler only after the smoke test passes. Configure the GitHub spending limit to stop at zero.

### 5. Deployment

Configure the web app with:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
INGEST_SECRET
CINERADAR_TEAM_EMAILS
```

Build and deploy. Preserve public access to `/`; protect `/team` with both sign-in and the server-only `CINERADAR_TEAM_EMAILS` allowlist. If the allowlist is unset, `/team` must fail closed. If `.openai/hosting.json` already contains a `project_id`, reuse it. Remove that ID only when the owner explicitly requests a separate Site copy.

### 6. Production acceptance checks

Verify all of the following:

- the root page no longer shows the demo banner;
- search, type filter, AI-policy filter, sort and detail drawer work;
- `/api/opportunities` returns live rows without service credentials;
- `/team` redirects anonymous users to sign-in;
- a signed-in account not in `CINERADAR_TEAM_EMAILS` receives 404 and cannot read the review queue;
- the first manual discovery run writes a `pipeline_runs` row;
- source refresh sends no page to an LLM;
- a repeated discovery run does not send unchanged pages to the LLM;
- provider usage and provenance rows are persisted and unreadable to anonymous clients;
- source checkpoints advance, and temporal observations preserve prior claims;
- benchmark recall is measured against live discovered rows, without inserting workbook data;
- a failed source does not stop other sources;
- no secret appears in client JavaScript or deployment logs;
- mobile width has no horizontal overflow;
- `pnpm build` succeeds.

## Cost controls

Start with:

```text
DISCOVERY_QUERY_LIMIT=4
DISCOVERY_RESULT_LIMIT=5
MAX_LLM_CALLS_PER_RUN=24
MONTHLY_TARGET_EUR=3
OPTIONAL_STOP_EUR=4
MONTHLY_BUDGET_EUR=5
```

Discovery runs once daily. Source refresh runs twice daily with HTTP + hashes only, at most 40 sources and two child links per source per run. URL revalidation is weekly; historical and stale checks are monthly. Do not increase these ceilings until database yield and provider counters justify it. Keep Exa away from known-source monitoring. The ledger caps metered providers, not third-party hosting/account-plan charges; verify those plans separately.

## Recommended next engineering tasks

1. Persist signed-in saves through a server route backed by `saved_opportunities`.
2. Add reviewer actions for `discovered → verified → open` with an audit trail.
3. Add Discord and email digests only after source quality is stable.
4. Add per-domain adapters only for high-value pages that direct HTTP cannot read.
5. Review persisted provider usage and source-specific efficiency before enabling any deep-search feature.

Do not expand scope into a generic entertainment-news site. CineRadar's core is timely, source-backed opportunities that a filmmaker can act on.
