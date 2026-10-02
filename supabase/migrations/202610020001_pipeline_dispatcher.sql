-- On-time pipeline trigger. GitHub starts scheduled workflows 1-7 hours late
-- on free accounts, so Supabase pg_cron dispatches the discovery and monitor
-- workflows through the GitHub API (workflow_dispatch) at the intended times.
-- The GitHub schedules stay as a fallback and skip themselves when a
-- dispatched run already covered the slot.
--
-- Prerequisite (owner, once, in the SQL editor; never commit the value):
--   select vault.create_secret('<fine-grained PAT>', 'cineradar_github_dispatch_token',
--     'GitHub fine-grained token: repository DanielSan-hub/cineradar, Actions read and write');
-- Without the secret the dispatcher does nothing and GitHub schedules run as before.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.cineradar_dispatch_workflow(p_workflow text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatch_token text;
  request_id bigint;
begin
  if p_workflow is null or p_workflow !~ '^[a-z][a-z0-9-]*\.yml$' then
    raise exception 'invalid workflow file name';
  end if;
  select decrypted_secret into dispatch_token
  from vault.decrypted_secrets
  where name = 'cineradar_github_dispatch_token'
  limit 1;
  if dispatch_token is null or btrim(dispatch_token) = '' then
    raise notice 'cineradar_github_dispatch_token is not set; dispatch skipped';
    return null;
  end if;
  select net.http_post(
    url := 'https://api.github.com/repos/DanielSan-hub/cineradar/actions/workflows/' || p_workflow || '/dispatches',
    body := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || dispatch_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'cineradar-dispatcher',
      'Content-Type', 'application/json'
    ),
    timeout_milliseconds := 10000
  ) into request_id;
  return request_id;
end;
$$;

revoke all on function public.cineradar_dispatch_workflow(text) from public, anon, authenticated;

-- Same UTC times as the GitHub schedules. cron.schedule with an existing job
-- name updates that job, so re-running this migration is safe.
select cron.schedule('cineradar-monitor', '43 4,16 * * *', $$select public.cineradar_dispatch_workflow('monitor.yml')$$);
select cron.schedule('cineradar-discovery', '17 6,18 * * *', $$select public.cineradar_dispatch_workflow('discovery.yml')$$);

-- Owner check (SQL editor): GitHub answers 204 when it accepted a dispatch.
--   select j.jobname, d.start_time, d.status from cron.job_run_details d
--     join cron.job j using (jobid) where j.jobname like 'cineradar-%'
--     order by d.start_time desc limit 10;
--   select created, status_code from net._http_response order by created desc limit 10;
