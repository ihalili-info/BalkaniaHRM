-- Record attendance for a chosen date and time, not just "now".
--
-- The admin "Record attendance" form went through record_attendance_event,
-- which always stamps now() and writes to today's session. So a missed
-- clock-in from this morning, or a forgotten clock-out yesterday, couldn't be
-- entered. This is a separate RPC rather than extra parameters on
-- record_attendance_event: adding params there would create an overload (see
-- 20260912_fix_attendance_core_overload.sql), and the self-service / kiosk
-- paths have no business backdating anything.
--
-- Who may call it:
--   * HR: anyone;
--   * managers: people in a team they manage or a team below it
--     (is_manager_of -- never themselves). Team leads are not included,
--     matching set_phone_clock_out (20261024).
--
-- Rules, on top of the usual state machine (_valid_next_event_types):
--   * not in the future;
--   * the time has to be roughly on the chosen work day (a loose window that
--     allows for the UTC offset and shifts that end after midnight);
--   * events stay in order: the new time can't be earlier than the latest
--     time already on that day's session.

create or replace function public.record_attendance_event_at(
  p_employee_id uuid,
  p_event_type public.attendance_event_type,
  p_work_date date,
  p_occurred_at timestamptz,
  p_idempotency_key uuid
) returns public.attendance_sessions
language plpgsql security definer set search_path = public as $$
declare
  v_session public.attendance_sessions;
  v_latest timestamptz;
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception 'You must be signed in to record attendance.';
  end if;

  if not (public.current_role_is(array['hr_admin'])
          or (public.current_role_is(array['manager']) and public.is_manager_of(p_employee_id))) then
    raise exception 'Only HR or the employee''s manager can record attendance for them.';
  end if;

  if p_employee_id is null or not exists (select 1 from profiles where id = p_employee_id) then
    raise exception 'Employee not found.';
  end if;

  if p_work_date is null or p_occurred_at is null then
    raise exception 'Choose a date and time.';
  end if;

  if p_occurred_at > now() + interval '1 minute' then
    raise exception 'You can''t record attendance in the future.';
  end if;

  if p_occurred_at < p_work_date::timestamp at time zone 'UTC' - interval '1 day'
     or p_occurred_at >= (p_work_date + 2)::timestamp at time zone 'UTC' then
    raise exception 'The time must fall on the chosen work day.';
  end if;

  -- A retried submit returns the session as it stands instead of failing.
  if exists (select 1 from attendance_events where idempotency_key = p_idempotency_key) then
    select * into v_session from attendance_sessions
      where employee_id = p_employee_id and work_date = p_work_date;
    return v_session;
  end if;

  insert into attendance_sessions(employee_id, work_date) values (p_employee_id, p_work_date)
    on conflict (employee_id, work_date) do nothing;
  select * into v_session from attendance_sessions
    where employee_id = p_employee_id and work_date = p_work_date for update;

  if not (p_event_type = any(public._valid_next_event_types(v_session.state))) then
    raise exception 'Invalid attendance transition: that action doesn''t follow what''s already recorded for this day.';
  end if;

  -- greatest() ignores nulls; null only when nothing is recorded yet.
  v_latest := greatest(v_session.clocked_in_at, v_session.first_break_started_at, v_session.first_break_ended_at,
                       v_session.lunch_started_at, v_session.lunch_ended_at, v_session.clocked_out_at);
  if v_latest is not null and p_occurred_at < v_latest then
    raise exception 'The time must be after the previous event recorded for this day.';
  end if;

  update attendance_sessions set
    state = case p_event_type
      when 'clock_in' then 'working' when 'clock_out' then 'complete'
      when 'break_start' then 'on_break' when 'break_end' then 'working'
      when 'lunch_start' then 'on_lunch' else 'working' end,
    clocked_in_at = case when p_event_type = 'clock_in' then p_occurred_at else clocked_in_at end,
    clocked_out_at = case when p_event_type = 'clock_out' then p_occurred_at else clocked_out_at end,
    first_break_started_at = case when p_event_type = 'break_start' then p_occurred_at else first_break_started_at end,
    first_break_ended_at = case when p_event_type = 'break_end' then p_occurred_at else first_break_ended_at end,
    lunch_started_at = case when p_event_type = 'lunch_start' then p_occurred_at else lunch_started_at end,
    lunch_ended_at = case when p_event_type = 'lunch_end' then p_occurred_at else lunch_ended_at end
  where id = v_session.id returning * into v_session;

  insert into attendance_events(employee_id, event_type, occurred_at, source, idempotency_key)
    values (p_employee_id, p_event_type, p_occurred_at, 'admin', p_idempotency_key);

  return v_session;
end; $$;

revoke all on function public.record_attendance_event_at(uuid, public.attendance_event_type, date, timestamptz, uuid)
  from public, anon;
grant execute on function public.record_attendance_event_at(uuid, public.attendance_event_type, date, timestamptz, uuid)
  to authenticated;
