-- 0008_itsupport_staff_access (up)
--
-- Phase 5 built-in helpdesk (plan §6.3.1, P5-T11a): staff READ access on the
-- SHARED Supabase stack. A signed-in user (`authenticated`) reads only while
-- an active itsupport.staff row has its auth.uid() (G6): one select policy per
-- table on is_staff(), and column grants that leave out raw text, requester
-- data, idempotency keys, the redaction log, kb content, staff email and auth
-- ID, and the Slack and wait-token columns of reviews (G8). ticket_number is
-- granted (display only). No insert, update or delete for `authenticated`: staff
-- write only through the staff_* functions at the end (P5-T11b).
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
as $$ select id from itsupport.staff where auth_user_id = auth.uid() and active $$;
create or replace function itsupport.is_staff() returns boolean
  language sql stable security definer set search_path = ''
as $$ select itsupport.current_staff() is not null $$;
create or replace function itsupport.is_admin() returns boolean
  language sql stable security definer set search_path = ''
as $$ select exists (select 1 from itsupport.staff
  where auth_user_id = auth.uid() and active and role = 'admin') $$;
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

-- Staff actions (P5-T11b, G5): the only staff writes. Each one finds the caller
-- (no active staff row: 42501), locks the helpdesk ticket (unknown: P0002),
-- checks its rule, writes its row and one ticket_events row (IDs only, never
-- note text) and sets updated_at, all in the caller's one transaction.
create or replace function itsupport.staff_add_note(helpdesk_ticket_id uuid, body text)
  returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := itsupport.current_staff();
  ticket uuid;
  note_id uuid;
begin
  if me is null then raise exception 'not active staff' using errcode = '42501'; end if;
  select ticket_id into ticket from itsupport.helpdesk_tickets
    where id = helpdesk_ticket_id for update;
  if not found then raise exception 'helpdesk ticket not found' using errcode = 'P0002'; end if;
  -- The body check (1 to 5000 characters) is the table's: 23514.
  insert into itsupport.helpdesk_notes (helpdesk_ticket_id, author_kind, author_staff_id, body)
    values (helpdesk_ticket_id, 'staff', me, body) returning id into note_id;
  update itsupport.helpdesk_tickets set updated_at = now() where id = helpdesk_ticket_id;
  insert into itsupport.ticket_events (ticket_id, type, payload) values (ticket,
    'staff_note_added', jsonb_build_object('noteId', note_id, 'staffId', me));
  return note_id;
end $$;
revoke all on function itsupport.staff_add_note(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function itsupport.staff_add_note(uuid, text) to authenticated;

create or replace function itsupport.staff_assign(helpdesk_ticket_id uuid, assignee_id uuid)
  returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := itsupport.current_staff();
  assignee uuid := assignee_id;
  ticket uuid;
  assignment_id uuid;
begin
  if me is null then raise exception 'not active staff' using errcode = '42501'; end if;
  select ticket_id into ticket from itsupport.helpdesk_tickets
    where id = helpdesk_ticket_id for update;
  if not found then raise exception 'helpdesk ticket not found' using errcode = 'P0002'; end if;
  -- for share: the assignee cannot be deactivated until this commits.
  perform from itsupport.staff where id = assignee and active for share;
  if not found then raise exception 'assignee is not active staff' using errcode = '22023'; end if;
  insert into itsupport.helpdesk_assignments (helpdesk_ticket_id, assignee_id, assigned_by_staff_id)
    values (helpdesk_ticket_id, assignee, me) returning id into assignment_id;
  update itsupport.helpdesk_tickets set assignee_id = assignee, updated_at = now()
    where id = helpdesk_ticket_id;
  insert into itsupport.ticket_events (ticket_id, type, payload) values (ticket, 'staff_assigned',
    jsonb_build_object('helpdeskTicketId', helpdesk_ticket_id, 'staffId', me, 'assigneeId', assignee));
  return assignment_id;
end $$;
revoke all on function itsupport.staff_assign(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function itsupport.staff_assign(uuid, uuid) to authenticated;
