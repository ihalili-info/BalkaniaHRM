-- Recruitment (core ATS): job postings, candidates moving through a fixed
-- pipeline, notes, CVs, and a link from a hired candidate to their employee
-- profile.
--
-- Access model:
--   * HR admins manage everything (jobs, hiring teams, candidates, CVs).
--   * Anyone HR puts on a job's hiring team (managers / team leads) can see that
--     job and its candidates, read CVs, add notes, and move candidates between
--     stages -- except into or out of "hired", which stays with HR because it
--     leads to creating an employee record.
-- Hiring-team members never get direct table writes on candidates: stage moves
-- and notes go through the security-definer RPCs below.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  team_id uuid references public.teams(id) on delete set null,
  location text,
  employment_type text not null default 'full_time'
    check (employment_type in ('full_time', 'part_time', 'contract', 'temporary', 'internship')),
  openings int not null default 1 check (openings > 0),
  status text not null default 'open' check (status in ('draft', 'open', 'on_hold', 'closed')),
  description text,
  archived boolean not null default false,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.job_hiring_team (
  job_id uuid not null references public.jobs(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (job_id, profile_id)
);

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) > 0),
  email text,
  phone text,
  source text,
  stage text not null default 'applied'
    check (stage in ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected')),
  interview_at timestamptz,
  cv_path text,
  hired_employee_id uuid references public.profiles(id) on delete set null,
  created_by uuid not null default auth.uid() references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index candidates_job_id_idx on public.candidates (job_id);

create table public.candidate_notes (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id),
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

create index candidate_notes_candidate_id_idx on public.candidate_notes (candidate_id);

-- ---------------------------------------------------------------------------
-- Access helpers (answer "may the caller see this?", so safe to expose)
-- ---------------------------------------------------------------------------

create or replace function public.can_access_job(p_job_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_role_is(array['hr_admin'])
    or exists (select 1 from public.job_hiring_team where job_id = p_job_id and profile_id = auth.uid());
$$;

create or replace function public.can_access_candidate(p_candidate_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.candidates c where c.id = p_candidate_id and public.can_access_job(c.job_id));
$$;

-- For storage policies: CV objects live at "<candidate id>/<file name>", and the
-- folder name is compared as text so a malformed path can't raise a cast error.
create or replace function public.can_access_candidate_folder(p_folder text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.candidates c where c.id::text = p_folder and public.can_access_job(c.job_id));
$$;

revoke all on function public.can_access_job(uuid) from public, anon;
revoke all on function public.can_access_candidate(uuid) from public, anon;
revoke all on function public.can_access_candidate_folder(text) from public, anon;
grant execute on function public.can_access_job(uuid) to authenticated;
grant execute on function public.can_access_candidate(uuid) to authenticated;
grant execute on function public.can_access_candidate_folder(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.jobs enable row level security;
alter table public.job_hiring_team enable row level security;
alter table public.candidates enable row level security;
alter table public.candidate_notes enable row level security;

create policy "read accessible jobs" on public.jobs
  for select to authenticated using (public.can_access_job(id));
create policy "hr admin insert jobs" on public.jobs
  for insert to authenticated with check (public.current_role_is(array['hr_admin']));
create policy "hr admin update jobs" on public.jobs
  for update to authenticated using (public.current_role_is(array['hr_admin'])) with check (public.current_role_is(array['hr_admin']));
create policy "hr admin delete jobs" on public.jobs
  for delete to authenticated using (public.current_role_is(array['hr_admin']));

create policy "read accessible hiring teams" on public.job_hiring_team
  for select to authenticated using (public.can_access_job(job_id));
create policy "hr admin insert hiring team" on public.job_hiring_team
  for insert to authenticated with check (public.current_role_is(array['hr_admin']));
create policy "hr admin delete hiring team" on public.job_hiring_team
  for delete to authenticated using (public.current_role_is(array['hr_admin']));

create policy "read accessible candidates" on public.candidates
  for select to authenticated using (public.can_access_job(job_id));
create policy "hr admin insert candidates" on public.candidates
  for insert to authenticated with check (public.current_role_is(array['hr_admin']));
create policy "hr admin update candidates" on public.candidates
  for update to authenticated using (public.current_role_is(array['hr_admin'])) with check (public.current_role_is(array['hr_admin']));
create policy "hr admin delete candidates" on public.candidates
  for delete to authenticated using (public.current_role_is(array['hr_admin']));

create policy "read accessible candidate notes" on public.candidate_notes
  for select to authenticated using (public.can_access_candidate(candidate_id));
create policy "authors delete own notes, hr deletes any" on public.candidate_notes
  for delete to authenticated using (author_id = auth.uid() or public.current_role_is(array['hr_admin']));
-- Inserts go through add_candidate_note() so author_id can't be spoofed.

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Job list with what the list screen needs in one round trip: department name,
-- application count, and hiring-team names (managers can't necessarily read
-- every hiring-team member's profile row directly).
create or replace function public.list_jobs()
returns table (
  id uuid,
  title text,
  team_id uuid,
  team_name text,
  location text,
  employment_type text,
  openings int,
  status text,
  description text,
  archived boolean,
  created_at timestamptz,
  application_count bigint,
  hiring_team jsonb
)
language sql stable security definer set search_path = public as $$
  select j.id, j.title, j.team_id, t.name, j.location, j.employment_type, j.openings, j.status,
         j.description, j.archived, j.created_at,
         (select count(*) from candidates c where c.job_id = j.id),
         coalesce((
           select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name) order by p.full_name)
           from job_hiring_team h join profiles p on p.id = h.profile_id
           where h.job_id = j.id
         ), '[]'::jsonb)
  from jobs j
  left join teams t on t.id = j.team_id
  where public.can_access_job(j.id)
  order by j.created_at desc;
$$;

revoke all on function public.list_jobs() from public, anon;
grant execute on function public.list_jobs() to authenticated;

-- Replace a job's hiring team in one call.
create or replace function public.set_job_hiring_team(p_job_id uuid, p_profile_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.current_role_is(array['hr_admin']) then
    raise exception 'Only HR administrators can change a hiring team';
  end if;
  if not exists (select 1 from jobs where id = p_job_id) then raise exception 'Job not found'; end if;

  delete from job_hiring_team where job_id = p_job_id;
  insert into job_hiring_team (job_id, profile_id)
    select p_job_id, p.id from profiles p
    where p.id = any(coalesce(p_profile_ids, array[]::uuid[]))
      and p.role in ('manager', 'team_lead', 'hr_admin')
      and p.active;
end; $$;

revoke all on function public.set_job_hiring_team(uuid, uuid[]) from public, anon;
grant execute on function public.set_job_hiring_team(uuid, uuid[]) to authenticated;

-- Stage moves (and the interview time) for HR and the job's hiring team.
-- p_interview_at has no default on purpose: the caller always sends the current
-- value, so a stage move can't silently clear a scheduled interview.
create or replace function public.set_candidate_stage(p_candidate_id uuid, p_stage text, p_interview_at timestamptz)
returns public.candidates language plpgsql security definer set search_path = public as $$
declare
  v_candidate public.candidates;
  v_is_hr boolean := public.current_role_is(array['hr_admin']);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_stage not in ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected') then
    raise exception 'Invalid stage';
  end if;

  select * into v_candidate from candidates where id = p_candidate_id for update;
  if v_candidate is null then raise exception 'Candidate not found'; end if;
  if not public.can_access_job(v_candidate.job_id) then
    raise exception 'Not authorized to update this candidate';
  end if;
  if not v_is_hr and (p_stage = 'hired' or v_candidate.stage = 'hired') then
    raise exception 'Only HR can move a candidate into or out of Hired.';
  end if;

  update candidates
    set stage = p_stage,
        interview_at = p_interview_at,
        updated_at = now()
    where id = p_candidate_id
    returning * into v_candidate;
  return v_candidate;
end; $$;

revoke all on function public.set_candidate_stage(uuid, text, timestamptz) from public, anon;
grant execute on function public.set_candidate_stage(uuid, text, timestamptz) to authenticated;

create or replace function public.add_candidate_note(p_candidate_id uuid, p_body text)
returns public.candidate_notes language plpgsql security definer set search_path = public as $$
declare
  v_note public.candidate_notes;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.can_access_candidate(p_candidate_id) then
    raise exception 'Not authorized to add notes for this candidate';
  end if;
  if p_body is null or length(trim(p_body)) = 0 then raise exception 'A note can''t be empty'; end if;

  insert into candidate_notes (candidate_id, author_id, body)
    values (p_candidate_id, auth.uid(), trim(p_body))
    returning * into v_note;
  return v_note;
end; $$;

revoke all on function public.add_candidate_note(uuid, text) from public, anon;
grant execute on function public.add_candidate_note(uuid, text) to authenticated;

-- Notes with author names (same profile-visibility reason as list_jobs).
create or replace function public.list_candidate_notes(p_candidate_id uuid)
returns table (id uuid, author_id uuid, author_name text, body text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select n.id, n.author_id, p.full_name, n.body, n.created_at
  from candidate_notes n
  left join profiles p on p.id = n.author_id
  where n.candidate_id = p_candidate_id and public.can_access_candidate(p_candidate_id)
  order by n.created_at desc;
$$;

revoke all on function public.list_candidate_notes(uuid) from public, anon;
grant execute on function public.list_candidate_notes(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- CV storage: private bucket, objects at "<candidate id>/<file name>".
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'candidate-cvs',
  'candidate-cvs',
  false,
  10485760, -- 10 MB
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

create policy "read accessible candidate cvs" on storage.objects
  for select to authenticated
  using (bucket_id = 'candidate-cvs' and public.can_access_candidate_folder((storage.foldername(name))[1]));
create policy "hr admin upload candidate cvs" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'candidate-cvs' and public.current_role_is(array['hr_admin']));
create policy "hr admin replace candidate cvs" on storage.objects
  for update to authenticated
  using (bucket_id = 'candidate-cvs' and public.current_role_is(array['hr_admin']))
  with check (bucket_id = 'candidate-cvs' and public.current_role_is(array['hr_admin']));
create policy "hr admin delete candidate cvs" on storage.objects
  for delete to authenticated
  using (bucket_id = 'candidate-cvs' and public.current_role_is(array['hr_admin']));
