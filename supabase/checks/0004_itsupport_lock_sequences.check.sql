-- 0004_itsupport_lock_sequences (check)
--
-- Read-only verification of migration 0004. Returns 5 rows: (object, ok).
-- After the up file every row is ok = true. A `grants` row is ok when no role
-- other than the sequence owner (public included) holds any right on that
-- sequence; `every itsupport sequence` covers all sequences in the schema.
-- A false `grants` row means 0004 is not applied or a right came back.
-- A `default privileges` row is ok when no default privilege (pg_default_acl,
-- for any creating role and any object type) of that scope gives public, anon
-- or authenticated a right beyond the Postgres built-in default (EXECUTE on
-- functions and USAGE on types for public). `in schema itsupport` covers
-- defaults set with IN SCHEMA itsupport, `in every schema` the defaults set
-- without IN SCHEMA, which also reach itsupport. A false row means a default
-- privilege grants anon, authenticated or public a right on objects created
-- later in itsupport: report it to Seun. Do NOT change global or other-schema
-- default privileges on the shared database; other apps use them.

select e.object, case
  when e.kind = 'sequence' then coalesce(e.seq is null or to_regclass(e.seq) is not null, false)
    and not exists (
      select 1
      from pg_catalog.pg_class r
      join pg_catalog.pg_namespace n on n.oid = r.relnamespace,
        aclexplode(coalesce(r.relacl, acldefault('s', r.relowner))) x
      where n.nspname = 'itsupport' and r.relkind = 'S' and x.grantee <> r.relowner
        and (e.seq is null or r.oid = to_regclass(e.seq))
    )
  else not exists (
    select 1
    from pg_catalog.pg_default_acl d, aclexplode(d.defaclacl) x
    where d.defaclnamespace = case e.kind when 'global' then 0::oid
        else to_regnamespace('itsupport')::oid end
      and (x.grantee = 0 or x.grantee in (
        select g.oid from pg_catalog.pg_roles g where g.rolname in ('anon', 'authenticated')))
      and not exists (
        select 1
        from aclexplode(acldefault(case d.defaclobjtype when 'S' then 's'::"char"
          else d.defaclobjtype end, d.defaclrole)) b
        where b.grantee = x.grantee and b.privilege_type = x.privilege_type
      )
  )
end as ok
from (
  values
    ('grants itsupport.security_events_id_seq', 'sequence', 'itsupport.security_events_id_seq'),
    ('grants itsupport.ticket_events_id_seq', 'sequence', 'itsupport.ticket_events_id_seq'),
    ('grants every itsupport sequence', 'sequence', null),
    ('default privileges in schema itsupport', 'schema', null),
    ('default privileges in every schema', 'global', null)
) as e (object, kind, seq)
order by e.object;
