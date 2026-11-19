-- Annual leave is credited at the END of each month, not the start.
--
-- Before: the month containing p_on counted in full, so November's 1/12 was
-- added on 1 November, before it was worked (and a leaver kept their whole
-- final month). Now a month counts once it's complete: it's credited on its
-- last day, so November's 1/12 arrives on 30 November.
--
-- Why the last day and not the 1st of the next month: the leave year resets
-- on 1 April, so March's 1/12 credited on 1 April would fall into the new
-- year and be lost. Crediting on 31 March keeps all 12 months in the year.
--
-- The first month that accrues is unchanged: the later of the leave-year
-- start and the month after the start date (leave_accrual_anchor). Sick leave
-- is unchanged (the full statutory allowance once qualified).
--
-- TODAY'S BALANCES ARE KEPT. HR's figures (mostly opening balances imported
-- from the old records) are taken as the balance before the current month's
-- leave, so nobody's balance drops when this is applied; the current month
-- is then added on top at its end. E.g. 0.50 today -> 2.17 on 30 November
-- (20 days a year). Step 1 does that by moving the one-month difference
-- between the old and new rule into each balance's adjustment, computed with
-- the old function before step 2 replaces it -- so keep the two steps in this
-- order, in one transaction, and RUN THIS FILE ONCE ONLY (a second run on the
-- last day of a month would add that month again).

-- 1. Keep today's figure for current employees' imported balances this leave
--    year (adjustment <> 0: an opening balance from the old records). A
--    balance built purely from accrual already had this month added early, so
--    it simply moves to the end of the month -- topping it up too would give
--    13 months by March. Former employees' accrual stops at their leaving
--    date instead (20261119_stop_leave_accrual_for_leavers.sql).
update public.leave_balances lb
   set adjustment = lb.adjustment
     + public.leave_accrued(lb.leave_type, lb.entitlement, lb.leave_year_start, p.start_date, current_date)  -- old rule
     -- new rule without the current month (even if today is its last day), so
     -- the current month is always added on top of today's figure
     - round(lb.entitlement * least(12, greatest(0,
         (extract(year from current_date) - extract(year from public.leave_accrual_anchor(lb.leave_year_start, p.start_date))) * 12
         + (extract(month from current_date) - extract(month from public.leave_accrual_anchor(lb.leave_year_start, p.start_date)))
       )) / 12.0, 2)
  from public.profiles p
 where p.id = lb.employee_id
   and p.active
   and lb.adjustment <> 0
   and lb.leave_type <> 'medical'
   and lb.leave_year_start = public.leave_type_year_start(lb.leave_type, current_date);

-- 2. The new rule. Same signature, so this replaces the function rather than
--    overloading it; every caller (leave_balances_current,
--    annual_leave_available, validate_leave_request, set_leave_balance,
--    set_opening_leave_balance, sick_leave_status) picks it up.
create or replace function public.leave_accrued(
  p_leave_type text,
  p_entitlement numeric,
  p_year_start date,
  p_start_date date,
  p_on date
) returns numeric language sql immutable as $$
  select case
    when p_leave_type = 'medical' then
      case when p_on >= public.sick_leave_qualifying_date(p_start_date) then p_entitlement else 0 end
    else round(p_entitlement * least(12, greatest(0,
      -- whole months from the anchor month up to (not including) p_on's month...
      (extract(year from p_on) - extract(year from public.leave_accrual_anchor(p_year_start, p_start_date))) * 12
      + (extract(month from p_on) - extract(month from public.leave_accrual_anchor(p_year_start, p_start_date)))
      -- ...plus p_on's own month on its last day
      + case when p_on = (date_trunc('month', p_on) + interval '1 month - 1 day')::date then 1 else 0 end
    )) / 12.0, 2)
  end;
$$;
