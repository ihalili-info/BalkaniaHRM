-- Teams can have several leads and can sit under a parent team.
--
-- Real structure this supports: Operations (manager only) sits over Warehouse
-- and Transport; Warehouse has its own manager and two team leads.
--
--   * team_leads replaces the single teams.team_lead_id. Every lead of a team
--     has the same authority over its members (is_team_lead_of).
--   * teams.parent_team_id: a team's manager also supervises every team below
--     it, at any depth (is_manager_of walks up the chain). Leads stay scoped
--     to their own team.
--   * The profiles read policy and the long-break alert recipients used
--     teams.team_lead_id directly; both now go through the new model.
--
-- teams.team_lead_id is left in place (unused from here on) so the frontend
-- that's live while this is applied keeps loading; drop it in a later
-- migration once the new frontend is deployed.

-- ---------------------------------------------------------------------------
-- Multiple leads
-- ---------------------------------------------------------------------------

create table public.team_leads (
  team_id uuid not null references public.teams(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (team_id, employee_id)
);

create index team_leads_employee_idx on public.team_leads (employee_id);

insert into public.team_leads (team_id, employee_id)
  select id, team_lead_id from public.teams where team_lead_id is not null;

alter table public.team_leads enable row level security;

create policy "authenticated read team leads" on public.team_leads
  for select to authenticated using (true);
create policy "hr admin add team leads" on public.team_leads
  for insert to authenticated with check (public.current_role_is(array['hr_admin']));
create policy "hr admin remove team leads" on public.team_leads
  for delete to authenticated using (public.current_role_is(array['hr_admin']));

-- ---------------------------------------------------------------------------
-- Parent teams
-- ---------------------------------------------------------------------------

alter table public.teams
  add column parent_team_id uuid references public.teams(id) on delete set null,
  add constraint teams_not_own_parent check (parent_team_id is null or parent_team_id <> id);

-- Reject A -> B -> A loops, which would make "everyone under this team" endless.
create or replace function public.guard_team_parent_cycle()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.parent_team_id is null then return new; end if;
  if exists (
    with recursive up(id) as (
      select new.parent_team_id
      union
      select t.parent_team_id from teams t join up on t.id = up.id where t.parent_team_id is not null
    )
    select 1 from up where id = new.id
  ) then
    raise exception 'A team can''t sit under one of its own sub-teams.';
  end if;
  return new;
end; $$;

revoke all on function public.guard_team_parent_cycle() from public, anon, authenticated;

create trigger teams_guard_parent_cycle
  before insert or update of parent_team_id on public.teams
  for each row execute function public.guard_team_parent_cycle();

-- ---------------------------------------------------------------------------
-- Supervision
-- ---------------------------------------------------------------------------

-- A lead supervises the members of every team they lead (not sub-teams) --
-- but not a co-lead of that team or a manager/HR who happens to sit in it.
-- Those are supervised from above, so leads can't approve each other's or
-- their manager's leave.
create or replace function public.is_team_lead_of(p_employee_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_employee_id <> auth.uid() and exists (
    select 1
    from public.team_leads tl
    join public.profiles p on p.team_id = tl.team_id
    where tl.employee_id = auth.uid() and p.id = p_employee_id
      and p.role not in ('manager', 'hr_admin')
      and not exists (select 1 from public.team_leads co where co.team_id = tl.team_id and co.employee_id = p.id)
  );
$$;

-- A manager supervises everyone in their team or any team below it, plus the
-- leads of those teams (a lead's own profile may sit in another team).
create or replace function public.is_manager_of(p_employee_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_employee_id <> auth.uid() and exists (
    with recursive chain(id) as (
      select b.team_id from (
        select p.team_id from public.profiles p where p.id = p_employee_id and p.team_id is not null
        union
        select tl.team_id from public.team_leads tl where tl.employee_id = p_employee_id
      ) b
      union
      select t.parent_team_id from public.teams t join chain c on t.id = c.id where t.parent_team_id is not null
    )
    select 1 from public.teams t join chain c on c.id = t.id where t.manager_id = auth.uid()
  );
$$;

drop policy "supervisors read their reports profiles" on public.profiles;
create policy "supervisors read their reports profiles" on public.profiles
  for select to authenticated using (public.can_supervise(id));

-- Long-break alerts go to every lead of the person's team and its direct
-- manager (plus HR), as before -- not to managers further up.
create or replace function public.pending_break_alerts(p_threshold_minutes integer default 17)
returns table(session_id uuid, employee_name text, employee_code text, break_started_at timestamptz, minutes_elapsed integer, recipient_email text, recipient_name text)
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
    select o.session_id, tl.employee_id as recipient_id
      from overrun o join team_leads tl on tl.team_id = o.team_id
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
