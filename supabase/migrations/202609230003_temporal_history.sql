begin;

-- Stable entities are separated from individual annual/rolling editions. No
-- existing opportunity is guessed into a series: linkage is populated only
-- after the normalizer has enough evidence.
create table if not exists public.organizers (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  canonical_name text not null,
  normalized_name text not null,
  website_url text,
  country text,
  region text,
  aliases text[] not null default '{}'::text[],
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (btrim(canonical_key) <> ''),
  check (btrim(canonical_name) <> ''),
  check (btrim(normalized_name) <> ''),
  check (last_seen_at >= first_seen_at),
  check (array_position(aliases, null) is null)
);

create index if not exists idx_organizers_normalized_name
  on public.organizers (normalized_name);
create index if not exists idx_organizers_geography
  on public.organizers (region, country);

create table if not exists public.event_series (
  id uuid primary key default gen_random_uuid(),
  canonical_key text not null unique,
  organizer_id uuid references public.organizers(id) on delete restrict,
  name text not null,
  normalized_name text not null,
  official_url text,
  source_family text,
  category text,
  country text,
  region text,
  language text,
  recurring boolean not null default true,
  earliest_known_year integer,
  latest_known_year integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (btrim(canonical_key) <> ''),
  check (btrim(name) <> ''),
  check (btrim(normalized_name) <> ''),
  check (earliest_known_year is null or earliest_known_year between 1900 and 2200),
  check (latest_known_year is null or latest_known_year between 1900 and 2200),
  check (
    earliest_known_year is null or latest_known_year is null
    or latest_known_year >= earliest_known_year
  ),
  check (last_seen_at >= first_seen_at)
);

create index if not exists idx_event_series_organizer
  on public.event_series (organizer_id, normalized_name);
create index if not exists idx_event_series_category_geography
  on public.event_series (category, region, country);

create table if not exists public.opportunity_editions (
  id uuid primary key default gen_random_uuid(),
  edition_key text not null unique,
  event_series_id uuid not null references public.event_series(id) on delete restrict,
  edition_label text,
  edition_year integer,
  title text not null,
  status text not null default 'discovered' check (
    status in ('signal', 'discovered', 'verified', 'open', 'closing-soon', 'closed')
  ),
  announcement_date date,
  opens_at timestamptz,
  deadline timestamptz,
  event_starts_at timestamptz,
  event_ends_at timestamptz,
  prize_amount numeric,
  prize_currency text,
  funding_amount numeric,
  funding_currency text,
  submission_count integer check (submission_count is null or submission_count >= 0),
  selection_count integer check (selection_count is null or selection_count >= 0),
  source_url text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_verified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (btrim(edition_key) <> ''),
  check (btrim(title) <> ''),
  check (edition_year is null or edition_year between 1900 and 2200),
  check (event_ends_at is null or event_starts_at is null or event_ends_at >= event_starts_at),
  check (last_seen_at >= first_seen_at),
  check (last_verified_at is null or last_verified_at >= first_seen_at)
);

create index if not exists idx_opportunity_editions_series_year
  on public.opportunity_editions (event_series_id, edition_year desc);
create index if not exists idx_opportunity_editions_status_deadline
  on public.opportunity_editions (status, deadline);
create index if not exists idx_opportunity_editions_seen
  on public.opportunity_editions (last_seen_at desc);

