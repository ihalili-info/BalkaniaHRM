-- Roster x leave x holidays, supervisor-recorded leave, and manager-owned
-- shift templates.
--
--   1. "Other" leave no longer requires a balance row. Unpaid already skipped
--      the balance check; other (compassionate, jury duty, ...) used to fail
--      with "No other leave balance is set up" unless HR had created one. If HR
--      HAS set an "other" entitlement, it's still enforced.
--   2. roster_days_off: an explicit "off" marker for one person on one day.
--      Removing a shift used to leave an empty day that the next "Fill week"
--      silently refilled; a day-off row makes it stick.
--   3. record_leave_for_employee(): team leads, managers and HR can book leave
--      (typically unpaid) for someone they supervise straight from the roster.
--      It's created already approved and clears that person's shifts/days off
--      in the range. leave_requests.recorded_by remembers who did it so the
--      same person can undo it via cancel_leave_request.
--   4. fill_roster() skips bank holidays and days off, in addition to approved
--      leave which it already skipped.
--   5. Managers can create, edit and delete shift templates. Only HR can make
--      a template the company default, since that affects everyone.

-- ---------------------------------------------------------------------------
-- 1. Leave validation: "other" without a balance row is unlimited
-- ---------------------------------------------------------------------------

alter table public.leave_requests
  add constraint leave_requests_leave_type_check check (leave_type in ('annual', 'medical', 'unpaid', 'other'));

create or replace function public.validate_leave_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_requested_days numeric;
  v_earned numeric;
  v_used numeric;
  v_holiday record;
begin
  if not exists (select 1 from profiles where id = new.employee_id and active) then
    raise exception 'This employee account is deactivated.';
  end if;

  select holiday_date, name into v_holiday from holidays
    where holiday_date between new.starts_on and new.ends_on
    order by holiday_date limit 1;
  if v_holiday.holiday_date is not null then
    raise exception 'This date range includes % (%), which is already a bank holiday.', v_holiday.name, to_char(v_holiday.holiday_date, 'DD Mon YYYY');
  end if;

  if new.leave_type = 'unpaid' then
    return new;
  end if;

  v_requested_days := (new.ends_on - new.starts_on + 1);

  select
    round(lb.entitlement * least(12, greatest(0,
      (extract(year from current_date) - extract(year from public.leave_accrual_anchor(lb.leave_year_start, p.start_date))) * 12
      + (extract(month from current_date) - extract(month from public.leave_accrual_anchor(lb.leave_year_start, p.start_date))) + 1
    )) / 12.0, 2) + lb.adjustment,
    lb.used
  into v_earned, v_used
  from leave_balances lb
  join profiles p on p.id = lb.employee_id
  where lb.employee_id = new.employee_id and lb.leave_type = new.leave_type
    and lb.leave_year_start = public.current_leave_year_start();

  if v_earned is null then
    if new.leave_type = 'other' then
      return new;
    end if;
    raise exception 'No % leave balance is set up yet. Ask HR to set the entitlement before booking this leave type.', new.leave_type;
  end if;

  if v_requested_days > (v_earned - coalesce(v_used, 0)) then
    raise exception 'This request is % days, but only % days of % leave are available to book.', v_requested_days, (v_earned - coalesce(v_used, 0)), new.leave_type;
  end if;

  return new;
end; $$;

-- ---------------------------------------------------------------------------
-- 2. Days off
-- ---------------------------------------------------------------------------

create table public.roster_days_off (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  off_date date not null,
  note text,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (employee_id, off_date)
);

create index roster_days_off_date_idx on public.roster_days_off (off_date);

alter table public.roster_days_off enable row level security;

create policy "read roster days off" on public.roster_days_off
  for select to authenticated using (
    public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id) or employee_id = auth.uid()
  );
create policy "manage roster days off" on public.roster_days_off
  for insert to authenticated
  with check (public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id));
create policy "delete roster days off" on public.roster_days_off
  for delete to authenticated
  using (public.current_role_is(array['hr_admin']) or public.can_supervise(employee_id));

-- ---------------------------------------------------------------------------
-- 3. Supervisor-recorded leave
-- ---------------------------------------------------------------------------

alter table public.leave_requests
  add column recorded_by uuid references public.profiles(id) on delete set null;

