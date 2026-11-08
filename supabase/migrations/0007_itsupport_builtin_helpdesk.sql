-- 0007_itsupport_builtin_helpdesk (up)
--
-- Phase 5 built-in helpdesk (plan §6.3.1), part 1: the tables for the AI IT
-- Support agent's own helpdesk, used only with HELPDESK=builtin, on the SHARED
-- Supabase stack. New tables: itsupport.staff (invited staff, role agent or
-- admin), itsupport.helpdesk_tickets (one per ticket, number HD + 7 digits
-- from an identity column), itsupport.helpdesk_notes and
-- itsupport.helpdesk_assignments (both append-only) and
-- itsupport.helpdesk_state_transitions (the G3 state moves). New columns:
-- itsupport.tickets.helpdesk and itsupport.reviews.staff_id. The reviews
-- decider check is replaced: approve and reject name exactly one of
-- slack_user_id and staff_id; timeout and open reviews name neither, so every
-- phase 4 row stays valid. Internal data (docs/PROJECT.md §5). Staff access
-- (policies, functions) is 0008. Touches only the `itsupport` schema.
-- Requires 0001 to 0006.
-- Idempotent: safe to run more than once. Reverse with
-- 0007_itsupport_builtin_helpdesk.down.sql. Verify with
-- supabase/checks/0007_itsupport_builtin_helpdesk.check.sql; after 0007 the
-- 0003 to 0006 checks also stay all ok = true.
-- Applying this to the shared Supabase database is human step H28b.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- Locks wait at most 5 s. Error 55P03 (lock_not_available) means another
-- session held a table: wait and re-run; nothing was applied.
-- The down file is DESTRUCTIVE for the new tables only (every staff row,
-- helpdesk ticket, note and assignment, the transitions, tickets.helpdesk and
-- reviews.staff_id); it needs human approval.
-- The one identity sequence (helpdesk_tickets.seq) is locked as in 0004.

set local lock_timeout = '5s';

