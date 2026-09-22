create extension if not exists pgcrypto;

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  canonical_key text,
  edition_year integer,
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
  deadline_status text not null default 'unknown'
    constraint opportunities_deadline_status_check check (deadline_status in (
      'confirmed', 'estimated', 'unknown', 'rolling'
    )),
  deadline_source_url text,
  deadline_last_verified_at timestamptz,
  opens_at timestamptz,
  prize_amount numeric,
  prize_currency text,
  entry_fee_amount numeric,
  entry_fee_currency text,
  location text not null default 'Online',
  remote boolean not null default true,
  max_runtime_minutes integer,
  source_url text not null,
  official_url text,
  application_url text,
  source_url_status text not null default 'unchecked'
    constraint opportunities_source_url_status_check check (source_url_status in (
      'unchecked', 'verified', 'redirected', 'invalid', 'unreachable'
    )),
  source_url_http_status integer
    constraint opportunities_source_url_http_status_check check (
      source_url_http_status between 100 and 599
    ),
  source_url_final text,
  source_url_last_checked_at timestamptz,
  source_url_verified_at timestamptz,
  official_url_status text not null default 'unchecked'
    constraint opportunities_official_url_status_check check (official_url_status in (
      'unchecked', 'verified', 'redirected', 'invalid', 'unreachable'
    )),
  official_url_http_status integer
    constraint opportunities_official_url_http_status_check check (
      official_url_http_status between 100 and 599
    ),
  official_url_final text,
  official_url_last_checked_at timestamptz,
  official_url_verified_at timestamptz,
  application_url_status text not null default 'unchecked'
    constraint opportunities_application_url_status_check check (application_url_status in (
      'unchecked', 'verified', 'redirected', 'invalid', 'unreachable'
    )),
  application_url_http_status integer
    constraint opportunities_application_url_http_status_check check (
      application_url_http_status between 100 and 599
    ),
  application_url_final text,
  application_url_last_checked_at timestamptz,
  application_url_verified_at timestamptz,
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

-- Keep this file safe to re-run against projects created from an older schema.
alter table public.opportunities
  add column if not exists canonical_key text,
  add column if not exists edition_year integer,
  add column if not exists application_url text,
  add column if not exists source_url_status text not null default 'unchecked',
  add column if not exists source_url_http_status integer,
  add column if not exists source_url_final text,
  add column if not exists source_url_last_checked_at timestamptz,
  add column if not exists source_url_verified_at timestamptz,
  add column if not exists official_url_status text not null default 'unchecked',
  add column if not exists official_url_http_status integer,
  add column if not exists official_url_final text,
  add column if not exists official_url_last_checked_at timestamptz,
  add column if not exists official_url_verified_at timestamptz,
  add column if not exists application_url_status text not null default 'unchecked',
  add column if not exists application_url_http_status integer,
  add column if not exists application_url_final text,
  add column if not exists application_url_last_checked_at timestamptz,
  add column if not exists application_url_verified_at timestamptz,
  add column if not exists deadline_status text not null default 'unknown',
  add column if not exists deadline_source_url text,
  add column if not exists deadline_last_verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_deadline_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_deadline_status_check
      check (deadline_status in ('confirmed', 'estimated', 'unknown', 'rolling'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_source_url_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_source_url_status_check
      check (source_url_status in ('unchecked', 'verified', 'redirected', 'invalid', 'unreachable'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_official_url_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_official_url_status_check
      check (official_url_status in ('unchecked', 'verified', 'redirected', 'invalid', 'unreachable'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_application_url_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_application_url_status_check
      check (application_url_status in ('unchecked', 'verified', 'redirected', 'invalid', 'unreachable'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_source_url_http_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_source_url_http_status_check
      check (source_url_http_status is null or source_url_http_status between 100 and 599);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_official_url_http_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_official_url_http_status_check
      check (official_url_http_status is null or official_url_http_status between 100 and 599);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_application_url_http_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_application_url_http_status_check
      check (application_url_http_status is null or application_url_http_status between 100 and 599);
  end if;
end
$$;

-- source_url identifies evidence, not the opportunity itself. One source page can
-- legitimately contain multiple calls or editions.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select constraint_row.conname
    from pg_constraint as constraint_row
    where constraint_row.conrelid = 'public.opportunities'::regclass
      and constraint_row.contype = 'u'
      and (
        select array_agg(attribute_row.attname::text order by key_row.ordinality)
        from unnest(constraint_row.conkey) with ordinality as key_row(attnum, ordinality)
        join pg_attribute as attribute_row
          on attribute_row.attrelid = constraint_row.conrelid
         and attribute_row.attnum = key_row.attnum
      ) = array['source_url']::text[]
  loop
    execute format(
      'alter table public.opportunities drop constraint %I',
      constraint_name
    );
  end loop;
end
$$;

create unique index if not exists opportunities_canonical_key_unique_idx
  on public.opportunities (canonical_key);
create index if not exists idx_opportunities_source_url
  on public.opportunities (source_url);

create index if not exists idx_opportunities_status_deadline
  on public.opportunities (status, deadline);
create index if not exists idx_opportunities_category_status
  on public.opportunities (category, status);
create index if not exists idx_opportunities_discovered_at
  on public.opportunities (discovered_at desc);
create index if not exists idx_opportunities_deadline_status
  on public.opportunities (deadline_status, deadline);
create index if not exists idx_opportunities_edition_year
  on public.opportunities (edition_year);

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
  discovered integer not null default 0,
  fetched integer not null default 0,
  parsed integer not null default 0,
  validated integer not null default 0,
  duplicates integer not null default 0,
  rejected integer not null default 0,
  stored integer not null default 0,
  rejection_reasons jsonb not null default '{}'::jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

alter table public.pipeline_runs
  add column if not exists discovered integer not null default 0,
  add column if not exists fetched integer not null default 0,
  add column if not exists parsed integer not null default 0,
  add column if not exists validated integer not null default 0,
  add column if not exists duplicates integer not null default 0,
  add column if not exists rejected integer not null default 0,
  add column if not exists stored integer not null default 0,
  add column if not exists rejection_reasons jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_counters_nonnegative_check'
  ) then
    alter table public.pipeline_runs
      add constraint pipeline_runs_counters_nonnegative_check check (
        discovered >= 0 and fetched >= 0 and parsed >= 0 and validated >= 0
        and duplicates >= 0 and rejected >= 0 and stored >= 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.pipeline_runs'::regclass
      and conname = 'pipeline_runs_rejection_reasons_object_check'
  ) then
    alter table public.pipeline_runs
      add constraint pipeline_runs_rejection_reasons_object_check
      check (jsonb_typeof(rejection_reasons) = 'object');
  end if;
end
$$;

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
