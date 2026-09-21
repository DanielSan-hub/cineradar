# CineRadar

CineRadar is a public opportunity radar for filmmakers working with AI and emerging media. It discovers, verifies and organizes film festivals, platform contests, grants, residencies and advertising competitions.

The repository contains both the product and its acquisition pipeline:

- public searchable radar with filters, source confidence and deadline sorting;
- device-local saves, plus an authenticated team verification room;
- demo mode that works without external services;
- Supabase schema for live records, known sources and run history;
- Exa discovery workflow for unknown sources;
- direct HTTP monitoring for known sources;
- Cloudflare Workers AI first, Groq fallback, for structured extraction;
- scheduled GitHub Actions for discovery and monitoring;
- strict run limits so cost grows with useful candidates, not monitored pages.

## Quick start

Requirements: Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev
```

Open the URL printed by the development server. With no environment variables the app intentionally uses eight synthetic demo records.

## Production setup

1. Create a Supabase project and run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor.
2. Copy `.env.example` to `.env.local` and add the Supabase values.
3. Configure one LLM provider: Cloudflare Workers AI is preferred; Groq is the fallback.
4. Add an Exa key for web discovery.
5. Run `pnpm radar:seed-sources`, then `pnpm radar:discover` and `pnpm radar:monitor` once.
6. Add the same values as deployment variables and GitHub Actions secrets.
7. Deploy the app and enable the two included workflows.

The detailed Codex handoff is in [`CODEX_SETUP.md`](CODEX_SETUP.md). A ready-to-paste setup prompt is in [`codex-setup.prompt.md`](codex-setup.prompt.md).

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start the web app locally |
| `pnpm build` | Build the Cloudflare-compatible app |
| `pnpm lint` | Run static lint checks |
| `pnpm radar:seed-sources` | Add the initial known-source list |
| `pnpm radar:discover` | Run semantic discovery through Exa |
| `pnpm radar:monitor` | Check known sources and process changed pages |

## Data flow

```mermaid
flowchart TD
  A["Known sources"] --> B["HTTP monitor + hash"]
  C["Unknown web"] --> D["Exa discovery"]
  B --> E["Changed candidates"]
  D --> E
  E --> F["Structured LLM extraction"]
  F --> G["Deduplicate + confidence"]
  G --> H["Supabase"]
  H --> I["Public radar"]
  H --> J["Team verification queue"]
```

## Cost guardrails

- `DISCOVERY_QUERY_LIMIT` caps Exa queries per run.
- `DISCOVERY_RESULT_LIMIT` caps candidates per query.
- `MAX_LLM_CALLS_PER_RUN` is a hard extraction ceiling.
- Known-source monitoring hashes pages before sending changed content to an LLM.
- Provider selection is Cloudflare Workers AI, then Groq.
- The public UI only reads precomputed database records; it never performs live search on page load.

## Security model

- Supabase service keys are server-only and must never use the `NEXT_PUBLIC_` prefix.
- `/api/ingest` requires `INGEST_SECRET`.
- Public database access is read-only and limited by row-level security.
- The team route uses the hosting platform's ChatGPT sign-in flow.
- Automated leads remain `signal` or `discovered` until verification.

## Important folders

- `app/` — product routes and APIs
- `components/cineradar/` — radar interface
- `lib/server/` — data access and demo fallback
- `scripts/cineradar/` — discovery, monitoring and extraction pipeline
- `supabase/` — database schema
- `.github/workflows/` — scheduled jobs

## Notes

The records in `lib/demo-data.ts` are synthetic and explicitly displayed as demo data. Replace them by configuring Supabase; do not publish them as real opportunities.
