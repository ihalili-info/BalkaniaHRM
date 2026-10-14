-- One-off import of leave balances from the HR spreadsheet (end of September 2026).
-- Paste the WHOLE file into the Supabase SQL Editor and run it. Not a migration:
-- this is data, not schema.
--
-- Safe to re-run: every run recomputes the same balances from the figures below.
-- Rows whose name doesn't match an employee are SKIPPED (nothing written for
-- them) and listed at the top of the final report with suggested employees.
-- To fix one, change its name in the list below to exactly the employee's name
-- as shown in the app, then run the file again.
--
--   "End of September holiday earned" -> annual leave REMAINING as of 30 Sep 2026.
--      Stored the same way set_opening_leave_balance() does it (an adjustment on
--      top of accrual), but pinned to 30 Sep instead of today, so October's
--      monthly accrual is added on top automatically. Negative figures are kept.
--   "Used medical leaves" -> medical leave USED this leave year (overwrites).
--
-- Names below are as they appear in the app (imported 14 Oct 2026 via MCP).
-- Not yet in the app, so left out: Serhii Bandurko 3.34/0, Corneliu Cimpan -1.30/0,
-- Hazratullah Omari 34.06/0 (annual remaining / medical used).
--
-- Entitlements (days/year) are NOT changed. Anyone with no annual allowance set
-- is flagged in the report: they keep the imported figure but accrue nothing more.

drop table if exists public._leave_import;
create table public._leave_import (
  row_no int primary key,
  name text not null,
  annual_remaining numeric(6,2) not null,
  medical_used numeric(6,2) not null,
  employee_id uuid references public.profiles(id)
);
-- RLS on with no policies: the staging table is invisible to the API.
alter table public._leave_import enable row level security;

insert into public._leave_import (row_no, name, annual_remaining, medical_used) values
  ( 1, 'Fahim Alhalal',             14.24, 4),
  ( 2, 'Muhammad Alvi',             13.49, 0),
  ( 3, 'Zaman Ayaz',                10.04, 2),
  ( 4, 'Zabiullah Azizi',           10.72, 5),
  ( 6, 'Boestean Eugeniu',           1.25, 0),
  ( 8, 'Grigore Cociug',             2.92, 0),
  ( 9, 'Maxin Crestin',             -0.95, 5),
  (10, 'Aziza Dip',                  1.44, 5),
  (11, 'Abdinasir Mohamed Edle',    21.40, 5),
  (12, 'Mohammad Qahir',             5.84, 0),
  (13, 'Sallieu Freeman',            5.94, 3),
  (14, 'Haqmal Tariq',              14.42, 3),
  (15, 'Ahmed Hassan',              10.02, 2),
  (16, 'Ahmed Ibrahim',              1.02, 2),
  (17, 'Sachin Joya',               13.73, 0),
  (18, 'Deborah Kelly',             12.24, 0),
  (19, 'Medion Kerri',               0.40, 1),
  (20, 'Shabran Khan',              19.72, 0),
  (21, 'Rohit Raju Maleparambil',    0.84, 0),
  (22, 'Kimi',                      -4.72, 0),
  (23, 'Mohamed Ali Maow',          10.57, 0),
  (24, 'Max Murashov',               4.59, 0),
  (25, 'Gaiduk Mykola',              0.42, 0),
  (26, 'Khaista Gul Niazai',        13.21, 5),
  (27, 'Michael Okonkwo',           15.54, 5),
  (29, 'Roland George',             16.64, 1),
  (30, 'Arjun Panicker',            30.94, 1),
  (31, 'Mihail Radulescu',           0.00, 0),
  (32, 'Razi Rehman',               10.82, 0),
  (33, 'Israr Safdar',               3.55, 1),
  (34, 'Hadi Salihu',                7.44, 0),
  (35, 'Mojtaba Shahafv',            0.40, 0),
  (36, 'Jan Muhammad Sharifi',       6.35, 5),
  (37, 'Tribhuwan Sharma',           5.74, 0),
  (38, 'Alex Mathasseril Thomas',   10.12, 2),
  (39, 'Viorel Ungurean',           -1.73, 0),
  (40, 'Sadegh Valleh',              2.74, 2),
  (41, 'Eduard Vardanyan',           2.07, 0),
  (42, 'Joao Vaz',                   5.84, 0);

