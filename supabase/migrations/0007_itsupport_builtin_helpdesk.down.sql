-- 0007_itsupport_builtin_helpdesk (down)
--
-- Removes only what 0007 added: the tables itsupport.staff,
-- helpdesk_tickets, helpdesk_notes, helpdesk_assignments and
-- helpdesk_state_transitions (with their constraints, triggers, grants and
-- the identity sequence), the append-only trigger function, the columns
-- tickets.helpdesk and reviews.staff_id, and restores 0005's
-- reviews_slack_user_check. Every 0001 to 0006 object and row stays in place.
-- Safe to run more than once.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- Locks wait at most 5 s. Error 55P03 (lock_not_available) means another
-- session held a table: wait and re-run; nothing was applied.
-- If a review was decided from the helpdesk (staff_id set), restoring 0005's
-- check fails with 23514 and nothing is changed: such a review has no Slack
-- user, so it cannot go back to the phase 4 shape.
-- DESTRUCTIVE for the new tables only: drops every staff row, helpdesk
-- ticket, note, assignment and transition, every tickets.helpdesk value and
-- every reviews.staff_id. Human approval required.

set local lock_timeout = '5s';

alter table itsupport.reviews drop constraint if exists reviews_decided_by_check;
-- Dropping the column drops its foreign key to staff.
alter table itsupport.reviews drop column if exists staff_id;
alter table itsupport.reviews drop constraint if exists reviews_slack_user_check;
alter table itsupport.reviews
  add constraint reviews_slack_user_check
    check (((decision in ('approve', 'reject')) is true) = (slack_user_id is not null));

-- Dropping the column drops its check.
alter table itsupport.tickets drop column if exists helpdesk;

drop table if exists itsupport.helpdesk_assignments;
drop table if exists itsupport.helpdesk_notes;
drop table if exists itsupport.helpdesk_tickets;
drop table if exists itsupport.helpdesk_state_transitions;
drop table if exists itsupport.staff;
drop function if exists itsupport.reject_helpdesk_log_change();
