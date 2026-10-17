-- who_is_on_leave_today() (20260823) was only granted to authenticated, never
-- revoked from anon. Supabase's default privileges grant EXECUTE to anon on
-- every new function (see 20260912/20260913), and the function is security
-- definer with no caller check, so anyone with the public anon key could list
-- the names of everyone on leave today -- including who is on sick leave,
-- which since 20261021 means certified statutory sick leave (health data).
--
-- Now:
--   * anon can't call it, and the body returns nothing without a signed-in,
--     active caller (belt and braces in case a grant is re-added).
--   * Sick leave is shown as plain 'leave' to colleagues. Only HR and the
--     person's own supervisors (or the person themself) see 'medical'.
--
-- Same (no-argument) signature, so create or replace replaces it.

create or replace function public.who_is_on_leave_today()
returns table(employee_name text, leave_type text)
language sql stable security definer set search_path = public as $$
  select
    p.full_name,
    case
      when lr.leave_type = 'medical'
       and not (lr.employee_id = auth.uid()
                or public.current_role_is(array['hr_admin'])
                or public.can_supervise(lr.employee_id))
        then 'leave'
      else lr.leave_type
    end
  from leave_requests lr
  join profiles p on p.id = lr.employee_id
  where lr.status = 'approved' and current_date between lr.starts_on and lr.ends_on
    and exists (select 1 from profiles me where me.id = auth.uid() and me.active)
  order by p.full_name;
$$;

revoke all on function public.who_is_on_leave_today() from public, anon;
grant execute on function public.who_is_on_leave_today() to authenticated;
