-- 0004_itsupport_lock_sequences (down)
--
-- Deliberately grants nothing back: restoring the old rights would reopen
-- nextval and setval on the itsupport sequences to anon and authenticated.
-- It only re-applies the lock, so it is safe to run more than once and
-- leaves 0001 to 0003 unchanged. Not destructive.

revoke all on all sequences in schema itsupport from public, anon, authenticated, service_role;
