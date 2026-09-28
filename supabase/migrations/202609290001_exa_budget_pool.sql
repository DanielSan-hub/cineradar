begin;

-- Owner decision 2026-09-28: Exa may spend up to 9 per month in its own
-- budget pool. Cloudflare, Groq and any other provider keep the original
-- shared ceiling of 5 (reduced at 3, optional work stopped at 4). Same
-- signature as before, so existing callers are unchanged; the ceilings are
-- enforced here so no client setting can raise them.
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
  -- Owner-approved ceilings live here, not in client configuration: Exa has
  -- its own pool (9/month); every other provider shares the original 5/month.
  budget_pool text := case when p_provider = 'exa' then 'exa' else 'core' end;
  hard_budget numeric := case
    when p_provider = 'exa' then least(p_monthly_budget_eur, 9::numeric)
    else least(p_monthly_budget_eur, 5::numeric)
  end;
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

  optional_cutoff := case
    when budget_pool = 'exa' then hard_budget * 0.9
    else least(hard_budget * 0.8, 4::numeric)
  end;

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
    and status in ('reserved', 'succeeded', 'uncertain')
    and (case when provider = 'exa' then 'exa' else 'core' end) = budget_pool;

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
      'budget_pool', budget_pool,
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
    'budget_pool', budget_pool,
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
