-- Read-only: shows which recent migrations look applied on this database,
-- by checking for one object each migration creates. Run in the SQL Editor.
select m.migration, m.marker,
       case when m.present then 'applied' else 'MISSING' end as status
from (values
  ('20260903_leave_accrual_from_hire_date', 'profiles.start_date',                 exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='start_date')),
  ('20260903_leave_accrual_from_hire_date', 'fn leave_accrual_anchor',             to_regprocedure('public.leave_accrual_anchor(date,date)') is not null),
  ('20260906_asset_management',             'table assets',                        to_regclass('public.assets') is not null),
  ('20260907_delete_kiosk_device',          'fn delete_attendance_device',         exists (select 1 from pg_proc where proname='delete_attendance_device')),
  ('20260908_payroll_management',           'table payroll_periods',               to_regclass('public.payroll_periods') is not null),
  ('20260909_geolocation_attendance',       'table attendance_locations',          to_regclass('public.attendance_locations') is not null),
  ('20260910_self_service_attendance',      'profiles.self_service_attendance',    exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='self_service_attendance')),
  ('20260911_team_leads',                   'fn is_team_lead_of',                  exists (select 1 from pg_proc where proname='is_team_lead_of')),
  ('20260914_break_overrun_alerts',         'fn pending_break_alerts',             exists (select 1 from pg_proc where proname='pending_break_alerts')),
  ('20260915_cancel_leave_request',         'fn cancel_leave_request',             exists (select 1 from pg_proc where proname='cancel_leave_request')),
  ('20261008_delete_draft_payroll_periods', 'fn delete_payroll_period',            exists (select 1 from pg_proc where proname='delete_payroll_period')),
  ('20261009_leave_opening_balance',        'leave_balances.adjustment',           exists (select 1 from information_schema.columns where table_schema='public' and table_name='leave_balances' and column_name='adjustment')),
  ('20261009_leave_opening_balance',        'fn set_opening_leave_balance',        exists (select 1 from pg_proc where proname='set_opening_leave_balance')),
  ('20261009_recruitment',                  'table jobs',                          to_regclass('public.jobs') is not null),
  ('20261010_edit_leave_balance',           'fn set_leave_balance',                exists (select 1 from pg_proc where proname='set_leave_balance')),
  ('20261011_shift_rosters',                'a "color" column',  exists (select 1 from information_schema.columns where table_schema='public' and column_name='color')),
  ('20261013_profile_name_parts',           'profiles.first_name',                 exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='first_name')),
  ('20261013_public_careers',               'fn list_public_jobs',                 exists (select 1 from pg_proc where proname='list_public_jobs'))
) as m(migration, marker, present)
order by m.migration;
