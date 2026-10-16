-- One-off: set up the Operations structure (run after
-- 20261018_team_hierarchy_and_multiple_leads.sql).
--
--   Operations  manager Max Murashov, no leads
--   ├─ Warehouse  manager Arunas Nesavas; leads Alex Mathasseril Thomas, Ahmed Hassan
--   └─ Transport  manager Max Murashov; lead Shkelqim Maloku
--
-- Looks people up by name and stops if any name doesn't match exactly one
-- active profile, so nothing is half-applied.

do $$
declare
  v_ops uuid;
  v_warehouse uuid;
  v_transport uuid;
  v_max uuid;
  v_arunas uuid;
  v_alex uuid;
  v_ahmed uuid;
  v_shkelqim uuid;
begin
  select id into strict v_ops from teams where name = 'Operations';
  select id into strict v_warehouse from teams where name = 'Warehouse';
  select id into strict v_transport from teams where name = 'Transport';

  select id into strict v_max from profiles where full_name = 'Max Murashov' and active;
  select id into strict v_arunas from profiles where full_name = 'Arunas Nesavas' and active;
  select id into strict v_alex from profiles where full_name = 'Alex Mathasseril Thomas' and active;
  select id into strict v_ahmed from profiles where full_name = 'Ahmed Hassan' and active;
  select id into strict v_shkelqim from profiles where full_name = 'Shkelqim Maloku' and active;

  -- Roles
  update profiles set role = 'manager' where id = v_arunas;
  update profiles set role = 'team_lead' where id in (v_alex, v_ahmed, v_shkelqim);

  -- Hierarchy and managers
  update teams set manager_id = v_max, parent_team_id = null where id = v_ops;
  update teams set manager_id = v_arunas, parent_team_id = v_ops where id = v_warehouse;
  update teams set manager_id = v_max, parent_team_id = v_ops where id = v_transport;

  -- Leads
  delete from team_leads where team_id in (v_ops, v_warehouse, v_transport);
  insert into team_leads (team_id, employee_id) values
    (v_warehouse, v_alex),
    (v_warehouse, v_ahmed),
    (v_transport, v_shkelqim);
end $$;

-- Check
select t.name as team, parent.name as under, m.full_name as manager,
       (select string_agg(p.full_name, ', ' order by p.full_name) from team_leads tl join profiles p on p.id = tl.employee_id where tl.team_id = t.id) as leads
from teams t
left join teams parent on parent.id = t.parent_team_id
left join profiles m on m.id = t.manager_id
order by coalesce(parent.name, t.name), parent.name nulls first, t.name;
