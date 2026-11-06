-- Managers can turn phone clock-out (20261022) on or off for the people they
-- manage -- typically drivers and warehouse staff who finish after the office
-- with the kiosk is locked.
--
-- Only HR has an UPDATE policy on profiles (20260820), and widening that to
-- managers would let them change any column (role, team, ...). Instead this
-- function changes this one column, for:
--   * HR: anyone;
--   * managers: people in a team they manage or a team below it
--     (is_manager_of -- never themselves). Team leads are not included.

create or replace function public.set_phone_clock_out(p_employee_id uuid, p_enabled boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and active) then
    raise exception 'You must be signed in to change this.';
  end if;

  if not (public.current_role_is(array['hr_admin'])
          or (public.current_role_is(array['manager']) and public.is_manager_of(p_employee_id))) then
    raise exception 'Only HR or the employee''s manager can change phone clock-out.';
  end if;

  update profiles set phone_clock_out = coalesce(p_enabled, false) where id = p_employee_id;
  if not found then
    raise exception 'Employee not found.';
  end if;
end;
$$;

revoke all on function public.set_phone_clock_out(uuid, boolean) from public, anon;
grant execute on function public.set_phone_clock_out(uuid, boolean) to authenticated;
