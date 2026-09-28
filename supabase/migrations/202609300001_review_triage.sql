begin;

-- Queue triage: a deterministic readiness score and flags written daily by
-- the triage job, used only to order and filter the pending review queue.
-- They never affect publication, which still requires a human approval.
alter table public.opportunities
  add column if not exists readiness_score smallint,
  add column if not exists triage_flags text[] not null default '{}',
  add column if not exists triaged_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.opportunities'::regclass
      and conname = 'opportunities_readiness_score_check'
  ) then
    alter table public.opportunities
      add constraint opportunities_readiness_score_check
      check (readiness_score is null or readiness_score between 0 and 100);
  end if;
end
$$;

create index if not exists idx_opportunities_review_readiness
  on public.opportunities (review_decision, readiness_score desc nulls last, confidence desc);
create index if not exists idx_opportunities_triage_flags
  on public.opportunities using gin (triage_flags);

commit;
