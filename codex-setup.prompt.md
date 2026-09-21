# Prompt for Codex

Set up this CineRadar repository for live production.

First read `README.md` and `CODEX_SETUP.md` completely, then inspect `.env.example`, `supabase/schema.sql`, `app/`, `lib/server/`, `scripts/cineradar/` and `.github/workflows/`.

Follow the ordered setup in `CODEX_SETUP.md`. Preserve the current visual design, demo fallback and cost guardrails. Use Supabase as the source of truth, Exa only for unknown-source discovery, direct HTTP plus hashes for known-source monitoring, Cloudflare Workers AI as the preferred extractor and Groq as fallback. Keep the target spend at or below €10/month.

Ask me only for credentials or account choices that are actually missing. Never print, commit or store secrets in tracked files. Run a tiny bounded smoke test before enabling schedules. Verify the production build, public radar, protected team route, ingestion pipeline and absence of client-side secrets. At the end, report exactly what is live, what remains in demo mode, current schedules and every recurring cost.
