-- Open-ended shifts: a start time with no fixed finish.
--
-- Drivers in Transport start at a set time (08:00, 10:00) but finish when the
-- route is done, so any end time on their template or roster shift was made
-- up. A null ends_at now means "until finished".
--
-- Nothing in the database depends on the finish time:
--   * attendance never closes a session at the shift end -- people clock out
--     themselves (kiosk, or phone clock-out from 20261022);
--   * worked hours come from clock-in/clock-out, not the roster;
--   * fill_roster (latest: 20261016_roster_leave_awareness.sql) copies
--     ends_at from the template as-is, so a null carries over;
--   * the swap and coverage functions only return ends_at for display.
-- The app treats a null end as zero scheduled hours, and judges lateness from
-- the start time as before.
--
-- roster_shifts' check (starts_at <> ends_at) is satisfied by a null end, so
-- it stays.

alter table public.work_schedules alter column ends_at drop not null;
alter table public.roster_shifts alter column ends_at drop not null;
