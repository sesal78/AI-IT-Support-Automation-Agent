-- grant-staff (human step H30, plan §6.3.1 G7 and G10). Gives an invited
-- Supabase Auth user built-in helpdesk access: adds or updates their
-- itsupport.staff row. Run it only after 0007 and 0008 are applied (H28b) and
-- the user has been invited in Supabase Auth.
--
-- 1. Edit the three values below: email, display name, role (agent or admin).
-- 2. Run the whole file as ONE transaction (Supabase Studio does; with psql use
--    --single-transaction). On an error nothing is written.
--
-- Reads auth.users (read-only) to find the user ID by email. Writes only
-- itsupport.staff. Safe to run again: it updates the same row and sets it
-- active. The last statement prints the row.

select set_config('grant_staff.email', 'person@example.com', true),
  set_config('grant_staff.display_name', 'Display Name', true),
  set_config('grant_staff.role', 'agent', true);

do $$
declare
  v_email text := lower(btrim(current_setting('grant_staff.email')));
  v_name text := btrim(current_setting('grant_staff.display_name'));
  v_role text := current_setting('grant_staff.role');
  v_user uuid;
begin
  -- Messages never echo the values (an email is personal data).
  if v_role !~ '^(agent|admin)$' then
    raise exception 'role must be agent or admin' using errcode = '22023';
  end if;
  if v_name = '' then
    raise exception 'display name is empty' using errcode = '22023';
  end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if not found then
    raise exception 'no Supabase Auth user has this email; invite the user first'
      using errcode = 'P0002';
  end if;
  insert into itsupport.staff (auth_user_id, email, display_name, role)
    values (v_user, v_email, v_name, v_role)
  on conflict (auth_user_id) do update
    set email = excluded.email, display_name = excluded.display_name,
      role = excluded.role, active = true;
end $$;

select id, auth_user_id, email, display_name, role, active, created_at
from itsupport.staff where email = lower(btrim(current_setting('grant_staff.email')));
