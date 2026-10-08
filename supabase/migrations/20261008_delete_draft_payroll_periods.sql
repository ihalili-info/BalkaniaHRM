-- Deleting payroll periods, limited to drafts.
--
-- The original policy "hr admin delete payroll periods" allowed HR to delete a
-- period in ANY status, and the delete cascades to payslips and their line
-- items -- so a finalized or paid period (and the payslip history employees
-- were paid from) could be wiped with a direct API call. Narrow it to drafts.

drop policy "hr admin delete payroll periods" on public.payroll_periods;
create policy "hr admin delete draft payroll periods" on public.payroll_periods
  for delete to authenticated
  using (public.current_role_is(array['hr_admin']) and status = 'draft');

-- The admin UI goes through this RPC rather than a table delete so a refused
-- delete returns a clear reason (a policy-filtered delete just affects 0 rows
-- silently). Same shape as finalize_payroll_period / mark_payroll_period_paid.
create or replace function public.delete_payroll_period(p_period_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_period public.payroll_periods;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not public.current_role_is(array['hr_admin']) then
    raise exception 'Only HR administrators can delete a payroll period';
  end if;

  select * into v_period from payroll_periods where id = p_period_id for update;
  if v_period is null then raise exception 'Payroll period not found'; end if;
  if v_period.status <> 'draft' then
    raise exception 'Only a draft period can be deleted. Finalized and paid periods are kept as the payroll record.';
  end if;

  -- Cascades to payslips and payslip_line_items.
  delete from payroll_periods where id = p_period_id;
end; $$;

revoke all on function public.delete_payroll_period(uuid) from public, anon;
grant execute on function public.delete_payroll_period(uuid) to authenticated;
