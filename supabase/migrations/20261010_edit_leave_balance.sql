-- Lets HR edit a current-year leave balance in full from Leave management:
-- yearly allowance, days used, and (optionally) the remaining days today.
-- Depends on leave_balances.adjustment from 20261009_leave_opening_balance.sql.
--
-- A new function rather than extra parameters on set_opening_leave_balance:
-- changing that signature would create a silent overload (see CLAUDE.md), and
-- the import still calls it as is.
--
--   p_used       sets leave_balances.used directly.
--   p_remaining  when not null, re-pins the adjustment so that available
--                (accrued + adjustment - used) equals it today, using the NEW
--                used value. When null, the adjustment is left alone, so a
--                change to used lowers/raises remaining by the same amount.

create or replace function public.set_leave_balance(
  p_employee_id uuid,
  p_leave_type text,
  p_entitlement numeric,
  p_used numeric,
  p_remaining numeric
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_year date := public.current_leave_year_start();
  v_start date;
  v_accrued numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.current_role_is(array['hr_admin']) then
    raise exception 'Only HR administrators can edit leave balances';
  end if;
  if p_leave_type not in ('annual', 'medical', 'unpaid', 'other') then raise exception 'Invalid leave type'; end if;
  if p_entitlement is null or p_entitlement < 0 then raise exception 'Yearly allowance must be zero or more'; end if;
  if p_used is null or p_used < 0 then raise exception 'Used days must be zero or more'; end if;
  if p_remaining is not null and p_remaining < 0 then raise exception 'Remaining days must be zero or more'; end if;
  if p_remaining is not null and p_leave_type = 'unpaid' then
    raise exception 'Unpaid leave has no balance to set';
  end if;

  select start_date into v_start from profiles where id = p_employee_id;
  if v_start is null then raise exception 'Employee not found'; end if;

  insert into leave_balances (employee_id, leave_type, leave_year_start, entitlement, used)
    values (p_employee_id, p_leave_type, v_year, p_entitlement, p_used)
    on conflict (employee_id, leave_type, leave_year_start)
      do update set entitlement = excluded.entitlement, used = excluded.used;

  if p_remaining is not null then
    v_accrued := round(p_entitlement * least(12, greatest(0,
      (extract(year from current_date) - extract(year from public.leave_accrual_anchor(v_year, v_start))) * 12
      + (extract(month from current_date) - extract(month from public.leave_accrual_anchor(v_year, v_start))) + 1
    )) / 12.0, 2);

    update leave_balances
      set adjustment = p_remaining - v_accrued + p_used
      where employee_id = p_employee_id and leave_type = p_leave_type and leave_year_start = v_year;
  end if;
end; $$;

revoke all on function public.set_leave_balance(uuid, text, numeric, numeric, numeric) from public, anon;
grant execute on function public.set_leave_balance(uuid, text, numeric, numeric, numeric) to authenticated;
