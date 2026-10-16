-- The two pg_cron adoption jobs. Until now they existed only on the live
-- project (scheduled through the Management API, no migration), with
-- ADMIN_TASK_KEY and the anon key as literals inside cron.job.command — and
-- pg_cron copies the command into every cron.job_run_details row.
--
-- Both jobs now read everything from Vault at run time, so this file carries
-- no secret. A fresh project needs these three entries before it is applied:
--
--   select vault.create_secret('<ADMIN_TASK_KEY>',  'admin_task_key');
--   select vault.create_secret('<anon key>',        'supabase_anon_key');
--   select vault.create_secret('https://<ref>.supabase.co', 'supabase_url');
--
-- admin_task_key must equal the edge-function secret of the same name;
-- rotating one means rotating both (see security/keys-and-tokens.md).
-- Idempotent: unschedule-if-present, then schedule.

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('adoption-report-mon-sat', 'adoption-remind-mon-sat') loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

-- Mon–Sat 13:00 UTC (8am Central in summer, 7am in winter). Sundays are
-- deliberately skipped (owner's call).
select cron.schedule('adoption-report-mon-sat', '0 13 * * 1-6', $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/weekly-review',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_anon_key'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_anon_key')
    ),
    body := jsonb_build_object(
      'action', 'signinReport',
      'key', (select decrypted_secret from vault.decrypted_secrets where name = 'admin_task_key')
    )
  );
$cmd$);

select cron.schedule('adoption-remind-mon-sat', '0 13 * * 1-6', $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_url') || '/functions/v1/weekly-review',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_anon_key'),
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'supabase_anon_key')
    ),
    body := jsonb_build_object(
      'action', 'remind',
      'key', (select decrypted_secret from vault.decrypted_secrets where name = 'admin_task_key')
    )
  );
$cmd$);
