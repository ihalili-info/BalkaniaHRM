-- Shift rosters: richer shift templates, default templates per employee/team,
-- a dated roster (draft -> published), repeating rotations that fill it, and
-- shift swaps between colleagues with manager approval.
--
-- Who can do what:
--   * HR admins: everything.
--   * Managers / team leads: build and publish the roster for people they
--     supervise (can_supervise), approve swaps between their people, and read
--     templates and rotations.
--   * Employees: see their own PUBLISHED shifts, request swaps with colleagues
--     on their team, and accept/decline swaps offered to them.
--
-- Shift times are local (Europe/Dublin) wall-clock times on shift_date. A shift
-- whose end time is not after its start time finishes the next day (nights).
-- A day with no roster row is a day off.

-- ---------------------------------------------------------------------------
-- Templates (work_schedules) and defaults
-- ---------------------------------------------------------------------------

alter table public.work_schedules
  add column color text not null default '#232b6a' check (color ~ '^#[0-9a-fA-F]{6}$'),
  add column unpaid_break_minutes int not null default 0 check (unpaid_break_minutes between 0 and 480);

-- Teams can have their own default template; the company default
-- (work_schedules.is_default) applies when neither employee nor team has one.
alter table public.teams add column default_schedule_id uuid references public.work_schedules(id) on delete set null;

-- Deleting a template used to fail if anyone was assigned to it. Cascade the
-- per-employee assignment instead; they fall back to the team/company default.
alter table public.employee_schedule_assignments drop constraint employee_schedule_assignments_schedule_id_fkey;
alter table public.employee_schedule_assignments
  add constraint employee_schedule_assignments_schedule_id_fkey
  foreign key (schedule_id) references public.work_schedules(id) on delete cascade;

create policy "hr admin manage schedule assignments" on public.employee_schedule_assignments
  for all to authenticated
  using (public.current_role_is(array['hr_admin']))
  with check (public.current_role_is(array['hr_admin']));
create policy "supervisors read schedule assignments" on public.employee_schedule_assignments
  for select to authenticated using (public.can_supervise(employee_id));

-- ---------------------------------------------------------------------------
-- Roster
-- ---------------------------------------------------------------------------

create table public.roster_shifts (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  shift_date date not null,
  schedule_id uuid references public.work_schedules(id) on delete set null,
  starts_at time not null,
  ends_at time not null,
  unpaid_break_minutes int not null default 0 check (unpaid_break_minutes between 0 and 480),
  note text,
  status text not null default 'draft' check (status in ('draft', 'published')),
  source text not null default 'manual' check (source in ('manual', 'default', 'rotation', 'swap')),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (starts_at <> ends_at),
  -- Deferrable so an approved swap of two shifts on the same day can exchange
  -- owners inside one transaction.
  constraint roster_shifts_employee_day_key unique (employee_id, shift_date) deferrable initially immediate
);

create index roster_shifts_date_idx on public.roster_shifts (shift_date);

alter table public.roster_shifts enable row level security;

create policy "read roster shifts" on public.roster_shifts
  for select to authenticated using (
    public.current_role_is(array['hr_admin'])
    or public.can_supervise(employee_id)
    or (employee_id = auth.uid() and status = 'published')
  );
create policy "manage roster shifts" on public.roster_shifts
  for insert to authenticated
  with check (public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id));
create policy "update roster shifts" on public.roster_shifts
  for update to authenticated
  using (public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id))
  with check (public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id));
create policy "delete roster shifts" on public.roster_shifts
  for delete to authenticated
  using (public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id));

-- ---------------------------------------------------------------------------
-- Rotations
-- ---------------------------------------------------------------------------

create table public.shift_rotations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  cycle_days int not null check (cycle_days between 1 and 56),
  created_at timestamptz not null default now()
);

-- One row per working day of the cycle; a day index with no row is a day off.
create table public.shift_rotation_days (
  rotation_id uuid not null references public.shift_rotations(id) on delete cascade,
  day_index int not null check (day_index >= 0),
  schedule_id uuid not null references public.work_schedules(id) on delete cascade,
  primary key (rotation_id, day_index)
);

