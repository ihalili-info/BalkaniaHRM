-- Leaving details: when someone leaves, HR records their last day, why they
-- left and any notes, so it's on file after the account is deactivated
-- (references, P45 queries, rehire checks, WRC claims).
--
-- Kept in employee_details rather than profiles: the reason (e.g. dismissal)
-- is sensitive, and managers/team leads read profiles for their teams.
-- employee_details is HR-only to write, HR + the employee themselves to read
-- (20260829_employee_details.sql), which is the right audience.

alter table public.employee_details
  add column leaving_date date,
  add column leaving_reason text
    check (leaving_reason in ('resignation', 'dismissal', 'redundancy', 'end_of_contract', 'retirement', 'other')),
  add column leaving_notes text;
