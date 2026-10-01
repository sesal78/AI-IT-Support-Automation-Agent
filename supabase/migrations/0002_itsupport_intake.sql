-- 0002_itsupport_intake (up)
--
-- Phase 2 (intake + safety) tables for the AI IT Support agent on the SHARED
-- Supabase stack. Touches only the `itsupport` schema. Requires 0001.
-- Idempotent: safe to run more than once. Reverse with
-- 0002_itsupport_intake.down.sql (which drops only these 2 tables).
-- Applying this to the shared Dokploy database is human step H7.
--
-- Foreign keys use ON DELETE RESTRICT: a ticket that already has a redaction
-- or a triage result cannot be deleted, so derived records never vanish
-- silently. This matches ticket_events (0001), whose foreign key also blocks
-- ticket deletes.

-- 1. Redacted copy of a ticket. Internal. The only ticket text that leaves
--    the system (docs/PROJECT.md §5).
create table if not exists itsupport.ticket_redactions (
  ticket_id uuid primary key references itsupport.tickets (id) on delete restrict,
  redacted_title text not null,
  redacted_description text not null,
  redaction_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- 2. Triage result per ticket. Internal. Phase 2 stores only the sensitive-
--    topic check; later phases add columns with new migrations.
create table if not exists itsupport.triage_results (
  ticket_id uuid primary key references itsupport.tickets (id) on delete restrict,
  sensitive boolean not null,
  sensitive_flags jsonb not null,
  checker text not null,
  created_at timestamptz not null default now()
);

-- 3. Row level security: enabled, no policies, so deny by default.
alter table itsupport.ticket_redactions enable row level security;
alter table itsupport.triage_results enable row level security;

-- Privileges: only service_role (server-side code) may read or write these
-- tables, and it may not delete from them.
revoke all on itsupport.ticket_redactions, itsupport.triage_results
  from public, anon, authenticated, service_role;
grant select, insert, update on itsupport.ticket_redactions, itsupport.triage_results
  to service_role;