-- Day 0 of the cycle falls on starts_on. If assignments overlap, the most
-- recently started one wins when filling the roster.
create table public.rotation_assignments (
  id uuid primary key default gen_random_uuid(),
  rotation_id uuid not null references public.shift_rotations(id) on delete cascade,
  employee_id uuid not null references public.profiles(id) on delete cascade,
  starts_on date not null,
  ends_on date,
  created_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);

create index rotation_assignments_employee_idx on public.rotation_assignments (employee_id);

alter table public.shift_rotations enable row level security;
alter table public.shift_rotation_days enable row level security;
alter table public.rotation_assignments enable row level security;

create policy "admin roles read rotations" on public.shift_rotations
  for select to authenticated using (public.current_role_is(array['hr_admin', 'manager', 'team_lead']));
create policy "hr admin manage rotations" on public.shift_rotations
  for all to authenticated
  using (public.current_role_is(array['hr_admin'])) with check (public.current_role_is(array['hr_admin']));

create policy "admin roles read rotation days" on public.shift_rotation_days
  for select to authenticated using (public.current_role_is(array['hr_admin', 'manager', 'team_lead']));
create policy "hr admin manage rotation days" on public.shift_rotation_days
  for all to authenticated
  using (public.current_role_is(array['hr_admin'])) with check (public.current_role_is(array['hr_admin']));

create policy "read rotation assignments" on public.rotation_assignments
  for select to authenticated using (
    public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id) or employee_id = auth.uid()
  );
create policy "hr admin manage rotation assignments" on public.rotation_assignments
  for all to authenticated
  using (public.current_role_is(array['hr_admin'])) with check (public.current_role_is(array['hr_admin']));

-- ---------------------------------------------------------------------------
-- Filling the roster
-- ---------------------------------------------------------------------------

-- The template that applies to an employee on a date when no rotation does:
-- their own assignment, else their team's default, else the company default.
create or replace function public.default_schedule_for(p_employee_id uuid, p_date date)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select a.schedule_id from employee_schedule_assignments a
      where a.employee_id = p_employee_id and a.effective_from <= p_date
        and (a.effective_to is null or a.effective_to >= p_date)),
    (select t.default_schedule_id from profiles p join teams t on t.id = p.team_id where p.id = p_employee_id),
    (select id from work_schedules where is_default limit 1)
  );
$$;

revoke all on function public.default_schedule_for(uuid, date) from public, anon, authenticated;

