begin;

alter table public.pipeline_runs
  drop constraint if exists pipeline_runs_kind_check;
alter table public.pipeline_runs
  add constraint pipeline_runs_kind_check check (
    kind in ('discovery', 'monitor', 'refresh', 'revalidation', 'stale')
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

alter table public.provider_usage_events enable row level security;
alter table public.opportunity_provenance enable row level security;
alter table public.url_fetch_cache enable row level security;

revoke all on public.provider_usage_events from anon, authenticated;
revoke all on public.opportunity_provenance from anon, authenticated;
revoke all on public.url_fetch_cache from anon, authenticated;

grant select, insert, update, delete on public.provider_usage_events to service_role;
grant select, insert, update, delete on public.opportunity_provenance to service_role;
grant select, insert, update, delete on public.url_fetch_cache to service_role;

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
    case
      when status = 'reserved' then reserved_cost_eur
      else estimated_cost_eur
    end
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

commit;
