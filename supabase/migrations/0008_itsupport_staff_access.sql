-- 0008_itsupport_staff_access (up)
--
-- Phase 5 built-in helpdesk (plan §6.3.1, P5-T11a): staff READ access on the
-- SHARED Supabase stack. A signed-in user (`authenticated`) reads only while
-- an active itsupport.staff row has its auth.uid() (G6): one select policy per
-- table on is_staff(), and column grants that leave out raw text, requester
-- data, idempotency keys, the redaction log, kb content, staff email and auth
-- ID, and the Slack and wait-token columns of reviews (G8). ticket_number is
-- granted (display only). No insert, update or delete for `authenticated`.
-- Touches only the `itsupport` schema. Requires 0001 to 0007. Idempotent.
-- Reverse with 0008_itsupport_staff_access.down.sql; verify with
-- supabase/checks/0008_itsupport_staff_access.check.sql.
-- Applying this to the shared Supabase database is human step H28b.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- Locks wait at most 5 s: on 55P03 nothing was applied; wait and re-run.

set local lock_timeout = '5s';

grant usage on schema itsupport to authenticated;

-- The caller's active staff ID; null with no JWT, no staff row or an inactive one.
create or replace function itsupport.current_staff() returns uuid
  language sql stable security definer set search_path = ''
as $$ select s.id from itsupport.staff s where s.auth_user_id = auth.uid() and s.active $$;
create or replace function itsupport.is_staff() returns boolean
  language sql stable security definer set search_path = ''
as $$ select itsupport.current_staff() is not null $$;
create or replace function itsupport.is_admin() returns boolean
  language sql stable security definer set search_path = ''
as $$ select exists (select 1 from itsupport.staff s
  where s.auth_user_id = auth.uid() and s.active and s.role = 'admin') $$;
revoke all on function itsupport.current_staff(), itsupport.is_staff(), itsupport.is_admin()
  from public, anon, authenticated, service_role;
grant execute on function itsupport.current_staff(), itsupport.is_staff(), itsupport.is_admin()
  to authenticated;

-- Revoke first (it also drops column grants), so a re-run leaves exactly this set.
revoke all on table itsupport.tickets, itsupport.ticket_redactions, itsupport.triage_results,
  itsupport.ticket_events, itsupport.reviews, itsupport.kb_articles, itsupport.staff,
  itsupport.helpdesk_tickets, itsupport.helpdesk_notes, itsupport.helpdesk_assignments,
  itsupport.helpdesk_state_transitions from authenticated;
grant select (id, source, department, status, servicenow_sys_id, servicenow_number, created_at,
  is_test, ticket_number, helpdesk) on itsupport.tickets to authenticated;
grant select (ticket_id, redacted_title, redacted_description, created_at)
  on itsupport.ticket_redactions to authenticated;
grant select (ticket_id, sensitive, sensitive_flags, checker, created_at, category, subcategory,
  priority, urgency, assignment_group, route, probabilities, flags, grounding_score,
  kb_article_ids, suggested_fix, model_versions, triaged_at) on itsupport.triage_results to authenticated;
grant select (id, ticket_id, type, payload, at) on itsupport.ticket_events to authenticated;
grant select (id, ticket_id, kind, proposal_id, decision, decided_at, created_at, staff_id)
  on itsupport.reviews to authenticated;
grant select (id, slug, title) on itsupport.kb_articles to authenticated;
grant select (id, display_name, role, active) on itsupport.staff to authenticated;
grant select on table itsupport.helpdesk_tickets, itsupport.helpdesk_notes,
  itsupport.helpdesk_assignments, itsupport.helpdesk_state_transitions to authenticated;

-- RLS is already on for every table (0001 to 0007). One select policy each.
do $$
declare t text;
begin
  foreach t in array array['tickets', 'ticket_redactions', 'triage_results', 'ticket_events',
    'reviews', 'kb_articles', 'staff', 'helpdesk_tickets', 'helpdesk_notes',
    'helpdesk_assignments', 'helpdesk_state_transitions'] loop
    execute format('drop policy if exists %I on itsupport.%I', t || '_staff_select', t);
    execute format('create policy %I on itsupport.%I for select to authenticated'
      ' using (itsupport.is_staff())', t || '_staff_select', t);
  end loop;
end $$;
