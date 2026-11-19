-- Former employees stop accruing leave.
--
-- leave_balances_current computes "earned" live up to current_date, so a
-- deactivated employee kept earning annual leave every month after they left.
-- Accrual now runs up to the earliest of:
--   * today,
--   * their leaving date (employee_details.leaving_date, entered when HR
--     deactivates them -- 20261118_employee_leaving_details.sql),
--   * for a former employee with no leaving date, the day they were
--     deactivated (profiles.deactivated_at, new below).
-- An active employee with a future leaving date (working their notice) keeps
-- accruing until then, which is what the least() gives.

-- 1. When were they deactivated? Stamped automatically whenever profiles.active
--    flips (set-employee-active, or a manual update), cleared on reactivation.
alter table public.profiles add column deactivated_at timestamptz;

-- People already deactivated: the real date isn't known, so their accrual
-- freezes from today. HR can set an accurate leaving date in Edit employee,
-- which then takes over.
update public.profiles set deactivated_at = now() where not active and deactivated_at is null;

create or replace function public._stamp_deactivated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.active is distinct from old.active then
    new.deactivated_at := case when new.active then null else now() end;
  end if;
  return new;
end; $$;

revoke all on function public._stamp_deactivated_at() from public, anon, authenticated;

create trigger profiles_stamp_deactivated_at
  before update of active on public.profiles
  for each row execute function public._stamp_deactivated_at();

-- 2. Same columns, in the same order, as 20261021_statutory_sick_leave.sql;
--    only the accrual date changes. (Like before, the view runs with its
--    owner's rights; the leaving date only feeds the calculation and isn't
--    exposed as a column.)
create or replace view public.leave_balances_current as
select
  lb.id,
  lb.employee_id,
  lb.leave_type,
  lb.entitlement,
  lb.used,
  lb.leave_year_start,
  public.leave_accrued(
    lb.leave_type,
    lb.entitlement,
    lb.leave_year_start,
    p.start_date,
    least(
      current_date,
      coalesce(ed.leaving_date, case when not p.active then p.deactivated_at::date end, current_date)
    )
  ) + lb.adjustment as earned
from public.leave_balances lb
join public.profiles p on p.id = lb.employee_id
left join public.employee_details ed on ed.employee_id = lb.employee_id
where lb.leave_year_start = public.leave_type_year_start(lb.leave_type, current_date);
