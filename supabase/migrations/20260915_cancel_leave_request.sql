-- Lets HR withdraw a booked leave request when an employee changes their mind,
-- handing the days back to their balance.
--
-- Implemented as a status change to 'cancelled' rather than a delete: the enum
-- has carried that value since the initial schema without anything ever setting
-- it, and the record has to survive for reporting ("was that leave ever
-- booked?"). The admin UI filters cancelled rows out of the default views, so
-- it reads as a removal without destroying history.

-- current_leave_year_start() is always derived from today, which is wrong for
-- refunds: cancelling leave that was approved in a previous leave year would
-- credit the days to *this* year's balance and inflate it. Leave years run
-- 1 April - 31 March, so resolve the year from the request's own start date.
create or replace function public.leave_year_start_for(p_date date)
returns date language sql immutable as $$
  select case
    when extract(month from p_date) >= 4
      then make_date(extract(year from p_date)::int, 4, 1)
    else make_date(extract(year from p_date)::int - 1, 4, 1)
  end;
$$;

grant execute on function public.leave_year_start_for(date) to authenticated;

create or replace function public.cancel_leave_request(p_request_id uuid, p_reason text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_previous public.leave_request_status;
  v_employee uuid;
  v_days int;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.current_role_is(array['hr_admin']) then
    raise exception 'Only HR administrators can cancel a leave request';
  end if;

  select employee_id, status into v_employee, v_previous
    from leave_requests where id = p_request_id for update;
  if v_employee is null then raise exception 'Leave request not found'; end if;
  if v_previous = 'cancelled' then
    raise exception 'This request is already cancelled.';
  end if;

  update leave_requests
     set status = 'cancelled',
         note = case
                  when nullif(trim(coalesce(p_reason, '')), '') is null then note
                  when note is null or note = '' then 'Cancelled by HR: ' || trim(p_reason)
                  else note || E'\n\nCancelled by HR: ' || trim(p_reason)
                end
   where id = p_request_id
   returning * into v_request;

  -- Only an approved request ever consumed days, so only that one refunds.
  -- Pending and rejected requests never touched the balance.
  if v_previous = 'approved' then
    v_days := (v_request.ends_on - v_request.starts_on + 1);
    update leave_balances
       set used = greatest(0, used - v_days)
     where employee_id = v_request.employee_id
       and leave_type = v_request.leave_type
       and leave_year_start = public.leave_year_start_for(v_request.starts_on);
  end if;

  return v_request;
end; $$;

grant execute on function public.cancel_leave_request(uuid, text) to authenticated;
