-- 0001_itsupport_foundation (down)
--
-- Drops everything this project created. It deliberately does NOT drop the
-- `vector` extension: other apps on the shared stack may depend on it.
-- DESTRUCTIVE: deletes all itsupport data. Human approval required.

drop schema if exists itsupport cascade;