-- Match on full name (case/whitespace-insensitive), also accepting
-- "Surname Firstname" order (e.g. "Gaiduk Mykola"). Only unique matches are filled.
with norm as (
  select i.row_no, p.id
  from public._leave_import i
  join public.profiles p
    on lower(regexp_replace(trim(p.full_name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(i.name), '\s+', ' ', 'g'))
    or lower(regexp_replace(trim(concat_ws(' ', p.last_name, p.first_name)), '\s+', ' ', 'g')) = lower(regexp_replace(trim(i.name), '\s+', ' ', 'g'))
),
uniq as (
  select row_no, min(id::text)::uuid as id from norm group by row_no having count(distinct id) = 1
)
update public._leave_import i set employee_id = u.id from uniq u where u.row_no = i.row_no;

-- Apply to matched rows only.
do $$
declare
  v_as_of date := date '2026-09-30';   -- the date the spreadsheet figures are "as of"
  v_year date := public.current_leave_year_start();
  v_dupes text;
begin
  select string_agg(name, ', ') into v_dupes from public._leave_import
    where employee_id in (select employee_id from public._leave_import where employee_id is not null
                          group by employee_id having count(*) > 1);
  if v_dupes is not null then
    raise exception 'These spreadsheet rows point at the same employee: %', v_dupes;
  end if;

  -- Make sure both balance rows exist for the current leave year.
  insert into public.leave_balances (employee_id, leave_type, leave_year_start)
    select i.employee_id, t.leave_type, v_year
    from public._leave_import i cross join (values ('annual'), ('medical')) t(leave_type)
    where i.employee_id is not null
    on conflict (employee_id, leave_type, leave_year_start) do nothing;

  -- Annual: available on v_as_of (accrued_to_as_of + adjustment - used) = spreadsheet figure.
  update public.leave_balances lb
    set adjustment = i.annual_remaining + lb.used - round(
      lb.entitlement * least(12, greatest(0,
        (extract(year from v_as_of) - extract(year from public.leave_accrual_anchor(lb.leave_year_start, p.start_date))) * 12
        + (extract(month from v_as_of) - extract(month from public.leave_accrual_anchor(lb.leave_year_start, p.start_date))) + 1
      )) / 12.0, 2)
  from public._leave_import i
  join public.profiles p on p.id = i.employee_id
  where lb.employee_id = i.employee_id and lb.leave_type = 'annual' and lb.leave_year_start = v_year;

  -- Medical: days used this leave year.
  update public.leave_balances lb
    set used = i.medical_used
  from public._leave_import i
  where lb.employee_id = i.employee_id and lb.leave_type = 'medical' and lb.leave_year_start = v_year;
end $$;

-- REPORT: unmatched rows first (with suggested employees), then imported rows.
-- Suggestions = employees not already matched who share a name word
-- (first 4 letters, so small spelling differences still show up).
with words as (
  select i.row_no, w
  from public._leave_import i, regexp_split_to_table(lower(i.name), '\s+') w
  where i.employee_id is null and length(w) >= 3
),
suggestions as (
  select row_no, string_agg(full_name || case when not active then ' (deactivated)' else '' end, ' | ' order by hits desc, full_name) as suggested
  from (
    select w.row_no, p.full_name, p.active, count(*) as hits
    from words w
    join public.profiles p on lower(p.full_name) ~ ('\m' || left(w.w, 4))
    where p.id not in (select employee_id from public._leave_import where employee_id is not null)
    group by w.row_no, p.id, p.full_name, p.active
  ) s
  group by row_no
)
select
  i.row_no,
  i.name as spreadsheet_name,
  case
    when i.employee_id is null then 'SKIPPED - no matching employee'
    when not p.active then 'imported, but employee is deactivated'
    when a.entitlement = 0 then 'imported, but no annual allowance set - will not accrue'
    else 'imported'
  end as status,
  coalesce(p.full_name, s.suggested, '(no similar employee - may not exist in the app)') as employee_or_suggestions,
  i.annual_remaining as annual_end_sept,
  a.earned - a.used as annual_available_today,
  i.medical_used,
  m.used as medical_used_now
from public._leave_import i
left join public.profiles p on p.id = i.employee_id
left join suggestions s on s.row_no = i.row_no
left join public.leave_balances_current a on a.employee_id = i.employee_id and a.leave_type = 'annual'
left join public.leave_balances_current m on m.employee_id = i.employee_id and m.leave_type = 'medical'
order by (i.employee_id is null) desc, i.row_no;

-- When everything is imported:
--   drop table public._leave_import;
