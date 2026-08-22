-- Break-overrun alerts: when an employee stays on their first break longer
-- than the allowed window, email their team lead, their manager, and every HR
-- admin. Sending happens in the notify-long-breaks edge function (Postgres
-- can't talk SMTP); this migration provides the two queries that function
-- needs and the bookkeeping that stops it re-alerting the same break.

alter table public.attendance_sessions add column break_alert_sent_at timestamptz;

-- Returns one row per (overrunning employee x recipient), with the recipient's
-- email resolved from auth.users -- which is why this is SECURITY DEFINER.
--
-- "Alert once per break" is derived rather than flagged: a break counts as
-- already-alerted only when break_alert_sent_at is newer than the *current*
-- break's start. Because break_start overwrites first_break_started_at, a
-- second break on the same day automatically becomes eligible again with no
-- flag to reset -- and, importantly, no change to
-- _record_attendance_event_core, which stays exactly as it is.
create or replace function public.pending_break_alerts(p_threshold_minutes int default 17)
returns table (
  session_id uuid,
  employee_name text,
  employee_code text,
  break_started_at timestamptz,
  minutes_elapsed int,
  recipient_email text,
  recipient_name text
)
language sql stable security definer set search_path = public, auth as $$
  with overrun as (
    select s.id as session_id,
           s.employee_id,
           p.full_name,
           p.employee_code,
           p.team_id,
           s.first_break_started_at,
           floor(extract(epoch from (now() - s.first_break_started_at)) / 60)::int as mins
    from attendance_sessions s
    join profiles p on p.id = s.employee_id
    where s.state = 'on_break'
      and s.first_break_started_at is not null
      and s.first_break_started_at < now() - make_interval(mins => p_threshold_minutes)
      and (s.break_alert_sent_at is null or s.break_alert_sent_at < s.first_break_started_at)
  ),
  recipients as (
    select o.session_id, t.team_lead_id as recipient_id
      from overrun o join teams t on t.id = o.team_id
      where t.team_lead_id is not null
    union
    select o.session_id, t.manager_id
      from overrun o join teams t on t.id = o.team_id
      where t.manager_id is not null
    union
    select o.session_id, hr.id
      from overrun o
      cross join (select id from profiles where role = 'hr_admin' and active) hr
  )
  select o.session_id,
         o.full_name,
         o.employee_code,
         o.first_break_started_at,
         o.mins,
         u.email::text,
         rp.full_name
  from overrun o
  join recipients r on r.session_id = o.session_id
  join profiles rp on rp.id = r.recipient_id
  join auth.users u on u.id = r.recipient_id
  where rp.active
    and u.email is not null
    -- A supervisor on their own long break shouldn't be emailed about it.
    and rp.id <> o.employee_id;
$$;

create or replace function public.mark_break_alerts_sent(p_session_ids uuid[])
returns void
language sql security definer set search_path = public as $$
  update attendance_sessions
     set break_alert_sent_at = now()
   where id = any(p_session_ids);
$$;

-- Internal helpers: reachable only by the edge function's service-role client.
-- Revoked from anon and authenticated as well as PUBLIC, because Supabase's
-- default privileges grant EXECUTE to those roles explicitly and revoking
-- PUBLIC alone would leave them in place (see 20260912). pending_break_alerts
-- exposes employee emails, so this matters.
revoke all on function public.pending_break_alerts(int) from public, anon, authenticated;
revoke all on function public.mark_break_alerts_sent(uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- SCHEDULING -- run once per environment, by hand, after deploying the
-- notify-long-breaks function. Not part of this migration because it embeds
-- environment-specific values (project URL, shared secret) and would make the
-- migration unreplayable elsewhere.
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--
--   -- Store the call secret rather than inlining it: cron.job is readable by
--   -- anyone who can read the cron schema.
--   select vault.create_secret('<the same value as BREAK_ALERT_SECRET>', 'break_alert_secret');
--
--   select cron.schedule('break-overrun-alerts', '* * * * *', $job$
--     select net.http_post(
--       url     := 'https://<project-ref>.supabase.co/functions/v1/notify-long-breaks',
--       headers := jsonb_build_object(
--         'Content-Type',   'application/json',
--         'x-alert-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'break_alert_secret')
--       ),
--       body    := '{}'::jsonb
--     );
--   $job$);
--
-- To stop it:  select cron.unschedule('break-overrun-alerts');
-- To inspect:  select * from cron.job_run_details order by start_time desc limit 20;
-- ---------------------------------------------------------------------------
