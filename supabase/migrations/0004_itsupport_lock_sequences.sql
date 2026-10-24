-- 0004_itsupport_lock_sequences (up)
--
-- Removes every right on the itsupport sequences from public, anon,
-- authenticated and service_role. 0001 did not revoke them on
-- ticket_events_id_seq, so Supabase-like default privileges set before 0001
-- left anon and authenticated with USAGE, SELECT and UPDATE (nextval, setval).
-- Identity inserts (ticket_events, security_events) need no sequence right,
-- so service_role inserts keep working. Touches only the `itsupport` schema.
-- Requires 0001 to 0003. Idempotent: safe to run more than once.
-- Verify with supabase/checks/0004_itsupport_lock_sequences.check.sql.
-- Applying this to the shared Supabase database is a human step (after H13).
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.

revoke all on sequence itsupport.ticket_events_id_seq from public, anon, authenticated, service_role;
revoke all on sequence itsupport.security_events_id_seq from public, anon, authenticated, service_role;
-- Any other itsupport sequence too, so none is left open.
revoke all on all sequences in schema itsupport from public, anon, authenticated, service_role;
