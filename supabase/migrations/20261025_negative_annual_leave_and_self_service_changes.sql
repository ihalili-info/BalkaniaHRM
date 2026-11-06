-- Two changes to annual leave.
--
-- 1. Going below zero. Annual leave builds up 1/12 a month, so early in the
--    leave year people often can't book a holiday they'll have earned by the
--    time they take it. Requests beyond what's available are now accepted
--    (the employee app warns first), but only HR can approve one that takes
--    the balance below zero -- managers and team leads get a clear refusal.
--    HR can also set a negative "remaining" directly. Sick leave is unchanged:
--    it's capped at the statutory days and the rest goes in as unpaid.
--
-- 2. Employees can cancel, or change the dates of, their own annual leave
--    before it starts, whether it's pending or already approved. Cancelling an
--    approved request hands the days back. Changing dates cancels the original
--    and files a new pending request, so the new dates need approving again.
--
-- Every function below keeps its existing signature (create or replace
-- replaces it) except change_leave_request_dates and annual_leave_available,
-- which are new.

-- ---------------------------------------------------------------------------
-- Helper: annual leave available to book today (earned so far + HR
-- adjustment - used), or null if no balance is set up. Internal only.
-- ---------------------------------------------------------------------------

create or replace function public.annual_leave_available(p_employee_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select public.leave_accrued(lb.leave_type, lb.entitlement, lb.leave_year_start, p.start_date, current_date)
         + lb.adjustment - lb.used
  from leave_balances lb
  join profiles p on p.id = lb.employee_id
  where lb.employee_id = p_employee_id and lb.leave_type = 'annual'
    and lb.leave_year_start = public.current_leave_year_start();
$$;

revoke all on function public.annual_leave_available(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Booking: annual leave may exceed the balance (approval decides).
-- ---------------------------------------------------------------------------

create or replace function public.validate_leave_request()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_requested_days numeric;
  v_earned numeric;
  v_used numeric;
  v_year date;
  v_start_date date;
  v_qualifies_on date;
begin
  if not exists (select 1 from profiles where id = new.employee_id and active) then
    raise exception 'This employee account is deactivated.';
  end if;

  -- Certificates are attached afterwards through attach_medical_certificate,
  -- which checks the file exists. Never trust one set on the insert.
  new.medical_certificate_path := null;
  new.medical_certificate_uploaded_at := null;
  new.medical_certificate_uploaded_by := null;

  new.working_days := public.leave_working_days(new.starts_on, new.ends_on, new.leave_type);
  if new.working_days <= 0 then
    if new.leave_type in ('annual', 'medical') then
      raise exception 'These dates are all weekends or bank holidays, so no % leave is needed.',
        case when new.leave_type = 'annual' then 'annual' else 'sick' end;
    end if;
    raise exception 'Every day in this range is a bank holiday, so no leave is needed.';
  end if;

  if new.leave_type = 'unpaid' then
    return new;
  end if;

  v_requested_days := new.working_days;

  if new.leave_type = 'medical' then
    if extract(year from new.starts_on) <> extract(year from new.ends_on) then
      raise exception 'Sick leave resets on 1 January, so one request can''t run past 31 December. Split it into a request for each year.';
    end if;

    select start_date into v_start_date from profiles where id = new.employee_id;
    v_qualifies_on := public.sick_leave_qualifying_date(v_start_date);
    if new.starts_on < v_qualifies_on then
      raise exception 'Paid sick leave starts after 13 weeks of continuous service. With a start date of %, that''s from %; on % only % full weeks have been worked. Record the days before % as unpaid leave instead.',
        to_char(v_start_date, 'DD Mon YYYY'),
        to_char(v_qualifies_on, 'DD Mon YYYY'),
        to_char(new.starts_on, 'DD Mon YYYY'),
        greatest(0, (new.starts_on - v_start_date) / 7),
        to_char(v_qualifies_on, 'DD Mon YYYY');
    end if;

    v_year := public.leave_type_year_start('medical', new.starts_on);
    perform public.ensure_sick_leave_balance(new.employee_id, v_year);
  else
    v_year := public.current_leave_year_start();
  end if;

  select
    public.leave_accrued(lb.leave_type, lb.entitlement, lb.leave_year_start, p.start_date,
      case when new.leave_type = 'medical' then new.starts_on else current_date end) + lb.adjustment,
    lb.used
  into v_earned, v_used
  from leave_balances lb
  join profiles p on p.id = lb.employee_id
  where lb.employee_id = new.employee_id and lb.leave_type = new.leave_type
    and lb.leave_year_start = v_year;

  if v_earned is null then
    if new.leave_type = 'other' then
      return new;
    end if;
    raise exception 'No % leave balance is set up yet. Ask HR to set the entitlement before booking this leave type.', new.leave_type;
  end if;

  -- Annual leave can go below zero; review_leave_request makes sure only HR
  -- approves that.
  if new.leave_type = 'annual' then
    return new;
  end if;

  if v_requested_days > (v_earned - coalesce(v_used, 0)) then
    if new.leave_type = 'medical' then
      raise exception 'This sick leave is % working days, but only % paid sick days are left for %. Record the extra days as unpaid leave.',
        v_requested_days, greatest(0, v_earned - coalesce(v_used, 0)), extract(year from new.starts_on);
    end if;
    raise exception 'This request is % days (bank holidays not counted), but only % days of % leave are available to book.',
      v_requested_days, (v_earned - coalesce(v_used, 0)), new.leave_type;
  end if;

  return new;
end; $$;

-- ---------------------------------------------------------------------------
-- Approval: only HR can approve annual leave that goes below zero.
-- ---------------------------------------------------------------------------

create or replace function public.review_leave_request(p_request_id uuid, p_status public.leave_request_status, p_comment text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_existing public.leave_requests;
  v_previous public.leave_request_status;
  v_days int;
  v_year date;
  v_can_override boolean;
  v_available numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_status not in ('approved','rejected') then raise exception 'Only approvals or rejections are allowed'; end if;

  select * into v_existing from leave_requests where id = p_request_id for update;
  if v_existing.id is null then raise exception 'Leave request not found'; end if;
  v_previous := v_existing.status;

  v_can_override := public.current_role_is(array['hr_admin']) or public.is_manager_of(v_existing.employee_id);
  if not (v_can_override or public.is_team_lead_of(v_existing.employee_id)) then
    raise exception 'Not authorized to review this request';
  end if;

  if v_previous = 'cancelled' then
    raise exception 'This request was cancelled and can no longer be reviewed.';
  end if;
  if v_previous <> 'pending' and not v_can_override then
    raise exception 'This request was already reviewed. Only a manager or HR can change that decision.';
  end if;
  if v_previous = p_status then
    raise exception 'This request is already %.', p_status;
  end if;
  if p_status = 'approved' and v_existing.leave_type = 'medical' and v_existing.medical_certificate_path is null then
    raise exception 'Sick leave needs a doctor''s medical certificate before it can be approved. Upload the certificate first.';
  end if;

  if p_status = 'approved' and v_existing.leave_type = 'annual'
     and not public.current_role_is(array['hr_admin']) then
    v_available := coalesce(public.annual_leave_available(v_existing.employee_id), 0);
    if v_existing.working_days > v_available then
      raise exception 'This is % days of annual leave, but only % are available, so approving it would take the balance to %. Only HR can approve leave that goes below zero.',
        v_existing.working_days, v_available, v_available - v_existing.working_days;
    end if;
  end if;

  update leave_requests set status = p_status where id = p_request_id returning * into v_request;

  -- Keep the balance in step with the decision in both directions: approving
  -- consumes days, and reversing an approval hands them back. Sick leave is
  -- charged to the calendar year it falls in.
  v_days := v_request.working_days;
  if v_request.leave_type = 'medical' then
    v_year := public.leave_type_year_start('medical', v_request.starts_on);
    perform public.ensure_sick_leave_balance(v_request.employee_id, v_year);
  else
    v_year := public.current_leave_year_start();
  end if;

  if p_status = 'approved' and v_previous <> 'approved' then
    update leave_balances set used = used + v_days
      where employee_id = v_request.employee_id and leave_type = v_request.leave_type
        and leave_year_start = v_year;
  elsif v_previous = 'approved' and p_status <> 'approved' then
    update leave_balances set used = greatest(0, used - v_days)
      where employee_id = v_request.employee_id and leave_type = v_request.leave_type
        and leave_year_start = v_year;
  end if;

  return v_request;
end; $$;

-- ---------------------------------------------------------------------------
-- Cancelling: employees may now cancel their own annual leave before it starts.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_existing public.leave_requests;
  v_previous public.leave_request_status;
  v_who text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_existing from leave_requests where id = p_request_id for update;
  if v_existing.id is null then raise exception 'Leave request not found'; end if;
  v_previous := v_existing.status;

  if public.current_role_is(array['hr_admin']) then
    v_who := 'HR';
  elsif public.is_manager_of(v_existing.employee_id)
        or (v_existing.recorded_by = auth.uid() and public.can_supervise(v_existing.employee_id)) then
    select full_name into v_who from profiles where id = auth.uid();
  elsif v_existing.employee_id = auth.uid() then
    if v_existing.leave_type <> 'annual' then
      raise exception 'You can only cancel annual leave yourself. Ask your manager or HR to cancel this one.';
    end if;
    if v_existing.starts_on <= current_date then
      raise exception 'This leave has already started, so it can''t be cancelled from the app. Ask your manager or HR.';
    end if;
    v_who := 'the employee';
  else
    raise exception 'Only HR, the manager, or whoever recorded this leave can cancel it';
  end if;

  if v_previous = 'cancelled' then
    raise exception 'This request is already cancelled.';
  end if;
  if v_who = 'the employee' and v_previous = 'rejected' then
    raise exception 'This request was rejected, so there''s nothing to cancel.';
  end if;

  update leave_requests
     set status = 'cancelled',
         note = case
                  when nullif(trim(coalesce(p_reason, '')), '') is null then
                    case when v_who = 'the employee' then concat_ws(E'\n\n', nullif(note, ''), 'Cancelled by the employee.') else note end
                  when note is null or note = '' then 'Cancelled by ' || v_who || ': ' || trim(p_reason)
                  else note || E'\n\nCancelled by ' || v_who || ': ' || trim(p_reason)
                end
   where id = p_request_id
   returning * into v_request;

  -- Only an approved request ever consumed days, so only that one refunds,
  -- to the balance year the leave fell in.
  if v_previous = 'approved' then
    update leave_balances
       set used = greatest(0, used - v_request.working_days)
     where employee_id = v_request.employee_id
       and leave_type = v_request.leave_type
       and leave_year_start = public.leave_type_year_start(v_request.leave_type, v_request.starts_on);
  end if;

  return v_request;
end; $$;

-- ---------------------------------------------------------------------------
-- Changing dates: cancel the original, file a new pending request.
-- ---------------------------------------------------------------------------

create or replace function public.change_leave_request_dates(
  p_request_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_note text default null
) returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_existing public.leave_requests;
  v_request public.leave_requests;
  v_was text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_existing from leave_requests where id = p_request_id for update;
  if v_existing.id is null or v_existing.employee_id <> auth.uid() then
    raise exception 'Leave request not found';
  end if;
  if v_existing.leave_type <> 'annual' then
    raise exception 'Only annual leave can be changed from the app.';
  end if;
  if v_existing.status not in ('pending', 'approved') then
    raise exception 'This request is %, so its dates can''t be changed. Make a new request instead.', v_existing.status;
  end if;
  if v_existing.starts_on <= current_date then
    raise exception 'This leave has already started, so its dates can''t be changed from the app. Ask your manager or HR.';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on then
    raise exception 'Choose a start date and an end date on or after it.';
  end if;
  if p_starts_on < current_date then
    raise exception 'The new dates can''t be in the past.';
  end if;
  if p_starts_on = v_existing.starts_on and p_ends_on = v_existing.ends_on then
    raise exception 'Those are already the dates of this request.';
  end if;
  if exists (
    select 1 from leave_requests
    where employee_id = v_existing.employee_id and id <> v_existing.id
      and status in ('pending', 'approved')
      and starts_on <= p_ends_on and ends_on >= p_starts_on
  ) then
    raise exception 'You already have leave booked or requested on some of those dates.';
  end if;

  v_was := to_char(v_existing.starts_on, 'DD Mon YYYY') || ' – ' || to_char(v_existing.ends_on, 'DD Mon YYYY');

  update leave_requests
     set status = 'cancelled',
         note = concat_ws(E'\n\n', nullif(note, ''),
                  'Changed by the employee to ' || to_char(p_starts_on, 'DD Mon YYYY') || ' – ' || to_char(p_ends_on, 'DD Mon YYYY') || '.')
   where id = v_existing.id;

  if v_existing.status = 'approved' then
    update leave_balances
       set used = greatest(0, used - v_existing.working_days)
     where employee_id = v_existing.employee_id
       and leave_type = 'annual'
       and leave_year_start = public.leave_type_year_start('annual', v_existing.starts_on);
  end if;

  -- validate_leave_request runs on this insert exactly as for a new request.
  insert into leave_requests (employee_id, leave_type, starts_on, ends_on, note, status)
    values (
      v_existing.employee_id, 'annual', p_starts_on, p_ends_on,
      concat_ws(E'\n\n',
        coalesce(nullif(trim(coalesce(p_note, '')), ''), nullif(v_existing.note, '')),
        'Changed from ' || v_was || ' (was ' || v_existing.status || ').'),
      'pending')
    returning * into v_request;

  return v_request;
end; $$;

revoke all on function public.change_leave_request_dates(uuid, date, date, text) from public, anon;
grant execute on function public.change_leave_request_dates(uuid, date, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Recording on someone's behalf: a manager or lead can't book annual leave
-- below zero directly -- it's left pending for HR instead.
-- ---------------------------------------------------------------------------

create or replace function public.record_leave_for_employee(
  p_employee_id uuid,
  p_leave_type text,
  p_starts_on date,
  p_ends_on date,
  p_note text
) returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_needs_hr boolean := false;
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

  -- Inserted as pending so validate_leave_request (balance, qualification,
  -- deactivated, working_days) runs exactly as for an employee's own request.
  insert into leave_requests (employee_id, leave_type, starts_on, ends_on, note, status, recorded_by)
    values (p_employee_id, p_leave_type, p_starts_on, p_ends_on, nullif(trim(coalesce(p_note, '')), ''), 'pending', auth.uid())
    returning * into v_request;

  if p_leave_type = 'annual' and not public.current_role_is(array['hr_admin']) then
    v_needs_hr := v_request.working_days > coalesce(public.annual_leave_available(p_employee_id), 0);
  end if;

  -- Sick leave stays pending until its medical certificate is uploaded and it's
  -- approved, and annual leave below zero waits for HR; everything else is
  -- booked straight away.
  if p_leave_type <> 'medical' and not v_needs_hr then
    update leave_requests set status = 'approved' where id = v_request.id returning * into v_request;
    update leave_balances set used = used + v_request.working_days
      where employee_id = p_employee_id and leave_type = p_leave_type
        and leave_year_start = public.leave_type_year_start(p_leave_type, p_starts_on);
  end if;

  -- They're not working those days any more. A shift on the bank holiday
  -- itself is kept: it isn't part of the leave and someone may be covering.
  delete from roster_shifts
    where employee_id = p_employee_id and shift_date between p_starts_on and p_ends_on
      and not exists (select 1 from holidays where holiday_date = shift_date);
  delete from roster_days_off where employee_id = p_employee_id and off_date between p_starts_on and p_ends_on;

  return v_request;
end; $$;

-- ---------------------------------------------------------------------------
-- HR balance editing: annual "remaining" may be negative.
-- ---------------------------------------------------------------------------

create or replace function public.set_leave_balance(
  p_employee_id uuid,
  p_leave_type text,
  p_entitlement numeric,
  p_used numeric,
  p_remaining numeric
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_year date := public.leave_type_year_start(p_leave_type, current_date);
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
  if p_remaining is not null and p_remaining < 0 and p_leave_type <> 'annual' then
    raise exception 'Remaining days must be zero or more';
  end if;
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
    v_accrued := public.leave_accrued(p_leave_type, p_entitlement, v_year, v_start, current_date);
    update leave_balances
      set adjustment = p_remaining - v_accrued + p_used
      where employee_id = p_employee_id and leave_type = p_leave_type and leave_year_start = v_year;
  end if;
end; $$;

create or replace function public.set_opening_leave_balance(
  p_employee_id uuid,
  p_leave_type text,
  p_remaining numeric,
  p_entitlement numeric
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_year date := public.leave_type_year_start(p_leave_type, current_date);
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
  if p_remaining is null then raise exception 'Enter the remaining days'; end if;
  if p_remaining < 0 and p_leave_type <> 'annual' then raise exception 'Remaining days must be zero or more'; end if;
  if p_entitlement is not null and p_entitlement < 0 then raise exception 'Entitlement must be zero or more'; end if;

  select start_date into v_start from profiles where id = p_employee_id;
  if v_start is null then raise exception 'Employee not found'; end if;

  insert into leave_balances (employee_id, leave_type, leave_year_start, entitlement)
    values (p_employee_id, p_leave_type, v_year, coalesce(p_entitlement,
      case when p_leave_type = 'medical' then public.default_sick_entitlement(p_employee_id, v_year) else 0 end))
    on conflict (employee_id, leave_type, leave_year_start)
      do update set entitlement = coalesce(p_entitlement, leave_balances.entitlement);

  select entitlement, used into v_entitlement, v_used
    from leave_balances
    where employee_id = p_employee_id and leave_type = p_leave_type and leave_year_start = v_year
    for update;

  -- Someone who hasn't reached 13 weeks has no paid sick days yet, whatever an
  -- old spreadsheet says; they get the full allowance on qualifying.
  if p_leave_type = 'medical' and current_date < public.sick_leave_qualifying_date(v_start) then
    update leave_balances set adjustment = 0
      where employee_id = p_employee_id and leave_type = p_leave_type and leave_year_start = v_year;
    return;
  end if;

  v_accrued := public.leave_accrued(p_leave_type, v_entitlement, v_year, v_start, current_date);

  -- available = (accrued + adjustment) - used  =>  adjustment = remaining - accrued + used
  update leave_balances
    set adjustment = p_remaining - v_accrued + v_used
    where employee_id = p_employee_id and leave_type = p_leave_type and leave_year_start = v_year;
end; $$;
