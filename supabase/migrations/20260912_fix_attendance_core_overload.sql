-- Fixes a regression from 20260909_geolocation_attendance.sql, and closes a
-- longer-standing privilege hole that investigating it surfaced.
--
-- 1. BROKEN KIOSK (introduced by 20260909). That migration added a 7th
--    parameter to _record_attendance_event_core. "create or replace" only
--    replaces a function with the *same* argument list -- changing the count
--    creates an overload instead, so the 6-argument version from
--    20260831_attendance_admin_override.sql was left in place alongside it.
--    record_kiosk_attendance_event still calls the function with 6 arguments,
--    which Postgres can now satisfy either by the 6-arg function or by the
--    7-arg one filling p_location_status from its default -- an ambiguous
--    call, rejected with "function ... is not unique". Every kiosk clock-in
--    failed between that migration and this one.
--
-- 2. OVER-BROAD EXECUTE GRANT (pre-dates 20260909). This helper is SECURITY
--    DEFINER and performs no authorization of its own -- callers are meant to
--    arrive through a wrapper that checks kiosk pairing, hr_admin role, or the
--    self-service permission. 20260827_kiosk_runtime.sql tried to lock it down
--    with "revoke all ... from public", but that only drops the PUBLIC
--    pseudo-role. Supabase's default privileges *also* grant EXECUTE
--    explicitly to anon and authenticated, and those grants survived. So the
--    6-arg version had been directly callable by any client since kiosk
--    runtime shipped, and the 7-arg overload inherited the same grants plus
--    PUBLIC. Either could record attendance for any employee, bypassing all
--    three checks.

drop function if exists public._record_attendance_event_core(
  uuid, public.attendance_event_type, uuid, text, text, jsonb
);

-- Revoked from anon and authenticated as well as PUBLIC, not just PUBLIC.
-- Supabase ships "alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role", so every function created
-- here also picks up *explicit* per-role grants. Revoking PUBLIC alone (as
-- 20260827 did for the 6-arg version) leaves those in place, which is why that
-- function still shows an anon/authenticated grant today.
--
-- This does not affect the wrappers. record_attendance_event and
-- record_kiosk_attendance_event are SECURITY DEFINER owned by postgres, so
-- their calls into this helper are authorized as the owner, not as the client.
revoke all on function public._record_attendance_event_core(
  uuid, public.attendance_event_type, uuid, text, text, jsonb, text
) from public, anon, authenticated;

-- Same treatment for the geofence helper. It is pure arithmetic over its
-- arguments (no table access, not SECURITY DEFINER) so it leaks nothing, but
-- internal helpers stay off the client-callable surface on principle.
revoke all on function public._distance_meters(numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