-- Creates DRAFT shifts for every empty day in the range, for the people the
-- caller manages (or p_employee_ids, if given). Rotations take priority over
-- default templates; days with approved leave and days the template/rotation
-- marks off are skipped. Existing shifts are never overwritten. Returns the
-- number of shifts created.
create or replace function public.fill_roster(p_from date, p_to date, p_employee_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare
  v_is_hr boolean := public.current_role_is(array['hr_admin']);
  v_created int := 0;
  v_person record;
  v_day date;
  v_rotation record;
  v_schedule_id uuid;
  v_schedule public.work_schedules;
  v_source text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not (v_is_hr or public.current_role_is(array['manager', 'team_lead'])) then
    raise exception 'Not authorized to build the roster';
  end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Invalid date range'; end if;
  if p_to - p_from > 62 then raise exception 'Fill at most 9 weeks at a time'; end if;

  for v_person in
    select p.id from profiles p
    where p.active and p.role <> 'kiosk'
      and (p_employee_ids is null or p.id = any(p_employee_ids))
      and (v_is_hr or public.can_supervise(p.id))
  loop
    for v_day in select generate_series(p_from, p_to, interval '1 day')::date loop
      continue when exists (select 1 from roster_shifts where employee_id = v_person.id and shift_date = v_day);
      continue when exists (
        select 1 from leave_requests
        where employee_id = v_person.id and status = 'approved' and v_day between starts_on and ends_on
      );

      v_schedule_id := null;
      v_source := null;

      select ra.starts_on, r.cycle_days, r.id as rotation_id into v_rotation
      from rotation_assignments ra join shift_rotations r on r.id = ra.rotation_id
      where ra.employee_id = v_person.id and ra.starts_on <= v_day and (ra.ends_on is null or ra.ends_on >= v_day)
      order by ra.starts_on desc
      limit 1;

      if found then
        select schedule_id into v_schedule_id from shift_rotation_days
          where rotation_id = v_rotation.rotation_id and day_index = (v_day - v_rotation.starts_on) % v_rotation.cycle_days;
        continue when v_schedule_id is null; -- rotation day off
        v_source := 'rotation';
      else
        v_schedule_id := public.default_schedule_for(v_person.id, v_day);
        continue when v_schedule_id is null;
        select * into v_schedule from work_schedules where id = v_schedule_id;
        continue when not (extract(isodow from v_day)::smallint = any(v_schedule.working_days));
        v_source := 'default';
      end if;

      select * into v_schedule from work_schedules where id = v_schedule_id;
      insert into roster_shifts (employee_id, shift_date, schedule_id, starts_at, ends_at, unpaid_break_minutes, status, source)
        values (v_person.id, v_day, v_schedule.id, v_schedule.starts_at, v_schedule.ends_at, v_schedule.unpaid_break_minutes, 'draft', v_source);
      v_created := v_created + 1;
    end loop;
  end loop;

  return v_created;
end; $$;

revoke all on function public.fill_roster(date, date, uuid[]) from public, anon;
grant execute on function public.fill_roster(date, date, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Shift swaps
-- ---------------------------------------------------------------------------

-- target_shift_id null = "cover my shift": the colleague takes it and gives
-- nothing back.
create table public.shift_swap_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  requester_shift_id uuid not null references public.roster_shifts(id) on delete cascade,
  target_employee_id uuid not null references public.profiles(id) on delete cascade,
  target_shift_id uuid references public.roster_shifts(id) on delete cascade,
  message text,
  status text not null default 'pending_colleague'
    check (status in ('pending_colleague', 'pending_approval', 'approved', 'rejected', 'declined', 'cancelled')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  check (requester_id <> target_employee_id)
);

alter table public.shift_swap_requests enable row level security;
-- Reads and writes go through the RPCs below (they join names and shift
-- details the caller couldn't otherwise read).

-- Validates that a shift can take part in a swap right now.
create or replace function public.assert_swappable_shift(p_shift_id uuid, p_owner uuid)
returns public.roster_shifts language plpgsql stable security definer set search_path = public as $$
declare
  v_shift public.roster_shifts;
begin
  select * into v_shift from roster_shifts where id = p_shift_id;
  if v_shift is null or v_shift.employee_id <> p_owner then raise exception 'That shift is no longer available to swap.'; end if;
  if v_shift.status <> 'published' then raise exception 'Only published shifts can be swapped.'; end if;
  if v_shift.shift_date <= current_date then raise exception 'Only future shifts can be swapped.'; end if;
  return v_shift;
end; $$;

revoke all on function public.assert_swappable_shift(uuid, uuid) from public, anon, authenticated;

-- Colleagues the caller could swap with for one of their shifts: teammates'
-- published future shifts in the next 4 weeks (shift_id set), plus teammates
-- who are free on that day (shift_id null, i.e. "cover my shift").
create or replace function public.list_swap_options(p_shift_id uuid)
returns table (employee_id uuid, employee_name text, shift_id uuid, shift_date date, starts_at time, ends_at time)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_shift public.roster_shifts;
  v_team uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  v_shift := public.assert_swappable_shift(p_shift_id, auth.uid());
  select team_id into v_team from profiles where id = auth.uid();
  if v_team is null then return; end if;

  return query
    select p.id, p.full_name, s.id, s.shift_date, s.starts_at, s.ends_at
    from roster_shifts s join profiles p on p.id = s.employee_id
    where p.team_id = v_team and p.active and p.id <> auth.uid()
      and s.status = 'published' and s.shift_date > current_date and s.shift_date <= current_date + 28
    union all
    select p.id, p.full_name, null::uuid, v_shift.shift_date, null::time, null::time
    from profiles p
    where p.team_id = v_team and p.active and p.id <> auth.uid() and p.role <> 'kiosk'
      and not exists (select 1 from roster_shifts s where s.employee_id = p.id and s.shift_date = v_shift.shift_date)
    order by 4, 2;
end; $$;

revoke all on function public.list_swap_options(uuid) from public, anon;
grant execute on function public.list_swap_options(uuid) to authenticated;

create or replace function public.request_shift_swap(p_shift_id uuid, p_target_employee_id uuid, p_target_shift_id uuid, p_message text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_mine public.roster_shifts;
  v_theirs public.roster_shifts;
  v_my_team uuid;
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  v_mine := public.assert_swappable_shift(p_shift_id, auth.uid());

  select team_id into v_my_team from profiles where id = auth.uid();
  if v_my_team is null or not exists (
    select 1 from profiles where id = p_target_employee_id and team_id = v_my_team and active and id <> auth.uid()
  ) then
    raise exception 'You can only swap with an active colleague on your team.';
  end if;

  if p_target_shift_id is not null then
    v_theirs := public.assert_swappable_shift(p_target_shift_id, p_target_employee_id);
  elsif exists (select 1 from roster_shifts where employee_id = p_target_employee_id and shift_date = v_mine.shift_date) then
    raise exception 'That colleague already has a shift that day.';
  end if;

  if exists (
    select 1 from shift_swap_requests
    where status in ('pending_colleague', 'pending_approval')
      and (requester_shift_id in (p_shift_id, p_target_shift_id) or target_shift_id in (p_shift_id, p_target_shift_id))
  ) then
    raise exception 'One of these shifts already has a swap request in progress.';
  end if;

  insert into shift_swap_requests (requester_id, requester_shift_id, target_employee_id, target_shift_id, message)
    values (auth.uid(), p_shift_id, p_target_employee_id, p_target_shift_id, nullif(trim(coalesce(p_message, '')), ''))
    returning id into v_id;
  return v_id;
end; $$;

revoke all on function public.request_shift_swap(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.request_shift_swap(uuid, uuid, uuid, text) to authenticated;

create or replace function public.respond_shift_swap(p_request_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_request public.shift_swap_requests;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_request from shift_swap_requests where id = p_request_id for update;
  if v_request is null or v_request.target_employee_id <> auth.uid() then raise exception 'Swap request not found.'; end if;
  if v_request.status <> 'pending_colleague' then raise exception 'This swap request has already been answered.'; end if;

  update shift_swap_requests
    set status = case when p_accept then 'pending_approval' else 'declined' end
    where id = p_request_id;
end; $$;

revoke all on function public.respond_shift_swap(uuid, boolean) from public, anon;
grant execute on function public.respond_shift_swap(uuid, boolean) to authenticated;

create or replace function public.cancel_shift_swap(p_request_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_request public.shift_swap_requests;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_request from shift_swap_requests where id = p_request_id for update;
  if v_request is null or v_request.requester_id <> auth.uid() then raise exception 'Swap request not found.'; end if;
  if v_request.status not in ('pending_colleague', 'pending_approval') then raise exception 'This swap request is already closed.'; end if;
  update shift_swap_requests set status = 'cancelled' where id = p_request_id;
end; $$;

revoke all on function public.cancel_shift_swap(uuid) from public, anon;
grant execute on function public.cancel_shift_swap(uuid) to authenticated;

-- HR, or a supervisor of BOTH people, approves or rejects an accepted swap.
-- Approval re-checks everything (shifts may have changed since the request)
-- and then exchanges the shifts' owners.
create or replace function public.decide_shift_swap(p_request_id uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_request public.shift_swap_requests;
  v_mine public.roster_shifts;
  v_theirs public.roster_shifts;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_request from shift_swap_requests where id = p_request_id for update;
  if v_request is null then raise exception 'Swap request not found.'; end if;
  if not (
    public.current_role_is(array['hr_admin'])
    or (public.can_supervise(v_request.requester_id) and public.can_supervise(v_request.target_employee_id))
  ) then
    raise exception 'Not authorized to decide this swap.';
  end if;
  if v_request.status <> 'pending_approval' then raise exception 'Only swaps the colleague has accepted can be decided.'; end if;

  if p_approve then
    v_mine := public.assert_swappable_shift(v_request.requester_shift_id, v_request.requester_id);
    if v_request.target_shift_id is not null then
      v_theirs := public.assert_swappable_shift(v_request.target_shift_id, v_request.target_employee_id);
    end if;

    -- Neither person may end up with two shifts on one day.
    if exists (
      select 1 from roster_shifts
      where employee_id = v_request.target_employee_id and shift_date = v_mine.shift_date
        and id is distinct from v_request.target_shift_id
    ) then
      raise exception '% already has another shift on %.',
        (select full_name from profiles where id = v_request.target_employee_id), to_char(v_mine.shift_date, 'DD Mon');
    end if;
    if v_theirs.id is not null and exists (
      select 1 from roster_shifts
      where employee_id = v_request.requester_id and shift_date = v_theirs.shift_date and id <> v_mine.id
    ) then
      raise exception '% already has another shift on %.',
        (select full_name from profiles where id = v_request.requester_id), to_char(v_theirs.shift_date, 'DD Mon');
    end if;

    set constraints roster_shifts_employee_day_key deferred;
    update roster_shifts set employee_id = v_request.target_employee_id, source = 'swap', updated_at = now() where id = v_mine.id;
    if v_theirs.id is not null then
      update roster_shifts set employee_id = v_request.requester_id, source = 'swap', updated_at = now() where id = v_theirs.id;
    end if;
  end if;

  update shift_swap_requests
    set status = case when p_approve then 'approved' else 'rejected' end,
        decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '')
    where id = p_request_id;
end; $$;

revoke all on function public.decide_shift_swap(uuid, boolean, text) from public, anon;
grant execute on function public.decide_shift_swap(uuid, boolean, text) to authenticated;

-- Swap requests visible to the caller, with names and shift details:
-- their own (sent or received), and -- for HR / supervisors -- their people's.
create or replace function public.list_shift_swaps()
returns table (
  id uuid,
  status text,
  message text,
  decision_note text,
  created_at timestamptz,
  decided_at timestamptz,
  requester_id uuid,
  requester_name text,
  requester_shift_date date,
  requester_starts_at time,
  requester_ends_at time,
  target_employee_id uuid,
  target_name text,
  target_shift_date date,
  target_starts_at time,
  target_ends_at time,
  decided_by_name text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.status, r.message, r.decision_note, r.created_at, r.decided_at,
         r.requester_id, rp.full_name, ms.shift_date, ms.starts_at, ms.ends_at,
         r.target_employee_id, tp.full_name, ts.shift_date, ts.starts_at, ts.ends_at,
         dp.full_name
  from shift_swap_requests r
  join profiles rp on rp.id = r.requester_id
  join profiles tp on tp.id = r.target_employee_id
  left join roster_shifts ms on ms.id = r.requester_shift_id
  left join roster_shifts ts on ts.id = r.target_shift_id
  left join profiles dp on dp.id = r.decided_by
  where auth.uid() is not null and (
    r.requester_id = auth.uid()
    or r.target_employee_id = auth.uid()
    or public.current_role_is(array['hr_admin'])
    or public.can_supervise(r.requester_id)
    or public.can_supervise(r.target_employee_id)
  )
  order by r.created_at desc
  limit 200;
$$;

revoke all on function public.list_shift_swaps() from public, anon;
grant execute on function public.list_shift_swaps() to authenticated;
