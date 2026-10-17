-- Phone clock-out for people who can't get to the kiosk at the end of the day:
-- drivers coming back after hours, and warehouse staff when the office (where
-- the kiosk is) is already locked.
--
-- profiles.phone_clock_out lets HR allow just the end of the day from the app:
-- clock out, plus ending a break or lunch so someone who leaves mid-break isn't
-- stuck. Clock-in, and starting a break or lunch, still happen at the kiosk.
-- self_service_attendance (everything from the app) is unchanged and still
-- covers this for anyone who has it.
--
-- The phone's location, when it gives one, is stored on the clock-out event
-- for HR to look at. It isn't checked against the approved location: drivers
-- finish wherever the route ends, and the geofence switch only ever applied
-- to office clock-ins.
--
-- Latest body is 20261019_geofence_toggle.sql; same signature, so this
-- replaces it rather than adding an overload.

alter table public.profiles add column phone_clock_out boolean not null default false;

create or replace function public.record_attendance_event(
  p_event_type public.attendance_event_type,
  p_idempotency_key uuid,
  p_source text,
  p_work_mode text default null,
  p_location jsonb default null,
  p_employee_id uuid default null
) returns public.attendance_sessions language plpgsql security definer set search_path = public as $$
declare
  v_caller uuid := auth.uid();
  v_lat numeric;
  v_lng numeric;
  v_radius int;
  v_location_status text;
  v_self_service boolean;
  v_phone_clock_out boolean;
begin
  if v_caller is null then raise exception 'Authentication required'; end if;

  if p_employee_id is not null and p_employee_id <> v_caller then
    if not public.current_role_is(array['hr_admin']) then
      raise exception 'Not authorized to record attendance for another employee';
    end if;
    return public._record_attendance_event_core(p_employee_id, p_event_type, p_idempotency_key, p_source, p_work_mode, p_location, null);
  end if;

  select self_service_attendance, phone_clock_out into v_self_service, v_phone_clock_out
    from profiles where id = v_caller;

  if not coalesce(v_self_service, false) then
    if coalesce(v_phone_clock_out, false) and p_event_type in ('clock_out', 'break_end', 'lunch_end') then
      return public._record_attendance_event_core(v_caller, p_event_type, p_idempotency_key, p_source, p_work_mode, p_location, null);
    end if;
    if coalesce(v_phone_clock_out, false) then
      raise exception 'Clock in and start breaks at the kiosk. You can only clock out (or end a break or lunch) from the app.';
    end if;
    raise exception 'Attendance must be recorded at the kiosk. Use the shared tablet to clock in, clock out, or start/end a break or lunch.';
  end if;

  v_location_status := null;
  if p_event_type = 'clock_in' and p_work_mode = 'office' then
    select l.latitude, l.longitude, l.radius_meters into v_lat, v_lng, v_radius
      from profiles p
      join attendance_locations l on l.id = p.attendance_location_id
      where p.id = v_caller;

    if not found or p_location is null or p_location->>'latitude' is null then
      v_location_status := 'unavailable';
    else
      v_location_status := case
        when public._distance_meters((p_location->>'latitude')::numeric, (p_location->>'longitude')::numeric, v_lat, v_lng) <= v_radius
        then 'verified' else 'out_of_range' end;
    end if;

    if v_location_status <> 'verified' and exists (select 1 from app_settings where geofence_enforced) then
      if v_lat is null then
        raise exception 'You don''t have an approved clock-in location yet. Ask HR to set one, or clock in at the kiosk.';
      elsif v_location_status = 'unavailable' then
        raise exception 'Couldn''t confirm your location. Allow location access for this app and try again, or clock in at the kiosk.';
      else
        raise exception 'You''re outside your approved clock-in location. Clock in on site or at the kiosk.';
      end if;
    end if;
  end if;

  return public._record_attendance_event_core(v_caller, p_event_type, p_idempotency_key, p_source, p_work_mode, p_location, v_location_status);
end; $$;
