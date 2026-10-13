-- Public careers page: anyone (no sign-in) can see open jobs and apply.
--
-- Anonymous visitors get no table access at all. They can only:
--   * call list_public_jobs() / get_public_job(), which return the public
--     fields of jobs that are open and not archived (no hiring team, no
--     application counts, nothing about candidates), and
--   * submit an application through the submit-application Edge Function,
--     which uses the service role to call create_public_application() below
--     and to upload the CV. That RPC is not callable by anon or authenticated.

-- Applicants have no profile, so there is no creator to record.
alter table public.candidates alter column created_by drop not null;

-- When the applicant accepted the privacy notice (null for candidates HR added).
alter table public.candidates add column privacy_consent_at timestamptz;

create or replace function public.list_public_jobs()
returns table (
  id uuid,
  title text,
  team_name text,
  location text,
  employment_type text,
  description text,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, t.name, j.location, j.employment_type, j.description, j.created_at
  from jobs j
  left join teams t on t.id = j.team_id
  where j.status = 'open' and not j.archived
  order by j.created_at desc;
$$;

create or replace function public.get_public_job(p_job_id uuid)
returns table (
  id uuid,
  title text,
  team_name text,
  location text,
  employment_type text,
  description text,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select * from public.list_public_jobs() j where j.id = p_job_id;
$$;

revoke all on function public.list_public_jobs() from public;
revoke all on function public.get_public_job(uuid) from public;
grant execute on function public.list_public_jobs() to anon, authenticated;
grant execute on function public.get_public_job(uuid) to anon, authenticated;

-- Creates the candidate row for a careers-page application. Called only by the
-- submit-application Edge Function (service role), which has already checked
-- the request shape; the rules that matter are re-checked here.
create or replace function public.create_public_application(
  p_job_id uuid,
  p_full_name text,
  p_email text,
  p_phone text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_id uuid;
begin
  if not exists (select 1 from jobs where id = p_job_id and status = 'open' and not archived) then
    raise exception 'APPLY: This job is no longer accepting applications.';
  end if;
  if p_full_name is null or length(trim(p_full_name)) = 0 or length(p_full_name) > 200 then
    raise exception 'APPLY: Please enter your name.';
  end if;
  if v_email is null or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(v_email) > 254 then
    raise exception 'APPLY: Please enter a valid email address.';
  end if;
  if exists (select 1 from candidates where job_id = p_job_id and lower(email) = v_email) then
    raise exception 'APPLY: You have already applied for this job. We''ll be in touch.';
  end if;
  -- Coarse flood guard: the form is public, so cap total careers-page
  -- applications per hour rather than letting a script fill the pipeline.
  if (select count(*) from candidates where source = 'Careers page' and created_at > now() - interval '1 hour') >= 100 then
    raise exception 'APPLY: We''re receiving a lot of applications right now. Please try again in a little while.';
  end if;

  insert into candidates (job_id, full_name, email, phone, source, stage, created_by, privacy_consent_at)
    values (p_job_id, regexp_replace(trim(p_full_name), '\s+', ' ', 'g'), v_email,
            nullif(left(trim(coalesce(p_phone, '')), 40), ''), 'Careers page', 'applied', null, now())
    returning id into v_id;
  return v_id;
end; $$;

-- Who to email about a new application: the job's hiring team and every
-- active HR admin. Also service-role only (it returns email addresses).
create or replace function public.application_alert_recipients(p_job_id uuid)
returns table (email text, name text)
language sql stable security definer set search_path = public as $$
  select distinct u.email::text, p.full_name
  from profiles p
  join auth.users u on u.id = p.id
  where p.active and u.email is not null
    and (p.role = 'hr_admin' or p.id in (select profile_id from job_hiring_team where job_id = p_job_id));
$$;

-- See CLAUDE.md: Supabase grants EXECUTE to anon/authenticated explicitly, so
-- revoking PUBLIC alone would leave these callable from the browser.
revoke all on function public.create_public_application(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.application_alert_recipients(uuid) from public, anon, authenticated;
grant execute on function public.create_public_application(uuid, text, text, text) to service_role;
grant execute on function public.application_alert_recipients(uuid) to service_role;