-- New tables carry their named constraints inline: `if not exists` skips a
-- re-run, which leaves the first run's definitions (the check query compares them).
create table if not exists itsupport.staff (
  id uuid primary key default gen_random_uuid(),
  -- The Supabase Auth user ID. No foreign key to auth.users (G10).
  auth_user_id uuid not null constraint staff_auth_user_id_key unique,
  email text not null constraint staff_email_key unique
    constraint staff_email_check check (email = lower(email)),
  display_name text not null,
  role text not null constraint staff_role_check check (role in ('agent', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists itsupport.helpdesk_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null constraint helpdesk_tickets_ticket_id_key unique
    constraint helpdesk_tickets_ticket_id_fkey references itsupport.tickets (id) on delete restrict,
  -- nextval fails with 2200H past 9999999 (no cycle).
  seq integer not null generated always as identity (maxvalue 9999999),
  -- HD + 7 digits (G12). lpad never cuts here: a wider seq fails the check.
  number text not null generated always as (
    'HD' || lpad(seq::text, greatest(7, length(seq::text)), '0')
  ) stored
    constraint helpdesk_tickets_number_key unique
    constraint helpdesk_tickets_number_check check (number ~ '^HD[0-9]{7}$'),
  state text not null default 'new' constraint helpdesk_tickets_state_check
    check (state in ('new', 'in_progress', 'on_hold', 'resolved', 'closed')),
  -- Priorities and the 6 dev420188 categories as in triage_results.
  priority text not null
    constraint helpdesk_tickets_priority_check check (priority in ('P1', 'P2', 'P3', 'P4')),
  category text not null constraint helpdesk_tickets_category_check check (category in (
    'database', 'inquiry', 'software', 'hardware', 'password_reset', 'network'
  )),
  assignee_id uuid
    constraint helpdesk_tickets_assignee_id_fkey references itsupport.staff (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Append-only (trigger below). A system note names no staff; a staff note names one.
create table if not exists itsupport.helpdesk_notes (
  id uuid primary key default gen_random_uuid(),
  helpdesk_ticket_id uuid not null constraint helpdesk_notes_helpdesk_ticket_id_fkey
    references itsupport.helpdesk_tickets (id) on delete restrict,
  author_kind text not null
    constraint helpdesk_notes_author_kind_check check (author_kind in ('system', 'staff')),
  author_staff_id uuid constraint helpdesk_notes_author_staff_id_fkey
    references itsupport.staff (id) on delete restrict,
  body text not null
    constraint helpdesk_notes_body_check check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  constraint helpdesk_notes_author_check check ((author_kind = 'staff') = (author_staff_id is not null))
);

-- Append-only (trigger below). assigned_by_staff_id null = assigned by the system.
create table if not exists itsupport.helpdesk_assignments (
  id uuid primary key default gen_random_uuid(),
  helpdesk_ticket_id uuid not null constraint helpdesk_assignments_helpdesk_ticket_id_fkey
    references itsupport.helpdesk_tickets (id) on delete restrict,
  assignee_id uuid not null constraint helpdesk_assignments_assignee_id_fkey
    references itsupport.staff (id) on delete restrict,
  assigned_by_staff_id uuid constraint helpdesk_assignments_assigned_by_staff_id_fkey
    references itsupport.staff (id) on delete restrict,
  at timestamptz not null default now()
);

create table if not exists itsupport.helpdesk_state_transitions (
  from_state text not null constraint helpdesk_state_transitions_from_state_check
    check (from_state in ('new', 'in_progress', 'on_hold', 'resolved', 'closed')),
  to_state text not null constraint helpdesk_state_transitions_to_state_check
    check (to_state in ('new', 'in_progress', 'on_hold', 'resolved', 'closed')),
  constraint helpdesk_state_transitions_pkey primary key (from_state, to_state)
);

-- The G3 moves, the same pairs as packages/shared/src/helpdesk-state.ts.
-- Nothing leaves closed.
insert into itsupport.helpdesk_state_transitions (from_state, to_state) values
  ('new', 'in_progress'), ('new', 'on_hold'), ('new', 'resolved'), ('new', 'closed'),
  ('in_progress', 'on_hold'), ('in_progress', 'resolved'),
  ('on_hold', 'in_progress'), ('on_hold', 'resolved'),
  ('resolved', 'closed'), ('resolved', 'in_progress')
on conflict do nothing;

-- Append-only guard, as for ticket_events: rejects UPDATE, DELETE and
-- TRUNCATE for every role, including roles that bypass RLS or hold table
-- privileges.
create or replace function itsupport.reject_helpdesk_log_change()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;
revoke all on function itsupport.reject_helpdesk_log_change()
  from public, anon, authenticated, service_role;

drop trigger if exists helpdesk_notes_append_only_row on itsupport.helpdesk_notes;
create trigger helpdesk_notes_append_only_row
  before update or delete on itsupport.helpdesk_notes
  for each row execute function itsupport.reject_helpdesk_log_change();
drop trigger if exists helpdesk_notes_append_only_truncate on itsupport.helpdesk_notes;
create trigger helpdesk_notes_append_only_truncate
  before truncate on itsupport.helpdesk_notes
  for each statement execute function itsupport.reject_helpdesk_log_change();
drop trigger if exists helpdesk_assignments_append_only_row on itsupport.helpdesk_assignments;
create trigger helpdesk_assignments_append_only_row
  before update or delete on itsupport.helpdesk_assignments
  for each row execute function itsupport.reject_helpdesk_log_change();
drop trigger if exists helpdesk_assignments_append_only_truncate on itsupport.helpdesk_assignments;
create trigger helpdesk_assignments_append_only_truncate
  before truncate on itsupport.helpdesk_assignments
  for each statement execute function itsupport.reject_helpdesk_log_change();

-- ALWAYS: the guard also fires with session_replication_role = replica.
alter table itsupport.helpdesk_notes
  enable always trigger helpdesk_notes_append_only_row,
  enable always trigger helpdesk_notes_append_only_truncate;
alter table itsupport.helpdesk_assignments
  enable always trigger helpdesk_assignments_append_only_row,
  enable always trigger helpdesk_assignments_append_only_truncate;

-- The helpdesk a ticket lives in (G2); null until a helpdesk ticket exists.
alter table itsupport.tickets add column if not exists helpdesk text;
alter table itsupport.tickets drop constraint if exists tickets_helpdesk_check;
alter table itsupport.tickets
  add constraint tickets_helpdesk_check check (helpdesk in ('servicenow', 'builtin'));

-- An admin may decide a review from the helpdesk (G9). The old check is
-- swapped for the new one under this transaction's ACCESS EXCLUSIVE lock on
-- reviews, so no row is written in between. Adding the check validates every
-- existing row: a phase 4 row has staff_id null, so it passes as before.
alter table itsupport.reviews add column if not exists staff_id uuid;
alter table itsupport.reviews
  drop constraint if exists reviews_staff_id_fkey,
  drop constraint if exists reviews_slack_user_check,
  drop constraint if exists reviews_decided_by_check;
alter table itsupport.reviews
  add constraint reviews_staff_id_fkey foreign key (staff_id)
    references itsupport.staff (id) on delete restrict,
  -- approve and reject name exactly one decider; timeout and an open row name
  -- nobody. `is true` turns a null decision into false.
  add constraint reviews_decided_by_check check (num_nonnulls(slack_user_id, staff_id)
    = ((decision in ('approve', 'reject')) is true)::integer);

-- Row level security on, no policies (0008 adds them). Only service_role may
-- read, add or change rows; nobody but the owner may delete them. service_role
-- is revoked first because default privileges may have granted it more.
alter table itsupport.staff enable row level security;
alter table itsupport.helpdesk_tickets enable row level security;
alter table itsupport.helpdesk_notes enable row level security;
alter table itsupport.helpdesk_assignments enable row level security;
alter table itsupport.helpdesk_state_transitions enable row level security;
revoke all on table itsupport.staff, itsupport.helpdesk_tickets, itsupport.helpdesk_notes,
  itsupport.helpdesk_assignments, itsupport.helpdesk_state_transitions
  from public, anon, authenticated, service_role;
grant select, insert, update on table itsupport.staff, itsupport.helpdesk_tickets,
  itsupport.helpdesk_notes, itsupport.helpdesk_assignments, itsupport.helpdesk_state_transitions
  to service_role;
-- Identity inserts need no sequence right (0004).
revoke all on sequence itsupport.helpdesk_tickets_seq_seq
  from public, anon, authenticated, service_role;
