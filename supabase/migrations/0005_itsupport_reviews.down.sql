-- 0005_itsupport_reviews (down)
--
-- Removes only what 0005 added: the itsupport.reviews table, with its
-- constraints, index and grants. Every 0001 to 0004 object stays in place.
-- Safe to run more than once.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- DESTRUCTIVE: drops every review row. Human approval required.

drop table if exists itsupport.reviews;
