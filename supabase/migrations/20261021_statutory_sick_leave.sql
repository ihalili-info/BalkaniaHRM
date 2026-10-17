-- Statutory sick leave (Sick Leave Act 2022, Ireland).
--
-- The "medical" balance becomes the statutory sick leave balance:
--
--   * 13-week qualification. No paid sick leave until the employee has 13
--     weeks of continuous service (profiles.start_date + 91 days), checked
--     against the sick day itself, not today. Sick days before that are
--     refused with a message to record them as unpaid leave instead.
--   * Calendar year. Sick leave resets on 1 January and doesn't carry over,
--     unlike annual leave's 1 April leave year. A medical leave_balances row is
--     keyed on 1 January (leave_year_start), and one is created automatically
--     the first time it's needed in a year.
--   * Full allowance once qualified. No 1/12-per-month build-up: the whole
--     entitlement is available from the qualifying date. The entitlement can't
--     go below the statutory 5 days; HR may set it higher.
--   * Working days only. Like annual leave, sick leave counts weekdays that
--     aren't bank holidays.
--   * Medical certificate. A sick request can only be approved once a doctor's
--     certificate is uploaded (private medical-certificates bucket, attached
--     with attach_medical_certificate). Supervisor-recorded sick leave stays
--     pending until then. Approved sick leave is therefore always certified.
--   * Statutory sick pay: 70% of daily earnings, capped at EUR 110 a day
--     (statutory_sick_pay_daily_rate / statutory_sick_pay_summary, HR only).
--     Not added to payslips automatically; HR adds the line.
--
-- The statutory numbers live in statutory_sick_days_per_year(),
-- sick_leave_qualifying_date() and statutory_sick_pay_daily_rate(). The Act
-- lets the Minister raise the day count by order, so that's the one to change.
--
-- Function signatures are unchanged from their latest versions (validate
-- 20261020, review/cancel/record 20261017, set_leave_balance 20261010,
-- set_opening_leave_balance 20261009), so create or replace replaces them
-- rather than adding overloads.

-- ---------------------------------------------------------------------------
-- 1. Statutory constants and year/accrual helpers
-- ---------------------------------------------------------------------------

create or replace function public.statutory_sick_days_per_year()
returns int language sql immutable as $$
  select 5;
$$;

-- First day paid sick leave applies: after 13 full weeks of continuous service.
create or replace function public.sick_leave_qualifying_date(p_start_date date)
returns date language sql immutable as $$
  select p_start_date + 13 * 7;
$$;

-- Start of the balance year a date falls in, per leave type: 1 January for
-- sick leave, the 1 April leave year for everything else.
create or replace function public.leave_type_year_start(p_leave_type text, p_date date)
returns date language sql immutable as $$
  select case
    when p_leave_type = 'medical' then date_trunc('year', p_date)::date
    else public.leave_year_start_for(p_date)
  end;
$$;

-- Days accrued (before HR's adjustment) on p_on. Sick leave: all or nothing
-- on the qualifying date. Other types: the monthly 1/12 build-up from
-- 20260903, unchanged.
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
      (extract(year from p_on) - extract(year from public.leave_accrual_anchor(p_year_start, p_start_date))) * 12
      + (extract(month from p_on) - extract(month from public.leave_accrual_anchor(p_year_start, p_start_date))) + 1
    )) / 12.0, 2)
  end;
$$;

-- The entitlement a new sick year starts with: last year's (HR may give more
-- than the statutory minimum), never below the statutory days.
create or replace function public.default_sick_entitlement(p_employee_id uuid, p_year_start date)
returns numeric language sql stable set search_path = public as $$
  select greatest(public.statutory_sick_days_per_year(), coalesce((
    select entitlement from leave_balances
    where employee_id = p_employee_id and leave_type = 'medical' and leave_year_start < p_year_start
    order by leave_year_start desc limit 1
  ), 0));
$$;

-- Internal: called from the leave RPCs/trigger, which do their own checks.
create or replace function public.ensure_sick_leave_balance(p_employee_id uuid, p_year_start date)
returns void language sql security definer set search_path = public as $$
  insert into leave_balances (employee_id, leave_type, leave_year_start, entitlement)
  values (p_employee_id, 'medical', p_year_start, public.default_sick_entitlement(p_employee_id, p_year_start))
  on conflict (employee_id, leave_type, leave_year_start) do nothing;
$$;

revoke all on function public.ensure_sick_leave_balance(uuid, date) from public, anon, authenticated;

-- Sick leave counts weekdays only, like annual leave.
create or replace function public.leave_working_days(p_starts_on date, p_ends_on date, p_leave_type text)
returns int language sql stable set search_path = public as $$
  select count(*)::int
  from generate_series(p_starts_on, p_ends_on, interval '1 day') as d(day)
  where not exists (select 1 from holidays where holiday_date = d.day::date)
    and (p_leave_type not in ('annual', 'medical') or extract(isodow from d.day) < 6);
