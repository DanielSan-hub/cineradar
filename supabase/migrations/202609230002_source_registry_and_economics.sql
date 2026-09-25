begin;

-- Turn the original seed list into a durable, adaptive source registry. Existing
-- source rows remain valid; conservative defaults let them be enriched over time.
alter table public.sources
  add column if not exists source_family text not null default 'official-site',
  add column if not exists country text,
  add column if not exists region text,
  add column if not exists language text,
  add column if not exists opportunity_categories text[] not null default '{}'::text[],
  add column if not exists priority smallint not null default 3,
  add column if not exists adapter text not null default 'generic',
  add column if not exists adapter_config jsonb not null default '{}'::jsonb,
  add column if not exists min_poll_interval_minutes integer not null default 360,
  add column if not exists poll_interval_minutes integer not null default 4320,
  add column if not exists max_poll_interval_minutes integer not null default 43200,
  add column if not exists next_check_at timestamptz,
  add column if not exists last_new_opportunity_at timestamptz,
  add column if not exists check_count bigint not null default 0,
  add column if not exists changed_check_count bigint not null default 0,
  add column if not exists candidate_url_count bigint not null default 0,
  add column if not exists successful_discoveries bigint not null default 0,
  add column if not exists unique_discoveries bigint not null default 0,
  add column if not exists false_positive_count bigint not null default 0,
  add column if not exists consecutive_no_change integer not null default 0,
  add column if not exists yield_score numeric(14,6) not null default 0,
  add column if not exists estimated_cost_eur numeric(14,8) not null default 0,
  add column if not exists health_status text not null default 'healthy',
  add column if not exists health_message text,
  add column if not exists last_error_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sources'::regclass
      and conname = 'sources_registry_text_check'
  ) then
    alter table public.sources
      add constraint sources_registry_text_check check (
        btrim(source_family) <> '' and btrim(adapter) <> ''
        and (country is null or btrim(country) <> '')
        and (region is null or btrim(region) <> '')
        and (language is null or btrim(language) <> '')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sources'::regclass
      and conname = 'sources_priority_check'
  ) then
    alter table public.sources
      add constraint sources_priority_check check (priority between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sources'::regclass
      and conname = 'sources_adapter_config_object_check'
  ) then
    alter table public.sources
      add constraint sources_adapter_config_object_check
      check (jsonb_typeof(adapter_config) = 'object');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sources'::regclass
      and conname = 'sources_categories_check'
  ) then
    alter table public.sources
      add constraint sources_categories_check check (
        cardinality(opportunity_categories) <= 32
        and array_position(opportunity_categories, null) is null
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sources'::regclass
      and conname = 'sources_poll_intervals_check'
  ) then
    alter table public.sources
      add constraint sources_poll_intervals_check check (
        min_poll_interval_minutes between 15 and 525600
        and poll_interval_minutes between min_poll_interval_minutes
          and max_poll_interval_minutes
        and max_poll_interval_minutes between min_poll_interval_minutes and 525600
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sources'::regclass
      and conname = 'sources_economics_nonnegative_check'
  ) then
    alter table public.sources
      add constraint sources_economics_nonnegative_check check (
        check_count >= 0 and changed_check_count >= 0
        and candidate_url_count >= 0 and successful_discoveries >= 0
        and unique_discoveries >= 0 and false_positive_count >= 0
        and consecutive_no_change >= 0 and yield_score >= 0
        and estimated_cost_eur >= 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sources'::regclass
      and conname = 'sources_health_status_check'
  ) then
    alter table public.sources
      add constraint sources_health_status_check check (
        health_status in ('healthy', 'degraded', 'failing', 'blocked', 'paused')
      );
  end if;
end
$$;

create index if not exists idx_sources_due
  on public.sources (next_check_at, priority, yield_score desc)
  where enabled and health_status not in ('blocked', 'paused');
create index if not exists idx_sources_family_region
  on public.sources (source_family, region, priority);
