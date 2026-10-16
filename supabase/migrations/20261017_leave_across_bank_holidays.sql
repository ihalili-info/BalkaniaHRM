-- Leave may now span a bank holiday; the holiday isn't counted.
--
-- validate_leave_request used to reject any range containing a bank holiday,
-- so someone wanting 22-30 Oct with the October bank holiday on the 26th had
-- to file two requests. Now the request is accepted and costs 8 days, not 9.
--
-- The counted days are stored on the request (working_days) when it's
-- created, and approval, override, cancel and supervisor-recorded leave all
-- deduct/refund that stored number. Recomputing at refund time would drift if
-- HR added a holiday inside already-approved leave, leaving the balance off.
--
-- Existing requests are backfilled with the old calendar-day count, which is
-- exactly what was deducted for them (none could include a holiday before).

create or replace function public.leave_working_days(p_starts_on date, p_ends_on date)
returns int language sql stable set search_path = public as $$
  select (p_ends_on - p_starts_on + 1)
    - (select count(*)::int from holidays where holiday_date between p_starts_on and p_ends_on);
$$;

grant execute on function public.leave_working_days(date, date) to authenticated;

alter table public.leave_requests add column working_days int;
update public.leave_requests set working_days = ends_on - starts_on + 1;
alter table public.leave_requests alter column working_days set not null;

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

  new.working_days := public.leave_working_days(new.starts_on, new.ends_on);
  if new.working_days <= 0 then
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
    raise exception 'This request is % days (bank holidays not counted), but only % days of % leave are available to book.', v_requested_days, (v_earned - coalesce(v_used, 0)), new.leave_type;
  end if;

  return new;
end; $$;

create or replace function public.review_leave_request(p_request_id uuid, p_status public.leave_request_status, p_comment text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_employee uuid;
  v_previous public.leave_request_status;
  v_days int;
  v_can_override boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_status not in ('approved','rejected') then raise exception 'Only approvals or rejections are allowed'; end if;

  select employee_id, status into v_employee, v_previous
    from leave_requests where id = p_request_id for update;
  if v_employee is null then raise exception 'Leave request not found'; end if;

  v_can_override := public.current_role_is(array['hr_admin']) or public.is_manager_of(v_employee);
  if not (v_can_override or public.is_team_lead_of(v_employee)) then
    raise exception 'Not authorized to review this request';
  end if;

  if v_previous = 'cancelled' then
    raise exception 'This request was cancelled by the employee and can no longer be reviewed.';
  end if;
  if v_previous <> 'pending' and not v_can_override then
    raise exception 'This request was already reviewed. Only a manager or HR can change that decision.';
  end if;
  if v_previous = p_status then
    raise exception 'This request is already %.', p_status;
  end if;

  update leave_requests set status = p_status where id = p_request_id returning * into v_request;

  -- Keep the balance in step with the decision in both directions: approving
  -- consumes days, and reversing an approval hands them back.
  v_days := v_request.working_days;
  if p_status = 'approved' and v_previous <> 'approved' then
    update leave_balances set used = used + v_days
      where employee_id = v_request.employee_id and leave_type = v_request.leave_type
        and leave_year_start = public.current_leave_year_start();
  elsif v_previous = 'approved' and p_status <> 'approved' then
    update leave_balances set used = greatest(0, used - v_days)
      where employee_id = v_request.employee_id and leave_type = v_request.leave_type
        and leave_year_start = public.current_leave_year_start();
  end if;

  return v_request;
end; $$;

create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_previous public.leave_request_status;
  v_employee uuid;
  v_recorded_by uuid;
  v_who text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select employee_id, status, recorded_by into v_employee, v_previous, v_recorded_by
    from leave_requests where id = p_request_id for update;
  if v_employee is null then raise exception 'Leave request not found'; end if;

  if public.current_role_is(array['hr_admin']) then
    v_who := 'HR';
  elsif public.is_manager_of(v_employee) or (v_recorded_by = auth.uid() and public.can_supervise(v_employee)) then
    select full_name into v_who from profiles where id = auth.uid();
  else
    raise exception 'Only HR, the manager, or whoever recorded this leave can cancel it';
  end if;

  if v_previous = 'cancelled' then
    raise exception 'This request is already cancelled.';
  end if;

  update leave_requests
     set status = 'cancelled',
         note = case
                  when nullif(trim(coalesce(p_reason, '')), '') is null then note
                  when note is null or note = '' then 'Cancelled by ' || v_who || ': ' || trim(p_reason)
                  else note || E'\n\nCancelled by ' || v_who || ': ' || trim(p_reason)
                end
   where id = p_request_id
   returning * into v_request;

  -- Only an approved request ever consumed days, so only that one refunds.
  if v_previous = 'approved' then
    update leave_balances
       set used = greatest(0, used - v_request.working_days)
     where employee_id = v_request.employee_id
       and leave_type = v_request.leave_type
       and leave_year_start = public.leave_year_start_for(v_request.starts_on);
  end if;

  return v_request;
end; $$;

create or replace function public.record_leave_for_employee(
  p_employee_id uuid,
  p_leave_type text,
  p_starts_on date,
  p_ends_on date,
  p_note text
) returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not (public.current_role_is(array['hr_admin']) or public.can_supervise(p_employee_id)) then
    raise exception 'Not authorized to record leave for this employee';
  end if;
  if p_leave_type not in ('annual', 'medical', 'unpaid', 'other') then raise exception 'Invalid leave type'; end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then raise exception 'Invalid date range'; end if;
  if exists (
    select 1 from leave_requests
    where employee_id = p_employee_id and status in ('pending', 'approved')
      and starts_on <= p_ends_on and ends_on >= p_starts_on
  ) then
    raise exception 'This person already has leave booked or requested on these dates.';
  end if;

  -- Inserted as pending so validate_leave_request (balance, holidays,
  -- deactivated, working_days) runs exactly as for an employee's own request.
  insert into leave_requests (employee_id, leave_type, starts_on, ends_on, note, status, recorded_by)
    values (p_employee_id, p_leave_type, p_starts_on, p_ends_on, nullif(trim(coalesce(p_note, '')), ''), 'pending', auth.uid())
    returning * into v_request;

  update leave_requests set status = 'approved' where id = v_request.id returning * into v_request;
  update leave_balances set used = used + v_request.working_days
    where employee_id = p_employee_id and leave_type = p_leave_type
      and leave_year_start = public.leave_year_start_for(p_starts_on);

  -- They're not working those days any more. A shift on the bank holiday
  -- itself is kept: it isn't part of the leave and someone may be covering.
  delete from roster_shifts
    where employee_id = p_employee_id and shift_date between p_starts_on and p_ends_on
      and not exists (select 1 from holidays where holiday_date = shift_date);
  delete from roster_days_off where employee_id = p_employee_id and off_date between p_starts_on and p_ends_on;

  return v_request;
end; $$;
