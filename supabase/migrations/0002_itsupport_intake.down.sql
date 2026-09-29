-- 0002_itsupport_intake (down)
--
-- Drops only the 2 tables 0002 created. itsupport.tickets, ticket_events and
-- the schema stay in place.
-- DESTRUCTIVE: deletes all redactions and triage results. Human approval required.

drop table if exists itsupport.triage_results;
drop table if exists itsupport.ticket_redactions;
