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
  review_required boolean not null default true,
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

with recovered as (
  select
    id,
    coalesce(
      nullif(raw_payload->>'canonical_key', ''),
      nullif(raw_payload#>>'{normalization,canonical_key}', '')
    ) as canonical_key
  from public.opportunities
  where canonical_key is null
), unique_recovered as (
  select canonical_key
  from recovered
  where canonical_key is not null
  group by canonical_key
  having count(*) = 1
)
update public.opportunities as opportunity
set canonical_key = recovered.canonical_key
from recovered
join unique_recovered using (canonical_key)
where opportunity.id = recovered.id;

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
  kind text not null check (kind in ('discovery', 'monitor', 'refresh', 'revalidation', 'stale')),
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
  drop constraint if exists pipeline_runs_kind_check;
alter table public.pipeline_runs
  add constraint pipeline_runs_kind_check check (
    kind in ('discovery', 'monitor', 'refresh', 'revalidation', 'stale')
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

create table if not exists public.provider_usage_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  pipeline_run_id uuid references public.pipeline_runs(id) on delete set null,
  provider text not null,
  operation text not null,
  occurred_at timestamptz not null default now(),
  status text not null check (status in (
    'reserved', 'succeeded', 'uncertain', 'released', 'blocked'
  )),
  model text,
  usage_units jsonb not null default '{}'::jsonb
    check (jsonb_typeof(usage_units) = 'object'),
  reserved_cost_eur numeric(14,8) not null default 0
    check (reserved_cost_eur >= 0),
  estimated_cost_eur numeric(14,8) not null default 0
    check (estimated_cost_eur >= 0),
  provider_cost numeric(14,8),
  provider_currency text,
  provider_request_id text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  error_code text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  finalized_at timestamptz
);

create index if not exists idx_provider_usage_provider_time
  on public.provider_usage_events (provider, occurred_at desc);
create index if not exists idx_provider_usage_monthly_budget
  on public.provider_usage_events (occurred_at, status);

create table if not exists public.opportunity_provenance (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  pipeline_run_id uuid references public.pipeline_runs(id) on delete set null,
  provider text not null,
  query_id text,
  query_text text,
  source_id uuid references public.sources(id) on delete set null,
  source_url text not null,
  result_rank integer check (result_rank is null or result_rank >= 0),
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object')
);

create index if not exists idx_opportunity_provenance_opportunity_time
  on public.opportunity_provenance (opportunity_id, observed_at desc);
create index if not exists idx_opportunity_provenance_provider_time
  on public.opportunity_provenance (provider, observed_at desc);
create index if not exists idx_opportunity_provenance_query
  on public.opportunity_provenance (query_id, observed_at desc);

create table if not exists public.url_fetch_cache (
  canonical_url text primary key,
  source_id uuid references public.sources(id) on delete set null,
  final_url text,
  content_hash text,
  processed_hash text,
  etag text,
  last_modified text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  content_type text,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  last_processed_at timestamptz,
  processor_version text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  next_retry_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists idx_url_fetch_cache_pending
  on public.url_fetch_cache (last_checked_at)
  where content_hash is distinct from processed_hash;
create index if not exists idx_url_fetch_cache_source
  on public.url_fetch_cache (source_id, last_checked_at desc);

alter table public.opportunities enable row level security;
alter table public.sources enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.saved_opportunities enable row level security;
alter table public.provider_usage_events enable row level security;
alter table public.opportunity_provenance enable row level security;
alter table public.url_fetch_cache enable row level security;

revoke all on public.provider_usage_events from anon, authenticated;
revoke all on public.opportunity_provenance from anon, authenticated;
revoke all on public.url_fetch_cache from anon, authenticated;

grant select, insert, update, delete on public.provider_usage_events to service_role;
grant select, insert, update, delete on public.opportunity_provenance to service_role;
grant select, insert, update, delete on public.url_fetch_cache to service_role;

alter table public.opportunities
  add column if not exists review_required boolean not null default true;

drop policy if exists "Public can read published opportunities" on public.opportunities;
create policy "Public can read published opportunities"
  on public.opportunities for select
  using (status in ('verified', 'open', 'closing-soon') and review_required = false);

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

create or replace function public.reserve_provider_usage(
  p_idempotency_key text,
  p_pipeline_run_id uuid,
  p_provider text,
  p_operation text,
  p_model text,
  p_reserved_cost_eur numeric,
  p_usage_units jsonb,
  p_monthly_budget_eur numeric,
  p_optional boolean default false,
  p_daily_usage_limit numeric default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_event public.provider_usage_events%rowtype;
  new_event public.provider_usage_events%rowtype;
  month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  day_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  current_spend numeric := 0;
  current_daily_usage numeric := 0;
  requested_daily_usage numeric := 0;
  utilization numeric := 1;
  block_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise insufficient_privilege using message = 'service role required';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'idempotency key is required';
  end if;
  if p_reserved_cost_eur < 0 or p_monthly_budget_eur < 0 then
    raise exception 'budget values must be nonnegative';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'cineradar-provider-budget-' || to_char(month_start, 'YYYY-MM'),
    0
  ));

  select * into existing_event
  from public.provider_usage_events
  where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'idempotent-replay',
      'event_id', existing_event.id,
      'status', existing_event.status
    );
  end if;

  select coalesce(sum(
    case when status = 'reserved' then reserved_cost_eur else estimated_cost_eur end
  ), 0)
  into current_spend
  from public.provider_usage_events
  where occurred_at >= month_start
    and status in ('reserved', 'succeeded', 'uncertain');

  utilization := case
    when p_monthly_budget_eur <= 0 then 1
    else current_spend / p_monthly_budget_eur
  end;

  if p_provider = 'cloudflare' and p_daily_usage_limit is not null then
    requested_daily_usage := coalesce((p_usage_units->>'reserved_neurons')::numeric, 0);
    select coalesce(sum(coalesce(
      (usage_units->>'neurons')::numeric,
      (usage_units->>'reserved_neurons')::numeric,
      0
    )), 0)
    into current_daily_usage
    from public.provider_usage_events
    where provider = 'cloudflare'
      and occurred_at >= day_start
      and status in ('reserved', 'succeeded', 'uncertain');
  end if;

  if p_monthly_budget_eur <= 0 or current_spend + p_reserved_cost_eur > p_monthly_budget_eur then
    block_reason := 'monthly-budget';
  elsif utilization >= 0.9 and p_optional then
    block_reason := 'optional-disabled-at-90-percent';
  elsif p_daily_usage_limit is not null
    and current_daily_usage + requested_daily_usage > p_daily_usage_limit then
    block_reason := 'daily-provider-limit';
  end if;

  if block_reason is not null then
    insert into public.provider_usage_events (
      idempotency_key, pipeline_run_id, provider, operation, status, model,
      usage_units, reserved_cost_eur, estimated_cost_eur, error_code, metadata,
      finalized_at
    ) values (
      p_idempotency_key, p_pipeline_run_id, p_provider, p_operation, 'blocked', p_model,
      coalesce(p_usage_units, '{}'::jsonb), 0, 0, block_reason,
      coalesce(p_metadata, '{}'::jsonb), now()
    ) returning * into new_event;
    return jsonb_build_object(
      'allowed', false,
      'reason', block_reason,
      'event_id', new_event.id,
      'spend_eur', current_spend,
      'utilization', utilization
    );
  end if;

  insert into public.provider_usage_events (
    idempotency_key, pipeline_run_id, provider, operation, status, model,
    usage_units, reserved_cost_eur, estimated_cost_eur, metadata
  ) values (
    p_idempotency_key, p_pipeline_run_id, p_provider, p_operation, 'reserved', p_model,
    coalesce(p_usage_units, '{}'::jsonb), p_reserved_cost_eur,
    p_reserved_cost_eur, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into new_event;

  return jsonb_build_object(
    'allowed', true,
    'event_id', new_event.id,
    'spend_eur', current_spend + p_reserved_cost_eur,
    'utilization', case
      when p_monthly_budget_eur <= 0 then 1
      else (current_spend + p_reserved_cost_eur) / p_monthly_budget_eur
    end
  );
end;
$$;

revoke all on function public.reserve_provider_usage(
  text, uuid, text, text, text, numeric, jsonb, numeric, boolean, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.reserve_provider_usage(
  text, uuid, text, text, text, numeric, jsonb, numeric, boolean, numeric, jsonb
) to service_role;
