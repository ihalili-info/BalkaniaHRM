-- Annual leave doesn't count Saturdays or Sundays.
--
-- A Mon-Mon annual request used to cost 8 days (calendar days minus bank
-- holidays); it now costs 6. Other leave types still count calendar days
-- minus bank holidays, as before.
--
-- The count is stored on the request (working_days) when it's created, so
-- approval/cancel/override keep deducting and refunding what was booked.
-- No existing approved or pending request includes a weekend, so no balances
-- need correcting.
--
-- leave_working_days gains a leave-type argument. The old two-argument
-- version is dropped explicitly: create or replace with a different argument
-- list would add an overload rather than replace it.

drop function public.leave_working_days(date, date);

create or replace function public.leave_working_days(p_starts_on date, p_ends_on date, p_leave_type text)
returns int language sql stable set search_path = public as $$
  select count(*)::int
  from generate_series(p_starts_on, p_ends_on, interval '1 day') as d(day)
  where not exists (select 1 from holidays where holiday_date = d.day::date)
    and (p_leave_type <> 'annual' or extract(isodow from d.day) < 6);
$$;

grant execute on function public.leave_working_days(date, date, text) to authenticated;

create or replace function public.validate_leave_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_requested_days numeric;
  v_earned numeric;
  v_used numeric;
begin
  if not exists (select 1 from profiles where id = new.employee_id and active) then
    raise exception 'This employee account is deactivated.';
  end if;

  new.working_days := public.leave_working_days(new.starts_on, new.ends_on, new.leave_type);
  if new.working_days <= 0 then
    if new.leave_type = 'annual' then
      raise exception 'These dates are all weekends or bank holidays, so no annual leave is needed.';
    end if;
    raise exception 'Every day in this range is a bank holiday, so no leave is needed.';
  end if;

  if new.leave_type = 'unpaid' then
    return new;
  end if;

  v_requested_days := new.working_days;

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
    raise exception 'This request is % days (%), but only % days of % leave are available to book.',
      v_requested_days,
      case when new.leave_type = 'annual' then 'weekends and bank holidays not counted' else 'bank holidays not counted' end,
      (v_earned - coalesce(v_used, 0)), new.leave_type;
  end if;

  return new;
end; $$;