alter table public.opportunities
  add column if not exists opportunity_edition_id uuid
    references public.opportunity_editions(id) on delete set null,
  add column if not exists first_seen_at timestamptz,
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_verified_at timestamptz,
  add column if not exists previous_deadline timestamptz,
  add column if not exists previous_status text,
  add column if not exists has_conflict boolean not null default false,
  add column if not exists conflict_details jsonb not null default '[]'::jsonb,
  add column if not exists review_required boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists current_claim_priority smallint,
  add column if not exists current_claim_source_id uuid
    references public.sources(id) on delete set null,
  add column if not exists current_claim_source_url text,
  add column if not exists current_claim_observed_at timestamptz,
  add column if not exists current_status_claim_priority smallint,
  add column if not exists current_status_claim_source_id uuid
    references public.sources(id) on delete set null,
  add column if not exists current_status_claim_source_url text,
  add column if not exists current_status_claim_observed_at timestamptz,
  add column if not exists current_deadline_claim_priority smallint,
  add column if not exists current_deadline_claim_source_id uuid
    references public.sources(id) on delete set null,
  add column if not exists current_deadline_claim_source_url text,
  add column if not exists current_deadline_claim_observed_at timestamptz;

update public.opportunities
set first_seen_at = least(
      coalesce(first_seen_at, discovered_at, created_at, now()),
      last_verified_at, verified_at, deadline_last_verified_at,
      source_url_verified_at, official_url_verified_at, application_url_verified_at
    ),
    last_seen_at = greatest(
      coalesce(last_seen_at, updated_at, discovered_at, created_at, now()),
      coalesce(first_seen_at, discovered_at, created_at, now()),
      last_verified_at, verified_at, deadline_last_verified_at,
      source_url_verified_at, official_url_verified_at, application_url_verified_at
    ),
    last_verified_at = coalesce(
      last_verified_at,
      greatest(
        verified_at,
        deadline_last_verified_at,
        source_url_verified_at,
        official_url_verified_at,
        application_url_verified_at
      )
    )
where first_seen_at is null or last_seen_at is null or last_verified_at is null;

