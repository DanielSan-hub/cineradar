begin;

-- A recorded deadline in the past blocks every public status, not only open
-- calls: a "verified" record would otherwise be listed as current after its
-- call closed. Same signature, so apply_opportunity_review picks it up.
-- Keep the codes in sync with lib/review-workflow.mjs.
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
  if p_row.deadline is not null and p_row.deadline <= now() then
    blockers := array_append(blockers, 'deadline-passed');
  elsif p_row.status in ('open', 'closing-soon')
    and p_row.deadline_status <> 'rolling'
    and (p_row.deadline is null or p_row.deadline_status <> 'confirmed')
  then
    blockers := array_append(blockers, 'deadline-not-confirmed');
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

commit;