create or replace function public.record_leave_for_employee(
  p_employee_id uuid,
  p_leave_type text,
  p_starts_on date,
  p_ends_on date,
  p_note text
) returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not (public.current_role_is(array['hr_admin']) or public.can_supervise(p_employee_id)) then
    raise exception 'Not authorized to record leave for this employee';
  end if;
  if p_leave_type not in ('annual', 'medical', 'unpaid', 'other') then raise exception 'Invalid leave type'; end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then raise exception 'Invalid date range'; end if;
  if exists (
    select 1 from leave_requests
    where employee_id = p_employee_id and status in ('pending', 'approved')
      and starts_on <= p_ends_on and ends_on >= p_starts_on
  ) then
    raise exception 'This person already has leave booked or requested on these dates.';
  end if;

  -- Inserted as pending so validate_leave_request (balance, holidays,
  -- deactivated) runs exactly as for an employee's own request.
  insert into leave_requests (employee_id, leave_type, starts_on, ends_on, note, status, recorded_by)
    values (p_employee_id, p_leave_type, p_starts_on, p_ends_on, nullif(trim(coalesce(p_note, '')), ''), 'pending', auth.uid())
    returning * into v_request;

  update leave_requests set status = 'approved' where id = v_request.id returning * into v_request;
  update leave_balances set used = used + (p_ends_on - p_starts_on + 1)
    where employee_id = p_employee_id and leave_type = p_leave_type
      and leave_year_start = public.leave_year_start_for(p_starts_on);

  -- They're not working those days any more.
  delete from roster_shifts where employee_id = p_employee_id and shift_date between p_starts_on and p_ends_on;
  delete from roster_days_off where employee_id = p_employee_id and off_date between p_starts_on and p_ends_on;

  return v_request;
end; $$;

revoke all on function public.record_leave_for_employee(uuid, text, date, date, text) from public, anon;
grant execute on function public.record_leave_for_employee(uuid, text, date, date, text) to authenticated;

-- Cancelling used to be HR-only. Now also the employee's manager, and whoever
-- recorded the leave (while they still supervise the person), so a team lead
-- can undo their own roster entry.
create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_previous public.leave_request_status;
  v_employee uuid;
  v_recorded_by uuid;
  v_days int;
  v_who text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select employee_id, status, recorded_by into v_employee, v_previous, v_recorded_by
    from leave_requests where id = p_request_id for update;
  if v_employee is null then raise exception 'Leave request not found'; end if;

  if public.current_role_is(array['hr_admin']) then
    v_who := 'HR';
  elsif public.is_manager_of(v_employee) or (v_recorded_by = auth.uid() and public.can_supervise(v_employee)) then
    select full_name into v_who from profiles where id = auth.uid();
  else
    raise exception 'Only HR, the manager, or whoever recorded this leave can cancel it';
  end if;

  if v_previous = 'cancelled' then
    raise exception 'This request is already cancelled.';
  end if;

  update leave_requests
     set status = 'cancelled',
         note = case
                  when nullif(trim(coalesce(p_reason, '')), '') is null then note
                  when note is null or note = '' then 'Cancelled by ' || v_who || ': ' || trim(p_reason)
                  else note || E'\n\nCancelled by ' || v_who || ': ' || trim(p_reason)
                end
   where id = p_request_id
   returning * into v_request;

  -- Only an approved request ever consumed days, so only that one refunds.
  if v_previous = 'approved' then
    v_days := (v_request.ends_on - v_request.starts_on + 1);
    update leave_balances
       set used = greatest(0, used - v_days)
     where employee_id = v_request.employee_id
       and leave_type = v_request.leave_type
       and leave_year_start = public.leave_year_start_for(v_request.starts_on);
  end if;

  return v_request;
end; $$;

-- ---------------------------------------------------------------------------
-- 4. fill_roster: skip bank holidays and days off too
-- ---------------------------------------------------------------------------

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
      continue when exists (select 1 from roster_days_off where employee_id = v_person.id and off_date = v_day);
      continue when exists (select 1 from holidays where holiday_date = v_day);
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

-- ---------------------------------------------------------------------------
-- 5. Managers manage shift templates
-- ---------------------------------------------------------------------------

create policy "managers insert work schedules" on public.work_schedules
  for insert to authenticated with check (public.current_role_is(array['manager']));
create policy "managers update work schedules" on public.work_schedules
  for update to authenticated using (public.current_role_is(array['manager'])) with check (public.current_role_is(array['manager']));
create policy "managers delete work schedules" on public.work_schedules
  for delete to authenticated using (public.current_role_is(array['manager']));

-- The company default applies to everyone without a team/own template, so
-- only HR may set, clear, or delete it.
create or replace function public.guard_default_work_schedule()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_is(array['hr_admin']) or auth.uid() is null then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.is_default then raise exception 'Only HR can delete the company default template.'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' and new.is_default then
    raise exception 'Only HR can set the company default template.';
  end if;
  if tg_op = 'UPDATE' and new.is_default is distinct from old.is_default then
    raise exception 'Only HR can change the company default template.';
  end if;
  return new;
end; $$;

revoke all on function public.guard_default_work_schedule() from public, anon, authenticated;

create trigger work_schedules_guard_default
  before insert or update or delete on public.work_schedules
  for each row execute function public.guard_default_work_schedule();