$$;

-- ---------------------------------------------------------------------------
-- 2. Move existing sick balances onto the calendar year
-- ---------------------------------------------------------------------------

-- The current leave year's row becomes this calendar year's. Its "used" is
-- kept as it is (sick days since 1 April); HR should add any Jan-Mar days
-- from before Balkania HRM. An imported opening balance (adjustment <> 0)
-- keeps today's remaining figure; without one, remaining is simply the full
-- allowance minus used.
update public.leave_balances lb
   set entitlement = greatest(lb.entitlement, public.statutory_sick_days_per_year()),
       adjustment = case
         when lb.adjustment = 0 then 0
         else public.leave_accrued('annual', lb.entitlement, lb.leave_year_start, p.start_date, current_date)
              + lb.adjustment
              - public.leave_accrued('medical', greatest(lb.entitlement, public.statutory_sick_days_per_year()),
                                     date_trunc('year', current_date)::date, p.start_date, current_date)
       end,
       leave_year_start = date_trunc('year', current_date)::date
  from public.profiles p
 where p.id = lb.employee_id
   and lb.leave_type = 'medical'
   and lb.leave_year_start = public.current_leave_year_start();

-- Older leave years are history; relabel them to the calendar year they began in.
update public.leave_balances
   set leave_year_start = date_trunc('year', leave_year_start)::date
 where leave_type = 'medical'
   and leave_year_start <> date_trunc('year', leave_year_start)::date;

-- leave_balances.leave_year_start defaults to the April leave year, and the
-- admin entitlement editor upserts without a year. For sick rows, a non-1-Jan
-- date can only have come from that default, so it's moved onto this calendar
-- year. Also holds the statutory minimum.
create or replace function public.apply_sick_leave_balance_rules()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.leave_type <> 'medical' then
    return new;
  end if;
  if new.leave_year_start <> date_trunc('year', new.leave_year_start)::date then
    new.leave_year_start := public.leave_type_year_start('medical', current_date);
  end if;
  if (tg_op = 'INSERT' or new.entitlement is distinct from old.entitlement)
     and new.entitlement < public.statutory_sick_days_per_year() then
    raise exception 'The yearly sick leave allowance can''t be less than the statutory % days.', public.statutory_sick_days_per_year();
  end if;
  return new;
end; $$;

create trigger leave_balances_sick_leave_rules
  before insert or update on public.leave_balances
  for each row execute function public.apply_sick_leave_balance_rules();

-- Same columns as before; each type is filtered to its own current year.
create or replace view public.leave_balances_current as
select
  lb.id,
  lb.employee_id,
  lb.leave_type,
  lb.entitlement,
  lb.used,
  lb.leave_year_start,
  public.leave_accrued(lb.leave_type, lb.entitlement, lb.leave_year_start, p.start_date, current_date) + lb.adjustment as earned
from public.leave_balances lb
join public.profiles p on p.id = lb.employee_id
where lb.leave_year_start = public.leave_type_year_start(lb.leave_type, current_date);

-- ---------------------------------------------------------------------------
-- 3. Medical certificates
-- ---------------------------------------------------------------------------

alter table public.leave_requests
  add column medical_certificate_path text,
  add column medical_certificate_uploaded_at timestamptz,
  add column medical_certificate_uploaded_by uuid references public.profiles(id) on delete set null;

-- Private bucket, objects at "<employee id>/<request id>/<file name>".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'medical-certificates',
  'medical-certificates',
  false,
  10485760, -- 10 MB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

-- Folder names are compared as text so a malformed path can't raise a cast error.
create or replace function public.can_upload_medical_certificate(p_employee_folder text, p_request_folder text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from leave_requests r
    where r.id::text = p_request_folder
      and r.employee_id::text = p_employee_folder
      and r.leave_type = 'medical'
      and r.status <> 'cancelled'
      and (r.employee_id = auth.uid() or public.current_role_is(array['hr_admin']) or public.can_supervise(r.employee_id))
  );
$$;

-- Health data: the employee, HR, and whoever can review their leave.
create or replace function public.can_read_medical_certificate(p_employee_folder text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    where p.id::text = p_employee_folder
      and (p.id = auth.uid() or public.current_role_is(array['hr_admin']) or public.can_supervise(p.id))
  );
$$;

revoke all on function public.can_upload_medical_certificate(text, text) from public, anon;
revoke all on function public.can_read_medical_certificate(text) from public, anon;
grant execute on function public.can_upload_medical_certificate(text, text) to authenticated;
grant execute on function public.can_read_medical_certificate(text) to authenticated;

