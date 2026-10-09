-- Opening leave balances, for importing staff who already have days left over
-- from before Balkania HRM (the "Annual Leave" / "Sick Leave" columns of the
-- HR spreadsheet).
--
-- "earned" is computed live from entitlement and elapsed months (see
-- 20260825 / 20260903), so a remaining-days figure can't simply be stored.
-- Instead each balance row gets an "adjustment" that is added to the accrued
-- amount. set_opening_leave_balance() picks the adjustment so that TODAY's
-- available balance (earned - used) equals the imported figure; monthly accrual
-- then continues on top of it as usual.
--
-- The adjustment belongs to one leave-year row, so it lapses at the Apr 1 reset
-- like any other unused balance under the existing no-carry-over rule.

alter table public.leave_balances add column adjustment numeric(6,2) not null default 0;

-- Same columns as before; "earned" now includes the adjustment so every reader
-- of the view (admin balances, employee app) shows the right figure unchanged.
create or replace view public.leave_balances_current as
select
  lb.id,
  lb.employee_id,
  lb.leave_type,
  lb.entitlement,
  lb.used,
  lb.leave_year_start,
  round(
    lb.entitlement * least(12, greatest(0,
      (extract(year from current_date) - extract(year from public.leave_accrual_anchor(lb.leave_year_start, p.start_date))) * 12
      + (extract(month from current_date) - extract(month from public.leave_accrual_anchor(lb.leave_year_start, p.start_date))) + 1
    )) / 12.0,
  2) + lb.adjustment as earned
from public.leave_balances lb
join public.profiles p on p.id = lb.employee_id
where lb.leave_year_start = public.current_leave_year_start();

-- Latest body from 20260903_leave_accrual_from_hire_date.sql, with the
-- adjustment added to "earned" so booking checks match what the view shows.
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
    raise exception 'No % leave balance is set up for you yet. Ask HR to set your entitlement before requesting this leave type.', new.leave_type;
  end if;

  if v_requested_days > (v_earned - coalesce(v_used, 0)) then
    raise exception 'This request is % days, but only % days of % leave are available to book.', v_requested_days, (v_earned - coalesce(v_used, 0)), new.leave_type;
  end if;

  return new;
end; $$;

-- Sets an employee's current-year balance so that "available" equals
-- p_remaining today. p_entitlement (days per year, drives future accrual)
-- replaces the stored entitlement when given; null keeps the existing one
-- (0 for a new row).
create or replace function public.set_opening_leave_balance(
  p_employee_id uuid,
  p_leave_type text,
  p_remaining numeric,
  p_entitlement numeric
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_year date := public.current_leave_year_start();
  v_start date;
  v_entitlement numeric;
  v_used numeric;
  v_accrued numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.current_role_is(array['hr_admin']) then
    raise exception 'Only HR administrators can set leave balances';
  end if;
  if p_leave_type not in ('annual', 'medical', 'other') then
    raise exception 'Opening balances can only be set for annual, medical or other leave';
  end if;
  if p_remaining is null or p_remaining < 0 then raise exception 'Remaining days must be zero or more'; end if;
  if p_entitlement is not null and p_entitlement < 0 then raise exception 'Entitlement must be zero or more'; end if;

  select start_date into v_start from profiles where id = p_employee_id;
  if v_start is null then raise exception 'Employee not found'; end if;

  insert into leave_balances (employee_id, leave_type, leave_year_start, entitlement)
    values (p_employee_id, p_leave_type, v_year, coalesce(p_entitlement, 0))
    on conflict (employee_id, leave_type, leave_year_start)
      do update set entitlement = coalesce(p_entitlement, leave_balances.entitlement);

  select entitlement, used into v_entitlement, v_used
    from leave_balances
    where employee_id = p_employee_id and leave_type = p_leave_type and leave_year_start = v_year
    for update;

  v_accrued := round(v_entitlement * least(12, greatest(0,
    (extract(year from current_date) - extract(year from public.leave_accrual_anchor(v_year, v_start))) * 12
    + (extract(month from current_date) - extract(month from public.leave_accrual_anchor(v_year, v_start))) + 1
  )) / 12.0, 2);

  -- available = (accrued + adjustment) - used  =>  adjustment = remaining - accrued + used
  update leave_balances
    set adjustment = p_remaining - v_accrued + v_used
    where employee_id = p_employee_id and leave_type = p_leave_type and leave_year_start = v_year;
end; $$;

revoke all on function public.set_opening_leave_balance(uuid, text, numeric, numeric) from public, anon;
grant execute on function public.set_opening_leave_balance(uuid, text, numeric, numeric) to authenticated;
