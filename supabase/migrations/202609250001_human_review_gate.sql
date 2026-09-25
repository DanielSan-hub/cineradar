begin;

-- A source-observed OPEN/CLOSED status is evidence, not editorial approval.
-- The temporal observation RPC never clears review_required, so this default
-- keeps future service-role inserts out of the public RLS policy until review.
alter table public.opportunities
  alter column review_required set default true;

-- Rows without a verification timestamp have no recorded human approval.
-- Quarantine them even if a legacy automated claim gave them a public status.
update public.opportunities
set review_required = true,
    review_reason = coalesce(review_reason, 'Human verification required')
where verified_at is null
  and review_required = false;

commit;