create policy "read permitted medical certificates" on storage.objects
  for select to authenticated
  using (bucket_id = 'medical-certificates' and public.can_read_medical_certificate((storage.foldername(name))[1]));
create policy "upload medical certificates for own or supervised sick leave" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'medical-certificates'
    and public.can_upload_medical_certificate((storage.foldername(name))[1], (storage.foldername(name))[2])
  );
create policy "hr admin delete medical certificates" on storage.objects
  for delete to authenticated
  using (bucket_id = 'medical-certificates' and public.current_role_is(array['hr_admin']));

-- Points a sick request at an uploaded certificate. A replacement leaves the
-- earlier file in storage as a record.
create or replace function public.attach_medical_certificate(p_request_id uuid, p_path text)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into v_request from leave_requests where id = p_request_id for update;
  if v_request.id is null then raise exception 'Leave request not found'; end if;
  if not (v_request.employee_id = auth.uid() or public.current_role_is(array['hr_admin']) or public.can_supervise(v_request.employee_id)) then
    raise exception 'Not authorized to add a certificate to this request';
  end if;
  if v_request.leave_type <> 'medical' then
    raise exception 'Medical certificates can only be added to sick leave.';
  end if;
  -- Rejected is allowed so a manager can add the certificate and then reverse
  -- the decision to approved.
  if v_request.status = 'cancelled' then
    raise exception 'This sick leave request was cancelled, so a certificate can''t be added.';
  end if;
  if p_path is null or p_path not like v_request.employee_id::text || '/' || v_request.id::text || '/%' then
    raise exception 'The certificate file isn''t stored under this request.';
  end if;
  if not exists (select 1 from storage.objects where bucket_id = 'medical-certificates' and name = p_path) then
    raise exception 'The certificate file wasn''t found. Try uploading it again.';
  end if;

  update leave_requests
     set medical_certificate_path = p_path,
         medical_certificate_uploaded_at = now(),
         medical_certificate_uploaded_by = auth.uid()
   where id = p_request_id
   returning * into v_request;
  return v_request;
end; $$;

