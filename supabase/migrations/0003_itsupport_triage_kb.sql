-- 0003_itsupport_triage_kb (up)
--
-- Phase 3 (AI triage + KB) changes for the AI IT Support agent on the SHARED
-- Supabase stack. Touches only the `itsupport` schema. Requires 0001 and 0002.
-- Idempotent: safe to run more than once. Reverse with
-- 0003_itsupport_triage_kb.down.sql. Verify with
-- supabase/checks/0003_itsupport_triage_kb.check.sql.
-- Applying this to the shared Dokploy database is human step H13.
--
-- Part 1: tickets. Additive only: one column with a default and a check
-- constraint. Existing phase-2 rows stay valid (status `new`). Row level
-- security and the table privileges of 0001 cover the new column unchanged.
-- Check constraints are dropped and re-added by name so a re-run is a no-op.

-- 1. Tickets created by the e2e app or the test endpoints (plan §6.1 DoD 6).
alter table itsupport.tickets
  add column if not exists is_test boolean not null default false;

-- 2. The 12 ticket statuses (plan §2.6); must equal TICKET_STATUSES in
--    packages/shared/src/status.ts (a test compares them).
alter table itsupport.tickets drop constraint if exists tickets_status_check;
alter table itsupport.tickets add constraint tickets_status_check check (status in (
  'new', 'redacted', 'triaged', 'auto', 'helpdesk_pending', 'incident_created',
  'incident_skipped_shadow', 'review_pending', 'approved', 'rejected',
  'escalated_manual', 'failed'
));
