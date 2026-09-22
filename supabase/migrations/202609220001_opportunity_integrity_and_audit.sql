begin;

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

-- Existing deadlines remain unknown until a verifier records supporting evidence.
update public.opportunities
set source_url_status = coalesce(source_url_status, 'unchecked'),
    official_url_status = coalesce(official_url_status, 'unchecked'),
    application_url_status = coalesce(application_url_status, 'unchecked'),
    deadline_status = coalesce(deadline_status, 'unknown')
where source_url_status is null
   or official_url_status is null
   or application_url_status is null
   or deadline_status is null;

alter table public.opportunities
  alter column source_url_status set default 'unchecked',
  alter column source_url_status set not null,
  alter column official_url_status set default 'unchecked',
  alter column official_url_status set not null,
  alter column application_url_status set default 'unchecked',
  alter column application_url_status set not null,
  alter column deadline_status set default 'unknown',
  alter column deadline_status set not null;

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

-- Evidence URLs are not entity identifiers: one page may list several calls or
-- editions. Remove the legacy one-column unique constraint without deleting data.
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

drop index if exists public.opportunities_source_url_key;

create unique index if not exists opportunities_canonical_key_unique_idx
  on public.opportunities (canonical_key);
create index if not exists idx_opportunities_source_url
  on public.opportunities (source_url);
create index if not exists idx_opportunities_deadline_status
  on public.opportunities (deadline_status, deadline);
create index if not exists idx_opportunities_edition_year
  on public.opportunities (edition_year);

alter table public.pipeline_runs
  add column if not exists discovered integer not null default 0,
  add column if not exists fetched integer not null default 0,
  add column if not exists parsed integer not null default 0,
  add column if not exists validated integer not null default 0,
  add column if not exists duplicates integer not null default 0,
  add column if not exists rejected integer not null default 0,
  add column if not exists stored integer not null default 0,
  add column if not exists rejection_reasons jsonb not null default '{}'::jsonb;

update public.pipeline_runs
set discovered = coalesce(discovered, 0),
    fetched = coalesce(fetched, 0),
    parsed = coalesce(parsed, 0),
    validated = coalesce(validated, 0),
    duplicates = coalesce(duplicates, 0),
    rejected = coalesce(rejected, 0),
    stored = coalesce(stored, 0),
    rejection_reasons = coalesce(rejection_reasons, '{}'::jsonb)
where discovered is null
   or fetched is null
   or parsed is null
   or validated is null
   or duplicates is null
   or rejected is null
   or stored is null
   or rejection_reasons is null;

alter table public.pipeline_runs
  alter column discovered set default 0,
  alter column discovered set not null,
  alter column fetched set default 0,
  alter column fetched set not null,
  alter column parsed set default 0,
  alter column parsed set not null,
  alter column validated set default 0,
  alter column validated set not null,
  alter column duplicates set default 0,
  alter column duplicates set not null,
  alter column rejected set default 0,
  alter column rejected set not null,
  alter column stored set default 0,
  alter column stored set not null,
  alter column rejection_reasons set default '{}'::jsonb,
  alter column rejection_reasons set not null;

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

-- Row-level security, grants and the public visibility policy are intentionally
-- unchanged by this migration.

commit;
