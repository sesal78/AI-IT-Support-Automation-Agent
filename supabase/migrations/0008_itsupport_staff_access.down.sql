-- 0008_itsupport_staff_access (down)
--
-- Removes only what 0008 added: the 11 `_staff_select` policies, every
-- `authenticated` right on those tables (0001 to 0007 grant it none), the
-- functions current_staff(), is_staff() and is_admin(), and schema usage for
-- `authenticated` (0001 revokes it). No row is touched. Safe to run more than once.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.

set local lock_timeout = '5s';

do $$
declare t text;
begin
  foreach t in array array['tickets', 'ticket_redactions', 'triage_results', 'ticket_events',
    'reviews', 'kb_articles', 'staff', 'helpdesk_tickets', 'helpdesk_notes',
    'helpdesk_assignments', 'helpdesk_state_transitions'] loop
    execute format('drop policy if exists %I on itsupport.%I', t || '_staff_select', t);
    execute format('revoke all on table itsupport.%I from authenticated', t);
  end loop;
end $$;
drop function if exists itsupport.is_admin(), itsupport.is_staff(), itsupport.current_staff();
revoke usage on schema itsupport from authenticated;
