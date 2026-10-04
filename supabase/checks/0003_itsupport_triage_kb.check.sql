-- 0003_itsupport_triage_kb (check)
--
-- Read-only verification of migration 0003, for human step H13 and the
-- integration test. Returns one row per object 0003 creates: (object, ok).
-- After the up file every row is ok = true; after the down file every row is
-- ok = false. A column is ok when it exists with the expected type and
-- nullability; a constraint is ok when the check constraint exists.

select e.object,
  case e.kind
    when 'column' then exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'itsupport' and c.table_name = e.tbl
        and c.column_name = e.name and c.udt_name = e.udt and c.is_nullable = e.nullable
    )
    else exists (
      select 1 from pg_catalog.pg_constraint k
      join pg_catalog.pg_class r on r.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'itsupport' and r.relname = e.tbl
        and k.conname = e.name and k.contype = 'c'
    )
  end as ok
from (
  values
    -- Part 1: tickets.
    ('column itsupport.tickets.is_test', 'column', 'tickets', 'is_test', 'bool', 'NO'),
    ('constraint itsupport.tickets.tickets_status_check', 'constraint', 'tickets', 'tickets_status_check', null, null)
) as e (object, kind, tbl, name, udt, nullable)
order by e.object;