revoke all on function public.attach_medical_certificate(uuid, text) from public, anon;
grant execute on function public.attach_medical_certificate(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Booking, approval, cancellation, recording
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

  if v_requested_days > (v_earned - coalesce(v_used, 0)) then
    if new.leave_type = 'medical' then
      raise exception 'This sick leave is % working days, but only % paid sick days are left for %. Record the extra days as unpaid leave.',
        v_requested_days, greatest(0, v_earned - coalesce(v_used, 0)), extract(year from new.starts_on);
    end if;
    raise exception 'This request is % days (%), but only % days of % leave are available to book.',
      v_requested_days,
      case when new.leave_type = 'annual' then 'weekends and bank holidays not counted' else 'bank holidays not counted' end,
      (v_earned - coalesce(v_used, 0)), new.leave_type;
  end if;

  return new;
end; $$;

create or replace function public.review_leave_request(p_request_id uuid, p_status public.leave_request_status, p_comment text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare
  v_request public.leave_requests;
  v_existing public.leave_requests;
  v_previous public.leave_request_status;
  v_days int;
  v_year date;
  v_can_override boolean;
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
    raise exception 'This request was cancelled by the employee and can no longer be reviewed.';
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

  -- Inserted as pending so validate_leave_request (balance, qualification,
  -- deactivated, working_days) runs exactly as for an employee's own request.
  insert into leave_requests (employee_id, leave_type, starts_on, ends_on, note, status, recorded_by)
    values (p_employee_id, p_leave_type, p_starts_on, p_ends_on, nullif(trim(coalesce(p_note, '')), ''), 'pending', auth.uid())
    returning * into v_request;

  -- Sick leave stays pending until its medical certificate is uploaded and it's
  -- approved; everything else is booked straight away.
  if p_leave_type <> 'medical' then
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
-- 5. HR balance editing, on each type's own year
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
  if p_remaining is null or p_remaining < 0 then raise exception 'Remaining days must be zero or more'; end if;
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

-- ---------------------------------------------------------------------------
-- 6. Status for the apps, and sick pay for HR
-- ---------------------------------------------------------------------------

-- Where someone stands for paid sick leave on a given day: used by the
-- employee app for the balance line and to warn before a sick day is declared.
create or replace function public.sick_leave_status(p_employee_id uuid, p_on date)
returns table (
  start_date date,
  qualifies_on date,
  weeks_of_service int,
  qualified boolean,
  year_start date,
  entitlement numeric,
  used numeric,
  remaining numeric
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_start date;
  v_year date := public.leave_type_year_start('medical', p_on);
  v_entitlement numeric;
  v_used numeric;
  v_adjustment numeric;
  v_qualifies_on date;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not (p_employee_id = auth.uid() or public.current_role_is(array['hr_admin']) or public.can_supervise(p_employee_id)) then
    raise exception 'Not authorized to view this sick leave';
  end if;

  select p.start_date into v_start from profiles p where p.id = p_employee_id;
  if v_start is null then raise exception 'Employee not found'; end if;
  v_qualifies_on := public.sick_leave_qualifying_date(v_start);

  select lb.entitlement, lb.used, lb.adjustment into v_entitlement, v_used, v_adjustment
    from leave_balances lb
    where lb.employee_id = p_employee_id and lb.leave_type = 'medical' and lb.leave_year_start = v_year;
  if not found then
    v_entitlement := public.default_sick_entitlement(p_employee_id, v_year);
    v_used := 0;
    v_adjustment := 0;
  end if;

  return query select
    v_start,
    v_qualifies_on,
    greatest(0, (p_on - v_start) / 7),
    p_on >= v_qualifies_on,
    v_year,
    v_entitlement,
    v_used,
    public.leave_accrued('medical', v_entitlement, v_year, v_start, p_on) + v_adjustment - v_used;
end; $$;

revoke all on function public.sick_leave_status(uuid, date) from public, anon;
grant execute on function public.sick_leave_status(uuid, date) to authenticated;

-- Statutory sick pay for one day: 70% of normal daily earnings, at most
-- EUR 110. Salaried: weekly pay over a 5-day week. Hourly: average paid
-- hours per day worked in the 13 weeks before the sick day, times the rate
-- (same hours formula as payroll). Null when no compensation is set up.
create or replace function public.statutory_sick_pay_daily_rate(p_employee_id uuid, p_on date)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  v_comp public.employee_compensation;
  v_hours numeric;
  v_daily numeric;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.current_role_is(array['hr_admin']) then
    raise exception 'Only HR administrators can see sick pay';
  end if;

  select * into v_comp from employee_compensation where employee_id = p_employee_id;
  if v_comp.employee_id is null then return null; end if;

  if v_comp.pay_type = 'salary' then
    v_daily := v_comp.monthly_salary * 12 / 52 / 5;
  else
    select avg(
      greatest(0,
        extract(epoch from (s.clocked_out_at - s.clocked_in_at)) / 3600.0
        - case when s.first_break_started_at is not null and s.first_break_ended_at is not null
               then extract(epoch from (s.first_break_ended_at - s.first_break_started_at)) / 3600.0 else 0 end
        - case when s.lunch_started_at is not null and s.lunch_ended_at is not null
               then extract(epoch from (s.lunch_ended_at - s.lunch_started_at)) / 3600.0 else 0 end
      )
    ) into v_hours
    from attendance_sessions s
    where s.employee_id = p_employee_id
      and s.work_date >= p_on - 13 * 7 and s.work_date < p_on
      and s.clocked_in_at is not null and s.clocked_out_at is not null;
    v_daily := coalesce(v_hours, 0) * v_comp.hourly_rate;
  end if;

  return least(110, round(v_daily * 0.70, 2));
end; $$;

revoke all on function public.statutory_sick_pay_daily_rate(uuid, date) from public, anon;
grant execute on function public.statutory_sick_pay_daily_rate(uuid, date) to authenticated;

-- Per employee for a calendar year: the certified sick days paid as SSP (the
-- first statutory_sick_days_per_year() approved weekdays), what they come to,
-- and today's daily rate. Days beyond the statutory ones (when HR gives a
-- bigger allowance) are company sick pay, not SSP, and aren't counted.
create or replace function public.statutory_sick_pay_summary(p_year int)
returns table (employee_id uuid, ssp_days int, ssp_amount numeric, daily_rate numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.current_role_is(array['hr_admin']) then
    raise exception 'Only HR administrators can see sick pay';
  end if;

  return query
  with sick_days as (
    select r.employee_id as emp, d.day::date as sick_day,
           row_number() over (partition by r.employee_id order by d.day) as n
    from leave_requests r
    cross join lateral generate_series(r.starts_on, r.ends_on, interval '1 day') as d(day)
    where r.leave_type = 'medical' and r.status = 'approved'
      and r.medical_certificate_path is not null
      and r.starts_on >= make_date(p_year, 1, 1) and r.starts_on < make_date(p_year + 1, 1, 1)
      and extract(isodow from d.day) < 6
      and not exists (select 1 from holidays h where h.holiday_date = d.day::date)
  )
  select sd.emp,
         count(*)::int,
         coalesce(sum(public.statutory_sick_pay_daily_rate(sd.emp, sd.sick_day)), 0),
         public.statutory_sick_pay_daily_rate(sd.emp, current_date)
  from sick_days sd
  where sd.n <= public.statutory_sick_days_per_year()
  group by sd.emp;
end; $$;

revoke all on function public.statutory_sick_pay_summary(int) from public, anon;
grant execute on function public.statutory_sick_pay_summary(int) to authenticated;
