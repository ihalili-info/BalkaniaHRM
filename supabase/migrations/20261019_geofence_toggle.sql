-- Makes the "geolocation rule" switch on the Devices screen real.
--
-- Until now a mobile office clock-in was only *labelled* verified /
-- out_of_range / unavailable (20260909_geolocation_attendance.sql) and always
-- went through. With app_settings.geofence_enforced on, record_attendance_event
-- rejects an office clock-in unless it's verified inside the employee's
-- approved location. Off (the default) keeps today's behaviour.
--
-- Only self-service (phone) office clock-ins are affected: kiosk scans, HR
-- entries and remote-mode clock-ins don't carry a location check.

create table public.app_settings (
  id boolean primary key default true check (id),
  geofence_enforced boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

insert into public.app_settings (id) values (true);

alter table public.app_settings enable row level security;

create policy "authenticated read app settings" on public.app_settings
  for select to authenticated using (true);
create policy "hr admin update app settings" on public.app_settings
  for update to authenticated
  using (public.current_role_is(array['hr_admin']))
  with check (public.current_role_is(array['hr_admin']));

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
begin
  if v_caller is null then raise exception 'Authentication required'; end if;

  if p_employee_id is not null and p_employee_id <> v_caller then
    if not public.current_role_is(array['hr_admin']) then
      raise exception 'Not authorized to record attendance for another employee';
    end if;
    return public._record_attendance_event_core(p_employee_id, p_event_type, p_idempotency_key, p_source, p_work_mode, p_location, null);
  end if;

  if not exists (select 1 from profiles where id = v_caller and self_service_attendance) then
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
