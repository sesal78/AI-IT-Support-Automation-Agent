-- 0006_itsupport_helpdesk (down)
--
-- Removes only what 0006 added: the ticket number (column, default, unique
-- key, format check, function and sequence), the index on
-- tickets.servicenow_sys_id and the itsupport.notifications table, with its
-- constraints and grants. Every 0001 to 0005 object stays in place.
-- Safe to run more than once.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- Lock timeout: each lock waits at most 5 s (`set local lock_timeout` below).
-- If it fails with 55P03 (lock_not_available), another session holds a lock on
-- itsupport.tickets: wait and re-run; nothing was applied. `set local` works
-- only inside the transaction; outside one it warns and has no effect.
-- DESTRUCTIVE: drops every notification row, the index and every ticket
-- number. Human approval required.

set local lock_timeout = '5s';

-- Dropping the column drops its default (so the function has no dependent
-- left), its unique key and its format check.
alter table itsupport.tickets drop column if exists ticket_number;
drop function if exists itsupport.next_ticket_number();
drop sequence if exists itsupport.ticket_number_seq;
drop index if exists itsupport.tickets_servicenow_sys_id_idx;
drop table if exists itsupport.notifications;