create index if not exists idx_sources_categories
  on public.sources using gin (opportunity_categories);
create index if not exists idx_sources_economics
  on public.sources (yield_score desc, estimated_cost_eur, unique_discoveries desc);

-- A source can have independent cursors for listings, feeds, archives, or other
-- adapter-defined streams. Cursor state is bounded by application logic and by
-- defensive database limits here.
create table if not exists public.source_checkpoints (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete restrict,
  checkpoint_key text not null default 'default',
  cursor_kind text not null default 'page' check (
    cursor_kind in ('none', 'page', 'cursor', 'link-window')
  ),
  cursor_value text,
  page_number integer not null default 1 check (page_number between 1 and 100000),
  link_offset integer not null default 0 check (link_offset between 0 and 1000000),
  link_window_size integer not null default 20 check (link_window_size between 1 and 200),
  cycle_count integer not null default 0 check (cycle_count >= 0),
  request_count bigint not null default 0 check (request_count >= 0),
  exhausted boolean not null default false,
  last_seen_url text,
  last_content_hash text,
  last_checked_at timestamptz,
  completed_cycle_at timestamptz,
  state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, checkpoint_key),
  check (btrim(checkpoint_key) <> '')
);

create index if not exists idx_source_checkpoints_source
  on public.source_checkpoints (source_id, checkpoint_key);

create table if not exists public.discovery_attempts (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text unique,
  pipeline_run_id uuid references public.pipeline_runs(id) on delete set null,
  source_id uuid references public.sources(id) on delete restrict,
  attempt_kind text not null default 'source' check (
    attempt_kind in ('source', 'gap-search', 'source-discovery', 'historical')
  ),
  provider text not null default 'http',
  operation text not null default 'fetch',
  query_id text,
  query_family text,
  query_text text,
  category text,
  region text,
  language text,
  status text not null default 'running' check (
    status in ('running', 'succeeded', 'failed', 'blocked', 'skipped')
  ),
  request_count integer not null default 0 check (request_count >= 0),
  result_count integer not null default 0 check (result_count >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  validated_count integer not null default 0 check (validated_count >= 0),
  unique_opportunity_count integer not null default 0
    check (unique_opportunity_count >= 0),
  unique_source_count integer not null default 0 check (unique_source_count >= 0),
  false_positive_count integer not null default 0 check (false_positive_count >= 0),
  estimated_cost_eur numeric(14,8) not null default 0
    check (estimated_cost_eur >= 0),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  check (finished_at is null or finished_at >= started_at),
  check (btrim(provider) <> '' and btrim(operation) <> '')
);

create index if not exists idx_discovery_attempts_source_time
  on public.discovery_attempts (source_id, started_at desc);
create index if not exists idx_discovery_attempts_query_time
  on public.discovery_attempts (query_family, started_at desc);
create index if not exists idx_discovery_attempts_economics
  on public.discovery_attempts (started_at desc, estimated_cost_eur, validated_count);

-- Rows are URL sightings per source. A composite key preserves multi-source
-- attribution; a partial key separately dedupes source-less gap-search rows.
create table if not exists public.discovered_urls (
  id uuid primary key default gen_random_uuid(),
  canonical_url text not null,
  source_id uuid references public.sources(id) on delete restrict,
  first_discovery_attempt_id uuid references public.discovery_attempts(id)
    on delete set null,
  last_discovery_attempt_id uuid references public.discovery_attempts(id)
    on delete set null,
  final_url text,
  status text not null default 'candidate' check (
    status in ('candidate', 'fetched', 'processed', 'rejected', 'ignored')
  ),
  content_hash text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count bigint not null default 1 check (seen_count >= 1),
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (btrim(canonical_url) <> ''),
  check (last_seen_at >= first_seen_at)
);

create unique index if not exists discovered_urls_source_url_unique_idx
  on public.discovered_urls (canonical_url, source_id);
create unique index if not exists discovered_urls_global_url_unique_idx
  on public.discovered_urls (canonical_url)
  where source_id is null;
create index if not exists idx_discovered_urls_status_seen
  on public.discovered_urls (status, last_seen_at desc);
create index if not exists idx_discovered_urls_source_seen
  on public.discovered_urls (source_id, last_seen_at desc);

drop trigger if exists source_checkpoints_set_updated_at on public.source_checkpoints;
create trigger source_checkpoints_set_updated_at
before update on public.source_checkpoints
for each row execute function public.set_updated_at();

drop trigger if exists discovered_urls_set_updated_at on public.discovered_urls;
create trigger discovered_urls_set_updated_at
before update on public.discovered_urls
for each row execute function public.set_updated_at();

-- Provider events carry enough context to calculate yield and cost per result,
-- validated opportunity, source, and query family without parsing metadata.
alter table public.provider_usage_events
  add column if not exists source_id uuid references public.sources(id) on delete set null,
  add column if not exists discovery_attempt_id uuid
    references public.discovery_attempts(id) on delete set null,
  add column if not exists query_id text,
  add column if not exists query_family text,
  add column if not exists query_text text,
  add column if not exists result_count integer not null default 0,
  add column if not exists validated_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.provider_usage_events'::regclass
      and conname = 'provider_usage_result_counts_check'
  ) then
    alter table public.provider_usage_events
      add constraint provider_usage_result_counts_check check (
        result_count >= 0 and validated_count >= 0
      );
  end if;
