-- 0003_itsupport_triage_kb (down)
--
-- Removes only what 0003 added. itsupport.tickets, ticket_events,
-- ticket_redactions, triage_results, their phase-2 columns and the schema
-- stay in place.
-- DESTRUCTIVE: deletes the is_test flags. Human approval required.

-- Part 1: tickets.is_test and the status check.
alter table itsupport.tickets
  drop constraint if exists tickets_status_check,
  drop column if exists is_test;
