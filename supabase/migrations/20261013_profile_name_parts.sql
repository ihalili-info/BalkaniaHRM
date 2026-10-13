-- Separate Name and Surname on profiles, for exports to payroll and other
-- systems that need them as two fields.
--
-- full_name stays the display name everywhere (embeds, kiosk, RPCs), and a
-- trigger keeps the three columns consistent, so existing writers keep working:
--   * first_name / last_name changed -> full_name is rebuilt from them
--   * only full_name changed         -> it is split into first_name / last_name
-- A split puts the first word in first_name and the rest in last_name, so
-- "Seán Ó Briain" -> "Seán" / "Ó Briain". A middle name ends up in last_name;
-- HR can fix those in the employee form.

alter table public.profiles add column first_name text, add column last_name text;

create or replace function public.sync_profile_name_parts()
returns trigger language plpgsql set search_path = public as $$
declare
  v_full text;
begin
  new.first_name := nullif(regexp_replace(trim(new.first_name), '\s+', ' ', 'g'), '');
  new.last_name := nullif(regexp_replace(trim(new.last_name), '\s+', ' ', 'g'), '');

  if (tg_op = 'INSERT' and (new.first_name is not null or new.last_name is not null))
     or (tg_op = 'UPDATE' and (new.first_name is distinct from old.first_name or new.last_name is distinct from old.last_name)) then
    new.full_name := nullif(concat_ws(' ', new.first_name, new.last_name), '');
  elsif tg_op = 'INSERT' or new.full_name is distinct from old.full_name then
    v_full := regexp_replace(trim(new.full_name), '\s+', ' ', 'g');
    new.first_name := nullif(split_part(v_full, ' ', 1), '');
    new.last_name := nullif(trim(substr(v_full, length(split_part(v_full, ' ', 1)) + 1)), '');
  end if;
  return new;
end; $$;

create trigger profiles_sync_name_parts
  before insert or update of full_name, first_name, last_name on public.profiles
  for each row execute function public.sync_profile_name_parts();

-- Backfill existing staff with the same split rule.
update public.profiles
  set first_name = nullif(split_part(regexp_replace(trim(full_name), '\s+', ' ', 'g'), ' ', 1), ''),
      last_name = nullif(trim(substr(
        regexp_replace(trim(full_name), '\s+', ' ', 'g'),
        length(split_part(regexp_replace(trim(full_name), '\s+', ' ', 'g'), ' ', 1)) + 1
      )), '');