end
$$;

create index if not exists idx_provider_usage_source_time
  on public.provider_usage_events (source_id, occurred_at desc);
create index if not exists idx_provider_usage_query_time
  on public.provider_usage_events (query_family, occurred_at desc);
create index if not exists idx_provider_usage_attempt
  on public.provider_usage_events (discovery_attempt_id);

alter table public.pipeline_runs
  drop constraint if exists pipeline_runs_kind_check;
alter table public.pipeline_runs
  add constraint pipeline_runs_kind_check check (
    kind in (
      'discovery', 'monitor', 'refresh', 'revalidation', 'stale',
      'historical', 'benchmark'
    )
  );

alter table public.sources enable row level security;
alter table public.source_checkpoints enable row level security;
alter table public.discovery_attempts enable row level security;
alter table public.discovered_urls enable row level security;

revoke all on public.sources from anon, authenticated;
revoke all on public.source_checkpoints from anon, authenticated;
revoke all on public.discovery_attempts from anon, authenticated;
revoke all on public.discovered_urls from anon, authenticated;

grant select, insert, update, delete on public.sources to service_role;
grant select, insert, update, delete on public.source_checkpoints to service_role;
grant select, insert, update, delete on public.discovery_attempts to service_role;
grant select, insert, update, delete on public.discovered_urls to service_role;

