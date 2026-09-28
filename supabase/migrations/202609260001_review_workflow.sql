begin;

-- Human review workflow. Editorial decisions are recorded separately from the
-- automated review_required flag so that a rejected lead stays out of both the
-- public catalogue and the pending queue, and so that automated writers cannot
-- approve anything.
alter table public.opportunities
  add column if not exists review_decision text not null default 'pending';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_review_decision_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_review_decision_check
      check (review_decision in ('pending', 'approved', 'rejected', 'archived'));
  end if;
end
$$;

create index if not exists idx_opportunities_review_decision
  on public.opportunities (review_decision, confidence desc, discovered_at desc);

-- Append-only reviewer audit trail. Reviewer identity comes from the ChatGPT
-- Sites identity headers checked server-side, never from client input. The
-- table is service-role only because it stores reviewer email addresses.
create table if not exists public.opportunity_review_events (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete restrict,
  action text not null check (action in ('edit', 'approve', 'reject', 'archive', 'reopen')),
  reviewer_email text not null check (position('@' in reviewer_email) > 1),
  reviewer_name text,
  reason text not null check (char_length(btrim(reason)) between 3 and 2000),
  decision_before text not null,
  decision_after text not null,
  changed_fields text[] not null default '{}',
  before_fields jsonb not null check (jsonb_typeof(before_fields) = 'object'),
  after_fields jsonb not null check (jsonb_typeof(after_fields) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists idx_opportunity_review_events_opportunity_time
  on public.opportunity_review_events (opportunity_id, created_at desc);

create or replace function public.reject_review_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'review events are immutable; record a new review action';
end;
$$;

drop trigger if exists opportunity_review_events_immutable
  on public.opportunity_review_events;
create trigger opportunity_review_events_immutable
before update or delete on public.opportunity_review_events
for each row execute function public.reject_review_event_mutation();

alter table public.opportunity_review_events enable row level security;
revoke all on public.opportunity_review_events from anon, authenticated;
grant select, insert on public.opportunity_review_events to service_role;

-- Automated writers (ingest, monitor, revalidation, temporal observations) may
-- keep refreshing evidence, but they must not change a human decision or
-- silently rewrite facts a reviewer approved. apply_opportunity_review sets a
-- transaction-local flag that bypasses this guard.
create or replace function public.protect_reviewed_opportunity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('cineradar.review_write', true), '') = 'on' then
    return new;
  end if;

  -- Only the decision is forced here. Upserts see post-trigger EXCLUDED values,
  -- so forcing review_required would unpublish approved rows on every ingest;
  -- the column default and RLS already keep new rows private.
  if tg_op = 'INSERT' then
    new.review_decision := 'pending';
    return new;
  end if;

  new.review_decision := old.review_decision;
  if old.review_decision <> 'approved' then
    return new;
  end if;

  new.verified_at := old.verified_at;
  new.title := old.title;
  new.organizer := old.organizer;
  new.category := old.category;
  new.ai_policy := old.ai_policy;
  new.summary := old.summary;
  new.location := old.location;
  new.remote := old.remote;
  new.opens_at := old.opens_at;
  new.edition_year := old.edition_year;
  new.prize_amount := old.prize_amount;
  new.prize_currency := old.prize_currency;
  new.entry_fee_amount := old.entry_fee_amount;
  new.entry_fee_currency := old.entry_fee_currency;
  new.max_runtime_minutes := old.max_runtime_minutes;
  new.eligibility := old.eligibility;
  new.formats := old.formats;
  new.tags := old.tags;
  new.deadline_source_url := old.deadline_source_url;

  -- Revalidating the approved URL is allowed; replacing it is not.
  if new.official_url is distinct from old.official_url then
    new.official_url := old.official_url;
    new.official_url_status := old.official_url_status;
    new.official_url_http_status := old.official_url_http_status;
    new.official_url_final := old.official_url_final;
    new.official_url_last_checked_at := old.official_url_last_checked_at;
    new.official_url_verified_at := old.official_url_verified_at;
  end if;
  if new.application_url is distinct from old.application_url then
    new.application_url := old.application_url;
    new.application_url_status := old.application_url_status;
    new.application_url_http_status := old.application_url_http_status;
    new.application_url_final := old.application_url_final;
    new.application_url_last_checked_at := old.application_url_last_checked_at;
    new.application_url_verified_at := old.application_url_verified_at;
  end if;

  -- A newly observed deadline, reopening, or conflict changes what visitors
  -- would act on, so the record leaves the public catalogue until re-reviewed.
  -- Closing is the safe direction and does not need another review.
  if (new.status is distinct from old.status and new.status <> 'closed')
    or new.deadline is distinct from old.deadline
    or new.deadline_status is distinct from old.deadline_status
    or new.review_required
  then
    new.review_decision := 'pending';
    new.review_required := true;
    new.review_reason := coalesce(
      nullif(btrim(coalesce(new.review_reason, '')), ''),
      'Automated status or deadline change after approval'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists opportunities_protect_review on public.opportunities;
create trigger opportunities_protect_review
before insert or update on public.opportunities
for each row execute function public.protect_reviewed_opportunity();

-- Publication requires a recorded human approval, not only an absent flag.
drop policy if exists "Public can read published opportunities"
  on public.opportunities;
create policy "Public can read published opportunities"
  on public.opportunities for select
  using (
    status in ('verified', 'open', 'closing-soon')
    and not review_required
    and review_decision = 'approved'
    and verified_at is not null
  );

-- Returns the reasons a row may not be published. Keep the codes in sync with
-- lib/review-workflow.mjs, which uses the same rules only as UI hints.
create or replace function public.opportunity_publication_blockers(
  p_row public.opportunities,
  p_acknowledge_conflict boolean
)
returns text[]
language plpgsql
stable
set search_path = public
as $$
declare
  blockers text[] := '{}';
begin
  if p_row.status not in ('verified', 'open', 'closing-soon') then
    blockers := array_append(blockers, 'status-not-public');
  end if;
  if btrim(p_row.title) = '' then
    blockers := array_append(blockers, 'missing-title');
  end if;
  if btrim(p_row.organizer) = '' or lower(btrim(p_row.organizer)) in ('unknown', 'unknown organizer') then
    blockers := array_append(blockers, 'missing-organizer');
  end if;
  if not (
    (p_row.official_url is not null and p_row.official_url_status in ('verified', 'redirected'))
    or (p_row.source_type = 'official' and p_row.source_url_status in ('verified', 'redirected'))
  ) then
    blockers := array_append(blockers, 'no-verified-official-page');
  end if;
  if p_row.has_conflict and not coalesce(p_acknowledge_conflict, false) then
    blockers := array_append(blockers, 'unresolved-conflict');
  end if;
  if p_row.status in ('open', 'closing-soon') then
    if p_row.deadline_status = 'rolling' then
      null;
    elsif p_row.deadline is null or p_row.deadline_status <> 'confirmed' then
      blockers := array_append(blockers, 'deadline-not-confirmed');
    elsif p_row.deadline <= now() then
      blockers := array_append(blockers, 'deadline-passed');
    end if;
  end if;
  if p_row.status = 'closing-soon' and p_row.deadline is null then
    blockers := array_append(blockers, 'closing-soon-without-deadline');
  end if;
  return blockers;
end;
$$;

revoke all on function public.opportunity_publication_blockers(public.opportunities, boolean)
  from public, anon, authenticated;
grant execute on function public.opportunity_publication_blockers(public.opportunities, boolean)
  to service_role;

-- Apply one reviewer action atomically: lock, check for a concurrent change,
-- apply allowlisted field edits, enforce the publication gate, write the audit
-- event. p_changes keys must be editable columns; URL edits reset their
-- validation so an unchecked URL is never presented as verified.
create or replace function public.apply_opportunity_review(
  p_opportunity_id uuid,
  p_action text,
  p_reviewer_email text,
  p_reviewer_name text,
  p_reason text,
  p_changes jsonb,
  p_expected_updated_at timestamptz,
  p_target_status text default null,
  p_acknowledge_conflict boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  editable constant text[] := array[
    'title', 'organizer', 'category', 'ai_policy', 'summary', 'location',
    'remote', 'deadline', 'deadline_status', 'deadline_source_url', 'opens_at',
    'edition_year', 'prize_amount', 'prize_currency', 'entry_fee_amount',
    'entry_fee_currency', 'max_runtime_minutes', 'official_url',
    'application_url', 'eligibility', 'formats', 'tags'
  ];
  audited constant text[] := editable || array[
    'status', 'review_decision', 'review_required', 'review_reason',
    'verified_at', 'has_conflict', 'featured',
    'official_url_status', 'application_url_status'
  ];
  changes jsonb := coalesce(p_changes, '{}'::jsonb);
  unknown_keys text[];
  before_row public.opportunities%rowtype;
  after_row public.opportunities%rowtype;
  blockers text[];
  before_fields jsonb;
  after_fields jsonb;
  changed text[];
  event_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise insufficient_privilege using message = 'service role required';
  end if;
  if p_action not in ('edit', 'approve', 'reject', 'archive', 'reopen') then
    return jsonb_build_object('ok', false, 'error', 'invalid-action');
  end if;
  if p_reviewer_email is null or position('@' in p_reviewer_email) <= 1 then
    return jsonb_build_object('ok', false, 'error', 'invalid-reviewer');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 2000 then
    return jsonb_build_object('ok', false, 'error', 'reason-required');
  end if;
  if jsonb_typeof(changes) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid-changes');
  end if;
  select array_agg(key) into unknown_keys
  from jsonb_object_keys(changes) as key
  where key <> all (editable);
  if unknown_keys is not null then
    return jsonb_build_object('ok', false, 'error', 'field-not-editable', 'fields', to_jsonb(unknown_keys));
  end if;

  select * into before_row
  from public.opportunities
  where id = p_opportunity_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not-found');
  end if;
  if p_expected_updated_at is distinct from before_row.updated_at then
    return jsonb_build_object('ok', false, 'error', 'stale');
  end if;

  after_row := jsonb_populate_record(before_row, changes);

  if after_row.official_url is distinct from before_row.official_url then
    after_row.official_url_status := 'unchecked';
    after_row.official_url_http_status := null;
    after_row.official_url_final := null;
    after_row.official_url_last_checked_at := null;
    after_row.official_url_verified_at := null;
  end if;
  if after_row.application_url is distinct from before_row.application_url then
    after_row.application_url_status := 'unchecked';
    after_row.application_url_http_status := null;
    after_row.application_url_final := null;
    after_row.application_url_last_checked_at := null;
    after_row.application_url_verified_at := null;
  end if;

  if p_action = 'approve' then
    if p_target_status is null or p_target_status not in ('verified', 'open', 'closing-soon') then
      return jsonb_build_object('ok', false, 'error', 'invalid-target-status');
    end if;
    after_row.status := p_target_status;
  end if;

  if p_action = 'approve'
    or (p_action = 'edit' and before_row.review_decision = 'approved')
  then
    blockers := public.opportunity_publication_blockers(after_row, p_acknowledge_conflict);
    if cardinality(blockers) > 0 then
      return jsonb_build_object('ok', false, 'error', 'blocked', 'blockers', to_jsonb(blockers));
    end if;
  end if;

  case p_action
    when 'approve' then
      after_row.review_decision := 'approved';
      after_row.review_required := false;
      after_row.review_reason := null;
      after_row.verified_at := now();
      after_row.last_verified_at := now();
      after_row.has_conflict := false;
    when 'reject', 'archive' then
      after_row.review_decision := case p_action when 'reject' then 'rejected' else 'archived' end;
      after_row.review_required := true;
      after_row.review_reason := btrim(p_reason);
      after_row.featured := false;
    when 'reopen' then
      after_row.review_decision := 'pending';
      after_row.review_required := true;
      after_row.review_reason := btrim(p_reason);
    else
      null;
  end case;

  perform set_config('cineradar.review_write', 'on', true);
  update public.opportunities set
    title = after_row.title,
    organizer = after_row.organizer,
    category = after_row.category,
    ai_policy = after_row.ai_policy,
    summary = after_row.summary,
    location = after_row.location,
    remote = after_row.remote,
    deadline = after_row.deadline,
    deadline_status = after_row.deadline_status,
    deadline_source_url = after_row.deadline_source_url,
    opens_at = after_row.opens_at,
    edition_year = after_row.edition_year,
    prize_amount = after_row.prize_amount,
    prize_currency = after_row.prize_currency,
    entry_fee_amount = after_row.entry_fee_amount,
    entry_fee_currency = after_row.entry_fee_currency,
    max_runtime_minutes = after_row.max_runtime_minutes,
    official_url = after_row.official_url,
    official_url_status = after_row.official_url_status,
    official_url_http_status = after_row.official_url_http_status,
    official_url_final = after_row.official_url_final,
    official_url_last_checked_at = after_row.official_url_last_checked_at,
    official_url_verified_at = after_row.official_url_verified_at,
    application_url = after_row.application_url,
    application_url_status = after_row.application_url_status,
    application_url_http_status = after_row.application_url_http_status,
    application_url_final = after_row.application_url_final,
    application_url_last_checked_at = after_row.application_url_last_checked_at,
    application_url_verified_at = after_row.application_url_verified_at,
    eligibility = after_row.eligibility,
    formats = after_row.formats,
    tags = after_row.tags,
    status = after_row.status,
    review_decision = after_row.review_decision,
    review_required = after_row.review_required,
    review_reason = after_row.review_reason,
    verified_at = after_row.verified_at,
    last_verified_at = after_row.last_verified_at,
    has_conflict = after_row.has_conflict,
    featured = after_row.featured
  where id = p_opportunity_id
  returning * into after_row;
  perform set_config('cineradar.review_write', 'off', true);

  select
    coalesce(jsonb_object_agg(key, to_jsonb(before_row) -> key), '{}'::jsonb),
    coalesce(jsonb_object_agg(key, to_jsonb(after_row) -> key), '{}'::jsonb),
    coalesce(array_agg(key) filter (
      where (to_jsonb(before_row) -> key) is distinct from (to_jsonb(after_row) -> key)
    ), '{}')
  into before_fields, after_fields, changed
  from unnest(audited) as key;

  insert into public.opportunity_review_events (
    opportunity_id, action, reviewer_email, reviewer_name, reason,
    decision_before, decision_after, changed_fields, before_fields, after_fields
  ) values (
    p_opportunity_id, p_action, lower(btrim(p_reviewer_email)),
    nullif(btrim(coalesce(p_reviewer_name, '')), ''), btrim(p_reason),
    before_row.review_decision, after_row.review_decision, changed,
    before_fields, after_fields
  ) returning id into event_id;

  return jsonb_build_object(
    'ok', true,
    'event_id', event_id,
    'review_decision', after_row.review_decision,
    'updated_at', after_row.updated_at,
    'changed_fields', to_jsonb(changed)
  );
end;
$$;

revoke all on function public.apply_opportunity_review(
  uuid, text, text, text, text, jsonb, timestamptz, text, boolean
) from public, anon, authenticated;
grant execute on function public.apply_opportunity_review(
  uuid, text, text, text, text, jsonb, timestamptz, text, boolean
) to service_role;

comment on table public.opportunity_review_events is
  'Immutable human review actions with before/after field snapshots.';
comment on column public.opportunities.review_decision is
  'Human editorial decision; only apply_opportunity_review may change it.';

commit;