alter table public.opportunities
  alter column first_seen_at set default now(),
  alter column first_seen_at set not null,
  alter column last_seen_at set default now(),
  alter column last_seen_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_previous_status_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_previous_status_check check (
        previous_status is null or previous_status in (
          'signal', 'discovered', 'verified', 'open', 'closing-soon', 'closed'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_conflict_details_array_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_conflict_details_array_check
      check (jsonb_typeof(conflict_details) = 'array');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_seen_order_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_seen_order_check check (
        last_seen_at >= first_seen_at
        and (last_verified_at is null or last_verified_at >= first_seen_at)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_claim_priority_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_claim_priority_check check (
        current_claim_priority is null
        or current_claim_priority between 0 and 1000
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_field_claim_priorities_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_field_claim_priorities_check check (
        (current_status_claim_priority is null
          or current_status_claim_priority between 0 and 1000)
        and (current_deadline_claim_priority is null
          or current_deadline_claim_priority between 0 and 1000)
      );
  end if;
end
$$;

create index if not exists idx_opportunities_edition
  on public.opportunities (opportunity_edition_id);
create index if not exists idx_opportunities_temporal_review
  on public.opportunities (review_required, has_conflict, last_seen_at desc);

-- Observations are append-only evidence. Explicit temporal values make conflict
-- checks cheap while observed_fields retains the complete source snapshot.
create table if not exists public.opportunity_observations (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  opportunity_id uuid not null references public.opportunities(id) on delete restrict,
  opportunity_edition_id uuid references public.opportunity_editions(id) on delete restrict,
  source_id uuid references public.sources(id) on delete restrict,
  pipeline_run_id uuid references public.pipeline_runs(id) on delete set null,
  observed_at timestamptz not null default now(),
  source_url text not null,
  content_hash text,
  observed_status text check (
    observed_status is null or observed_status in (
      'signal', 'discovered', 'verified', 'open', 'closing-soon', 'closed'
    )
  ),
  observed_deadline timestamptz,
  deadline_status text check (
    deadline_status is null or deadline_status in (
      'confirmed', 'estimated', 'unknown', 'rolling'
    )
  ),
  is_primary_evidence boolean not null default false,
  claim_priority smallint not null default 100
    check (claim_priority between 0 and 1000),
  applied_to_current boolean not null default false,
  observed_fields jsonb not null default '{}'::jsonb
    check (jsonb_typeof(observed_fields) = 'object'),
  conflicts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(conflicts) = 'array'),
  created_at timestamptz not null default now(),
  check (btrim(idempotency_key) <> ''),
  check (btrim(source_url) <> '')
);

create index if not exists idx_opportunity_observations_opportunity_time
  on public.opportunity_observations (opportunity_id, observed_at desc);
create index if not exists idx_opportunity_observations_edition_time
  on public.opportunity_observations (opportunity_edition_id, observed_at desc);
create index if not exists idx_opportunity_observations_source_time
  on public.opportunity_observations (source_id, observed_at desc);
create index if not exists idx_opportunity_observations_conflicts
  on public.opportunity_observations (opportunity_id, observed_at desc)
  where conflicts <> '[]'::jsonb;

create or replace function public.reject_opportunity_observation_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'opportunity observations are immutable; append a new observation';
end;
$$;

drop trigger if exists opportunity_observations_immutable
  on public.opportunity_observations;
create trigger opportunity_observations_immutable
before update or delete on public.opportunity_observations
for each row execute function public.reject_opportunity_observation_mutation();

-- Append evidence and update the mutable current projection under one row lock.
-- Lower claim_priority values are stronger (for example, a primary application
-- detail page can outrank a directory summary). Contradictions are preserved and
-- flagged even when the stronger observation becomes the current projection.
create or replace function public.record_opportunity_observation(
  p_idempotency_key text,
  p_opportunity_id uuid,
  p_pipeline_run_id uuid,
  p_source_id uuid,
  p_opportunity_edition_id uuid,
  p_source_url text,
  p_content_hash text,
  p_observed_at timestamptz,
  p_observed_status text,
  p_observed_deadline timestamptz,
  p_deadline_status text,
  p_is_primary_evidence boolean,
  p_claim_priority smallint,
  p_observed_fields jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.opportunities%rowtype;
  source_record public.sources%rowtype;
  existing_observation public.opportunity_observations%rowtype;
  new_observation public.opportunity_observations%rowtype;
  effective_observed_at timestamptz := coalesce(p_observed_at, now());
  effective_claim_priority smallint;
  effective_edition_id uuid;
  has_deadline_claim boolean;
  apply_status boolean := false;
  apply_deadline boolean := false;
  should_apply boolean;
  conflicts jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise insufficient_privilege using message = 'service role required';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'idempotency key is required';
  end if;
  if p_opportunity_id is null then
    raise exception 'opportunity id is required';
  end if;
  if p_source_url is null or btrim(p_source_url) = '' then
    raise exception 'source URL is required';
  end if;
  if p_claim_priority is not null and p_claim_priority not between 0 and 1000 then
    raise exception 'claim priority must be between 0 and 1000';
  end if;
  if p_observed_status is not null and p_observed_status not in (
    'signal', 'discovered', 'verified', 'open', 'closing-soon', 'closed'
  ) then
    raise exception 'invalid observed status';
  end if;
  if p_deadline_status is not null and p_deadline_status not in (
    'confirmed', 'estimated', 'unknown', 'rolling'
  ) then
    raise exception 'invalid deadline status';
  end if;
  if p_deadline_status in ('confirmed', 'estimated')
    and p_observed_deadline is null then
    raise exception 'a confirmed or estimated deadline requires a date';
  end if;
  if p_deadline_status = 'rolling' and p_observed_deadline is not null then
    raise exception 'a rolling deadline cannot have a fixed date';
  end if;
  if coalesce(jsonb_typeof(p_observed_fields), 'object') <> 'object' then
    raise exception 'observed fields must be a JSON object';
  end if;

  select * into target
  from public.opportunities
  where id = p_opportunity_id
  for update;
  if not found then
    raise exception 'opportunity not found: %', p_opportunity_id;
  end if;
  if target.opportunity_edition_id is not null
    and p_opportunity_edition_id is not null
    and target.opportunity_edition_id <> p_opportunity_edition_id then
    raise exception 'observation edition conflicts with opportunity edition';
  end if;
  effective_edition_id := coalesce(
    p_opportunity_edition_id, target.opportunity_edition_id
  );

  select * into existing_observation
  from public.opportunity_observations
  where idempotency_key = p_idempotency_key;
  if found then
    if existing_observation.opportunity_id <> p_opportunity_id
      or existing_observation.source_url <> p_source_url
      or existing_observation.content_hash is distinct from p_content_hash
      or existing_observation.source_id is distinct from p_source_id
      or existing_observation.observed_status is distinct from p_observed_status
      or existing_observation.observed_deadline is distinct from p_observed_deadline
      or existing_observation.deadline_status is distinct from p_deadline_status then
      raise exception 'idempotency key belongs to different observation evidence';
    end if;
    return jsonb_build_object(
      'inserted', false,
      'idempotent_replay', true,
      'observation_id', existing_observation.id,
      'applied_to_current', existing_observation.applied_to_current,
      'conflict_count', jsonb_array_length(existing_observation.conflicts)
    );
  end if;

  if p_source_id is not null then
    select * into source_record
    from public.sources
    where id = p_source_id;
    if not found then
      raise exception 'source not found: %', p_source_id;
    end if;
  end if;
  -- Explicit caller rank can refine this policy; otherwise direct official
  -- evidence outranks an official landing page, directories, and press/social.
  effective_claim_priority := coalesce(
    p_claim_priority,
    case
      when coalesce(p_is_primary_evidence, false) then 10
      when source_record.source_family in (
        'structured-festival', 'opportunity-directory'
      ) then 60
      when source_record.source_type = 'official'
        and source_record.url is distinct from p_source_url then 20
      when source_record.source_type = 'official' then 30
      when source_record.source_type = 'press' then 80
      else 100
    end
  );

  has_deadline_claim := p_observed_deadline is not null
    or p_deadline_status = 'rolling';
  apply_status := p_observed_status is not null and (
    target.current_status_claim_priority is null
    or effective_claim_priority < target.current_status_claim_priority
    or (
      effective_claim_priority = target.current_status_claim_priority
      and effective_observed_at > coalesce(
        target.current_status_claim_observed_at, '-infinity'::timestamptz
      )
    )
  );
  apply_deadline := has_deadline_claim and (
    target.current_deadline_claim_priority is null
    or effective_claim_priority < target.current_deadline_claim_priority
    or (
      effective_claim_priority = target.current_deadline_claim_priority
      and effective_observed_at > coalesce(
        target.current_deadline_claim_observed_at, '-infinity'::timestamptz
      )
    )
  );
  should_apply := apply_status or apply_deadline;

  -- Only independent ranked claims can conflict. Normal progression from
  -- discovered to open is not a contradiction; open versus closed is.
  if target.current_status_claim_priority is not null
    and target.current_status_claim_source_url is distinct from p_source_url
    and (
      (target.status in ('open', 'closing-soon') and p_observed_status = 'closed')
      or (target.status = 'closed' and p_observed_status in ('open', 'closing-soon'))
    ) then
    conflicts := conflicts || jsonb_build_array(jsonb_build_object(
      'field', 'status',
      'current', target.status,
      'observed', p_observed_status,
      'current_source_url', target.current_status_claim_source_url,
      'observed_source_url', p_source_url,
      'current_claim_priority', target.current_status_claim_priority,
      'observed_claim_priority', effective_claim_priority
    ));
  end if;
  if has_deadline_claim
    and target.current_deadline_claim_priority is not null
    and target.current_deadline_claim_source_url is distinct from p_source_url
    and p_observed_deadline is distinct from target.deadline then
    conflicts := conflicts || jsonb_build_array(jsonb_build_object(
      'field', 'deadline',
      'current', target.deadline,
      'observed', p_observed_deadline,
      'current_deadline_status', target.deadline_status,
      'observed_deadline_status', p_deadline_status,
      'current_source_url', target.current_deadline_claim_source_url,
      'observed_source_url', p_source_url,
      'current_claim_priority', target.current_deadline_claim_priority,
      'observed_claim_priority', effective_claim_priority
    ));
  end if;

  insert into public.opportunity_observations (
    idempotency_key,
    opportunity_id,
    opportunity_edition_id,
    source_id,
    pipeline_run_id,
    observed_at,
    source_url,
    content_hash,
    observed_status,
    observed_deadline,
    deadline_status,
    is_primary_evidence,
    claim_priority,
    applied_to_current,
    observed_fields,
    conflicts
  ) values (
    p_idempotency_key,
    p_opportunity_id,
    effective_edition_id,
    p_source_id,
    p_pipeline_run_id,
    effective_observed_at,
    p_source_url,
    p_content_hash,
    p_observed_status,
    p_observed_deadline,
    p_deadline_status,
    coalesce(p_is_primary_evidence, false),
    effective_claim_priority,
    should_apply,
    coalesce(p_observed_fields, '{}'::jsonb),
    conflicts
  ) returning * into new_observation;

  update public.opportunities
  set first_seen_at = least(first_seen_at, effective_observed_at),
      last_seen_at = greatest(last_seen_at, effective_observed_at),
      last_verified_at = case
        when coalesce(p_is_primary_evidence, false)
          then greatest(coalesce(last_verified_at, effective_observed_at), effective_observed_at)
        else last_verified_at
      end,
      opportunity_edition_id = coalesce(opportunity_edition_id, effective_edition_id),
      previous_status = case
        when apply_status and p_observed_status is distinct from status then status
        else previous_status
      end,
      status = case
        when apply_status then p_observed_status
        else status
      end,
      previous_deadline = case
        when apply_deadline and p_observed_deadline is distinct from deadline then deadline
        else previous_deadline
      end,
      deadline = case
        when apply_deadline then p_observed_deadline
        else deadline
      end,
      deadline_status = case
        when apply_deadline then coalesce(p_deadline_status, 'unknown')
        else deadline_status
      end,
      deadline_source_url = case
        when apply_deadline then p_source_url
        else deadline_source_url
      end,
      deadline_last_verified_at = case
        when apply_deadline then effective_observed_at
        else deadline_last_verified_at
      end,
      current_claim_priority = case
        when should_apply then effective_claim_priority
        else current_claim_priority
      end,
      current_claim_source_id = case
        when should_apply then p_source_id
        else current_claim_source_id
      end,
      current_claim_source_url = case
        when should_apply then p_source_url
        else current_claim_source_url
      end,
      current_claim_observed_at = case
        when should_apply then effective_observed_at
        else current_claim_observed_at
      end,
      current_status_claim_priority = case
        when apply_status then effective_claim_priority
        else current_status_claim_priority
      end,
      current_status_claim_source_id = case
        when apply_status then p_source_id
        else current_status_claim_source_id
      end,
      current_status_claim_source_url = case
        when apply_status then p_source_url
        else current_status_claim_source_url
      end,
      current_status_claim_observed_at = case
        when apply_status then effective_observed_at
        else current_status_claim_observed_at
      end,
      current_deadline_claim_priority = case
        when apply_deadline then effective_claim_priority
        else current_deadline_claim_priority
      end,
      current_deadline_claim_source_id = case
        when apply_deadline then p_source_id
        else current_deadline_claim_source_id
      end,
      current_deadline_claim_source_url = case
        when apply_deadline then p_source_url
        else current_deadline_claim_source_url
      end,
      current_deadline_claim_observed_at = case
        when apply_deadline then effective_observed_at
        else current_deadline_claim_observed_at
      end,
      has_conflict = has_conflict or jsonb_array_length(conflicts) > 0,
      conflict_details = case
        when jsonb_array_length(conflicts) > 0 then (
          select coalesce(jsonb_agg(recent.item order by recent.position), '[]'::jsonb)
          from (
            select item, position
            from jsonb_array_elements(conflict_details || conflicts)
              with ordinality as evidence(item, position)
            order by position desc
            limit 20
          ) recent
        )
        else conflict_details
      end,
      review_required = review_required or jsonb_array_length(conflicts) > 0,
      review_reason = case
        when jsonb_array_length(conflicts) > 0 then 'Contradictory temporal source claims'
        else review_reason
      end
  where id = p_opportunity_id;

  if effective_edition_id is not null then
    update public.opportunity_editions
    set first_seen_at = least(first_seen_at, effective_observed_at),
        last_seen_at = greatest(last_seen_at, effective_observed_at),
        last_verified_at = case
          when coalesce(p_is_primary_evidence, false)
            then greatest(coalesce(last_verified_at, effective_observed_at), effective_observed_at)
          else last_verified_at
        end,
        status = case
          when apply_status then p_observed_status
          else status
        end,
        deadline = case
          when apply_deadline then p_observed_deadline
          else deadline
        end
    where id = effective_edition_id;
  end if;

  return jsonb_build_object(
    'inserted', true,
    'idempotent_replay', false,
    'observation_id', new_observation.id,
    'applied_to_current', should_apply,
    'applied_status', apply_status,
    'applied_deadline', apply_deadline,
    'claim_priority', effective_claim_priority,
    'conflict_count', jsonb_array_length(conflicts)
  );
end;
$$;

revoke all on function public.record_opportunity_observation(
  text, uuid, uuid, uuid, uuid, text, text, timestamptz, text,
  timestamptz, text, boolean, smallint, jsonb
) from public, anon, authenticated;
grant execute on function public.record_opportunity_observation(
  text, uuid, uuid, uuid, uuid, text, text, timestamptz, text,
  timestamptz, text, boolean, smallint, jsonb
) to service_role;

drop trigger if exists organizers_set_updated_at on public.organizers;
create trigger organizers_set_updated_at
before update on public.organizers
for each row execute function public.set_updated_at();

drop trigger if exists event_series_set_updated_at on public.event_series;
create trigger event_series_set_updated_at
before update on public.event_series
for each row execute function public.set_updated_at();

drop trigger if exists opportunity_editions_set_updated_at on public.opportunity_editions;
create trigger opportunity_editions_set_updated_at
before update on public.opportunity_editions
for each row execute function public.set_updated_at();

alter table public.organizers enable row level security;
alter table public.event_series enable row level security;
alter table public.opportunity_editions enable row level security;
alter table public.opportunity_observations enable row level security;

-- Conflicting claims must be reviewed before a row is visible to the public.
drop policy if exists "Public can read published opportunities"
  on public.opportunities;
create policy "Public can read published opportunities"
  on public.opportunities for select
  using (
    status in ('verified', 'open', 'closing-soon')
    and not review_required
  );

revoke all on public.organizers from anon, authenticated;
revoke all on public.event_series from anon, authenticated;
revoke all on public.opportunity_editions from anon, authenticated;
revoke all on public.opportunity_observations from anon, authenticated;

grant select, insert, update, delete on public.organizers to service_role;
grant select, insert, update, delete on public.event_series to service_role;
grant select, insert, update, delete on public.opportunity_editions to service_role;
grant select, insert on public.opportunity_observations to service_role;

comment on table public.organizers is
  'Stable organizer identities; populated only from evidence-backed normalization.';
comment on table public.event_series is
  'Recurring or conceptually stable opportunity series across editions.';
comment on table public.opportunity_editions is
  'One dated annual or rolling edition of an event series.';
comment on table public.opportunity_observations is
  'Immutable source observations; corrections are represented by later rows.';

commit;
