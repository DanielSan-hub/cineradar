create extension if not exists pgcrypto;

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  organizer text not null,
  category text not null check (category in (
    'AI film festival', 'Traditional festival', 'Platform challenge',
    'Grant', 'Residency', 'Advertising competition'
  )),
  status text not null default 'discovered' check (status in (
    'signal', 'discovered', 'verified', 'open', 'closing-soon', 'closed'
  )),
  ai_policy text not null default 'unclear' check (ai_policy in (
    'allowed', 'required', 'restricted', 'unclear'
  )),
  deadline timestamptz,
  opens_at timestamptz,
  prize_amount numeric,
  prize_currency text,
  entry_fee_amount numeric,
  entry_fee_currency text,
  location text not null default 'Online',
  remote boolean not null default true,
  max_runtime_minutes integer,
  source_url text not null unique,
  official_url text,
  source_type text not null default 'official' check (source_type in (
    'official', 'press', 'social', 'community'
  )),
  confidence numeric not null default 0.5 check (confidence >= 0 and confidence <= 1),
  summary text not null default '',
  eligibility jsonb not null default '[]'::jsonb,
  formats jsonb not null default '[]'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  discovered_at timestamptz not null default now(),
  verified_at timestamptz,
  featured boolean not null default false,
  content_hash text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_opportunities_status_deadline
  on public.opportunities (status, deadline);
create index if not exists idx_opportunities_category_status
  on public.opportunities (category, status);
create index if not exists idx_opportunities_discovered_at
  on public.opportunities (discovered_at desc);

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null unique,
  tier smallint not null default 2 check (tier between 1 and 3),
  enabled boolean not null default true,
  source_type text not null default 'official',
  last_hash text,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sources_enabled_tier
  on public.sources (enabled, tier);

create table if not exists public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('discovery', 'monitor')),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  candidates integer not null default 0,
  records_written integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.saved_opportunities (
  user_id text not null,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, opportunity_id)
);

alter table public.opportunities enable row level security;
alter table public.sources enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.saved_opportunities enable row level security;

drop policy if exists "Public can read published opportunities" on public.opportunities;
create policy "Public can read published opportunities"
  on public.opportunities for select
  using (status in ('verified', 'open', 'closing-soon'));

grant usage on schema public to anon, authenticated;
grant select on public.opportunities to anon, authenticated;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists opportunities_set_updated_at on public.opportunities;
create trigger opportunities_set_updated_at
before update on public.opportunities
for each row execute function public.set_updated_at();

drop trigger if exists sources_set_updated_at on public.sources;
create trigger sources_set_updated_at
before update on public.sources
for each row execute function public.set_updated_at();