-- Keep the existing RPC signature for deployed clients. The caller-provided
-- budget can only lower the absolute EUR 5 cap, never raise it. Reservations
-- with zero estimated cost remain available so free-source monitoring keeps
-- running after the paid budget is exhausted.
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
  projected_spend numeric := 0;
  current_daily_usage numeric := 0;
  requested_daily_usage numeric := 0;
  hard_budget numeric := least(p_monthly_budget_eur, 5::numeric);
  optional_cutoff numeric;
  utilization numeric := 1;
  block_reason text;
  linked_attempt_id uuid;
  linked_source_id uuid;
  attempt_source_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise insufficient_privilege using message = 'service role required';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'idempotency key is required';
  end if;
  if p_provider is null or btrim(p_provider) = ''
    or p_operation is null or btrim(p_operation) = '' then
    raise exception 'provider and operation are required';
  end if;
  if p_reserved_cost_eur is null or p_monthly_budget_eur is null
    or p_reserved_cost_eur < 0 or p_monthly_budget_eur < 0 then
    raise exception 'budget values must be nonnegative and nonnull';
  end if;
  if coalesce(jsonb_typeof(p_usage_units), 'object') <> 'object'
    or coalesce(jsonb_typeof(p_metadata), 'object') <> 'object' then
    raise exception 'usage units and metadata must be JSON objects';
  end if;

  linked_attempt_id := nullif(p_metadata->>'discovery_attempt_id', '')::uuid;
  linked_source_id := nullif(p_metadata->>'source_id', '')::uuid;
  if linked_attempt_id is not null then
    select source_id into attempt_source_id
    from public.discovery_attempts
    where id = linked_attempt_id;
    if not found then
      raise exception 'discovery attempt not found: %', linked_attempt_id;
    end if;
    if linked_source_id is null then
      linked_source_id := attempt_source_id;
    elsif attempt_source_id is not null
      and linked_source_id <> attempt_source_id then
      raise exception 'source id conflicts with discovery attempt';
    end if;
  end if;

  optional_cutoff := least(hard_budget * 0.8, 4::numeric);

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

  projected_spend := current_spend + p_reserved_cost_eur;
  utilization := case
    when hard_budget <= 0 then case when current_spend > 0 then 1 else 0 end
    else current_spend / hard_budget
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

  if p_reserved_cost_eur > 0
    and (hard_budget <= 0 or projected_spend > hard_budget) then
    block_reason := 'monthly-hard-cap';
  elsif p_reserved_cost_eur > 0 and p_optional
    and projected_spend >= optional_cutoff then
    block_reason := 'optional-disabled-at-80-percent';
  elsif p_daily_usage_limit is not null
    and current_daily_usage + requested_daily_usage > p_daily_usage_limit then
    block_reason := 'daily-provider-limit';
  end if;

  if block_reason is not null then
    insert into public.provider_usage_events (
      idempotency_key, pipeline_run_id, provider, operation, status, model,
      usage_units, reserved_cost_eur, estimated_cost_eur, error_code, metadata,
      source_id, discovery_attempt_id, query_id, query_family, query_text,
      result_count, validated_count,
      finalized_at
    ) values (
      p_idempotency_key, p_pipeline_run_id, p_provider, p_operation, 'blocked', p_model,
      coalesce(p_usage_units, '{}'::jsonb), 0, 0, block_reason,
      coalesce(p_metadata, '{}'::jsonb),
      linked_source_id,
      linked_attempt_id,
      nullif(p_metadata->>'query_id', ''),
      nullif(p_metadata->>'query_family', ''),
      nullif(p_metadata->>'query_text', ''),
      0, 0, now()
    ) returning * into new_event;
    return jsonb_build_object(
      'allowed', false,
      'reason', block_reason,
      'event_id', new_event.id,
      'spend_eur', current_spend,
      'projected_spend_eur', projected_spend,
      'hard_cap_eur', hard_budget,
      'optional_cutoff_eur', optional_cutoff,
      'utilization', utilization
    );
  end if;

  insert into public.provider_usage_events (
    idempotency_key, pipeline_run_id, provider, operation, status, model,
    usage_units, reserved_cost_eur, estimated_cost_eur, metadata,
    source_id, discovery_attempt_id, query_id, query_family, query_text
  ) values (
    p_idempotency_key, p_pipeline_run_id, p_provider, p_operation, 'reserved', p_model,
    coalesce(p_usage_units, '{}'::jsonb), p_reserved_cost_eur,
    p_reserved_cost_eur, coalesce(p_metadata, '{}'::jsonb),
    linked_source_id,
    linked_attempt_id,
    nullif(p_metadata->>'query_id', ''),
    nullif(p_metadata->>'query_family', ''),
    nullif(p_metadata->>'query_text', '')
  ) returning * into new_event;

  return jsonb_build_object(
    'allowed', true,
    'event_id', new_event.id,
    'spend_eur', projected_spend,
    'hard_cap_eur', hard_budget,
    'optional_cutoff_eur', optional_cutoff,
    'utilization', case
      when hard_budget <= 0 then 0
      else projected_spend / hard_budget
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
