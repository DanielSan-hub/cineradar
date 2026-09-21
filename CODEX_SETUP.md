# Setting up CineRadar with Codex

This file is written for a future Codex session working inside this repository.

## Goal

Move CineRadar from demo mode to a live, low-cost production system while preserving:

- public read access;
- authenticated team verification;
- Exa only for discovery of unknown pages;
- direct fetch + content hashes for known sources;
- Cloudflare Workers AI first and Groq fallback;
- Supabase as the source of truth;
- an initial monthly operating budget ceiling of €10.

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
- Cloudflare account ID and API token, or a Groq key;
- preferred production domain, if different from the existing Site URL.

Keys are sensitive. Configure them through the deployment platform and GitHub Actions secret settings; do not paste them into tracked files.

## Ordered setup

### 1. Database

Run `supabase/schema.sql` in a new Supabase project. Confirm that these tables exist:

- `opportunities`
- `sources`
- `pipeline_runs`
- `saved_opportunities`

Confirm row-level security is enabled and anonymous users can only select published opportunities.

### 2. Local environment

Create `.env.local` from `.env.example`. At minimum configure:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
EXA_API_KEY
```

Configure Cloudflare Workers AI or Groq. Generate a strong random `INGEST_SECRET` only if the ingestion API will be used; direct Supabase ingestion already works in the scheduled scripts.

### 3. Seed and smoke test

Run:

```bash
pnpm radar:seed-sources
DISCOVERY_QUERY_LIMIT=2 DISCOVERY_RESULT_LIMIT=2 MAX_LLM_CALLS_PER_RUN=3 pnpm radar:discover
MAX_LLM_CALLS_PER_RUN=3 pnpm radar:monitor
pnpm build
```

Inspect the database after each job. Reject any extraction that invented a deadline, fee, prize or official URL.

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

Only one LLM provider is mandatory. Keep both workflows disabled until the smoke test passes, then run each manually once before relying on its schedule.

### 5. Deployment

Configure the web app with:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
INGEST_SECRET
```

Build and deploy. Preserve public access to `/`; preserve sign-in protection on `/team`. If `.openai/hosting.json` already contains a `project_id`, reuse it. Remove that ID only when the owner explicitly requests a separate Site copy.

### 6. Production acceptance checks

Verify all of the following:

- the root page no longer shows the demo banner;
- search, type filter, AI-policy filter, sort and detail drawer work;
- `/api/opportunities` returns live rows without service credentials;
- `/team` redirects anonymous users to sign-in;
- the first manual discovery run writes a `pipeline_runs` row;
- a repeated monitor run does not send unchanged pages to the LLM;
- a failed source does not stop other sources;
- no secret appears in client JavaScript or deployment logs;
- mobile width has no horizontal overflow;
- `pnpm build` succeeds.

## Cost controls

Start with:

```text
DISCOVERY_QUERY_LIMIT=24
DISCOVERY_RESULT_LIMIT=8
MAX_LLM_CALLS_PER_RUN=80
```

Discovery runs twice daily. Monitoring runs every six hours. Do not increase these ceilings until the database shows that the current queries miss valuable opportunities. Keep Exa away from known-source monitoring.

## Recommended next engineering tasks

1. Persist signed-in saves through a server route backed by `saved_opportunities`.
2. Add reviewer actions for `discovered → verified → open` with an audit trail.
3. Add Discord and email digests only after source quality is stable.
4. Add per-domain adapters only for high-value pages that direct HTTP cannot read.
5. Add budget telemetry before enabling live deep-search features.

Do not expand scope into a generic entertainment-news site. CineRadar's core is timely, source-backed opportunities that a filmmaker can act on.
