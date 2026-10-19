-- 0004_itsupport_lock_sequences (check)
--
-- Read-only verification of migration 0004. Returns 3 rows: (object, ok).
-- After the up file every row is ok = true. A row is ok when no role other
-- than the sequence owner (public included) holds any right on that
-- sequence; `every itsupport sequence` covers all sequences in the schema.
-- A false row means 0004 is not applied or a right came back.

select e.object, coalesce(e.seq is null or to_regclass(e.seq) is not null, false)
  and not exists (
    select 1
    from pg_catalog.pg_class r
    join pg_catalog.pg_namespace n on n.oid = r.relnamespace,
      aclexplode(coalesce(r.relacl, acldefault('s', r.relowner))) x
    where n.nspname = 'itsupport' and r.relkind = 'S' and x.grantee <> r.relowner
      and (e.seq is null or r.oid = to_regclass(e.seq))
  ) as ok
from (
  values
    ('grants itsupport.security_events_id_seq', 'itsupport.security_events_id_seq'),
    ('grants itsupport.ticket_events_id_seq', 'itsupport.ticket_events_id_seq'),
    ('grants every itsupport sequence', null)
) as e (object, seq)
order by e.object;
