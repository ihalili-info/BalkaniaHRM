-- Audit and retention for Irish record-keeping rules.
--
--   * Organisation of Working Time Act 1997, s.25 (+ S.I. 473/2001): working
--     time records (start/finish, hours, breaks, leave) kept for 3 years.
--   * Sick Leave Act 2022: statutory sick leave records kept for 4 years.
--
-- 1. WHO ENTERED IT. attendance_events already says where an event came from
--    (source = kiosk / pwa / web / admin) but not who keyed it in. HR and
--    managers can record attendance for someone else, including backdated
--    (20261111_record_attendance_at_time.sql), and an auditor needs to tell
--    those apart from the employee's own clock-ins.
--
--    recorded_by defaults to auth.uid(), so every existing path fills it in
--    without touching the attendance functions (they're SECURITY DEFINER, but
--    auth.uid() still reads the caller's JWT):
--      * self-service (PWA)          -> the employee themselves
--      * HR / manager on their behalf -> that HR user or manager
--      * kiosk (no user session)      -> null, source = 'kiosk'
--      * automatic clock-out on deactivation (service role) -> null, source = 'admin'
--    Rows from before this migration stay null: unknown.

alter table public.attendance_events
  add column recorded_by uuid default auth.uid() references public.profiles(id) on delete set null;

-- 2. RETENTION. Block deleting records still inside their retention period,
--    whatever the path: the purge-employee Edge Function (service role, so RLS
--    doesn't apply -- triggers still do), a cascade from deleting a profile,
--    or a stray DELETE in the SQL editor.
--
--    Deliberate escape hatch for genuine test data, in the SQL editor only:
--      begin;
--      set local app.allow_record_purge = 'on';
--      delete ...;
--      commit;
--    "set local" lasts for that transaction only.

create or replace function public._protect_retained_records()
returns trigger language plpgsql set search_path = public as $$
begin
  if coalesce(current_setting('app.allow_record_purge', true), '') = 'on' then
    return old;
  end if;

  if tg_table_name = 'attendance_events' and old.occurred_at > now() - interval '3 years' then
    raise exception 'Attendance records must be kept for 3 years (Organisation of Working Time Act 1997). This one is from %.', old.occurred_at::date;
  elsif tg_table_name = 'attendance_sessions' and old.work_date > (now() - interval '3 years')::date then
    raise exception 'Attendance records must be kept for 3 years (Organisation of Working Time Act 1997). This one is from %.', old.work_date;
  elsif tg_table_name = 'leave_requests' then
    if old.leave_type::text = 'medical' and old.ends_on > (now() - interval '4 years')::date then
      raise exception 'Sick leave records must be kept for 4 years (Sick Leave Act 2022). This one ends %.', old.ends_on;
    elsif old.ends_on > (now() - interval '3 years')::date then
      raise exception 'Leave records must be kept for 3 years (Organisation of Working Time Act 1997). This one ends %.', old.ends_on;
    end if;
  end if;

  return old;
end; $$;

revoke all on function public._protect_retained_records() from public, anon, authenticated;

create trigger protect_retained_attendance_events
  before delete on public.attendance_events
  for each row execute function public._protect_retained_records();

create trigger protect_retained_attendance_sessions
  before delete on public.attendance_sessions
  for each row execute function public._protect_retained_records();

create trigger protect_retained_leave_requests
  before delete on public.leave_requests
  for each row execute function public._protect_retained_records();
