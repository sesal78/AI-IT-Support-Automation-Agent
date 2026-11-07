-- 0006_itsupport_helpdesk (check)
--
-- Read-only verification of migration 0006, for human step H28b and the
-- integration test. Returns one row per object 0006 creates: (object, ok).
-- After the up file every row is ok = true; after the down file every row is
-- ok = false. A constraint is ok when it exists and its definition is exactly
-- the expected one (Postgres 17). `columns` is the exact list of the
-- notifications columns with type, not null and default. `privileges <role>`
-- asks has_table_privilege and has_any_column_privilege: public, anon and
-- authenticated hold no right; service_role holds SELECT, INSERT and UPDATE
-- and nothing else. `rls` means RLS on, not forced, with no policies.
-- `function` means security definer, volatile, search_path '', returns text,
-- has exactly the expected body (outer white space and carriage returns
-- trimmed, so CRLF and LF checkouts agree) and has the same owner as the
-- sequence and itsupport.tickets; `execute` means no role but service_role (and the owner) may run it.
-- `grants itsupport.ticket_number_seq` means no role but the owner holds a
-- right on the sequence (0004's lock), and none of public, anon,
-- authenticated or service_role has USAGE, SELECT or UPDATE on it.
-- `tickets without a number` counts tickets whose ticket_number is null.
-- 0006 runs on the SHARED Supabase stack; applying it there is human step H28b.
-- The up file is idempotent; the down file is destructive.

with con (tbl, name, def) as (
  values
    ('notifications', 'notifications_pkey', 'PRIMARY KEY (id)'),
    ('notifications', 'notifications_ticket_id_fkey',
      'FOREIGN KEY (ticket_id) REFERENCES itsupport.tickets(id) ON DELETE RESTRICT'),
    ('notifications', 'notifications_ticket_channel_kind_key', 'UNIQUE (ticket_id, channel, kind)'),
    ('notifications', 'notifications_channel_check', 'CHECK ((channel = ''email''::text))'),
    ('notifications', 'notifications_kind_check',
      'CHECK ((kind = ANY (ARRAY[''incident_reply''::text, ''needs_info''::text])))'),
    ('notifications', 'notifications_status_check',
      'CHECK ((status = ANY (ARRAY[''sent''::text, ''skipped''::text, ''failed''::text])))'),
    ('notifications', 'notifications_reason_check',
      'CHECK ((reason = ANY (ARRAY[''not_allow_listed''::text, ''provider_error''::text])))'),
    ('notifications', 'notifications_sent_check',
      'CHECK (((status <> ''sent''::text) OR ((provider_id IS NOT NULL) AND (reason IS NULL))))'),
    ('notifications', 'notifications_skipped_check',
      'CHECK (((status <> ''skipped''::text) OR ((NOT (reason IS DISTINCT FROM ''not_allow_listed''::text)) '
      || 'AND (provider_id IS NULL))))'),
    ('notifications', 'notifications_failed_check',
      'CHECK (((status <> ''failed''::text) OR (NOT (reason IS DISTINCT FROM ''provider_error''::text))))'),
    ('tickets', 'tickets_ticket_number_key', 'UNIQUE (ticket_number)'),
    ('tickets', 'tickets_ticket_number_format', 'CHECK ((ticket_number ~ ''^ITS-[0-9]{6}$''::text))')
),
priv (role, has, hasnt) as (
  values
    ('public', null, 'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('anon', null, 'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('authenticated', null, 'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('service_role', 'select, insert, update', 'delete, truncate, references, trigger, maintain')
),
n (t) as (select to_regclass('itsupport.notifications')),
f (p) as (select to_regprocedure('itsupport.next_ticket_number()')),
s (q) as (select to_regclass('itsupport.ticket_number_seq'))
select e.object, coalesce(e.ok, false) as ok
from (
  select 'constraint itsupport.' || con.tbl || '.' || con.name, exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = to_regclass('itsupport.' || con.tbl) and k.conname = con.name
      and pg_get_constraintdef(k.oid) = con.def
  )
  from con
  union all
  select 'privileges ' || priv.role || ' itsupport.notifications', n.t is not null
    and coalesce((
      select bool_and(has_table_privilege(priv.role, n.t, p.p))
      from unnest(string_to_array(priv.has, ', ')) as p (p)
    ), true)
    and not has_table_privilege(priv.role, n.t, priv.hasnt)
    and (priv.has is not null
      or not has_any_column_privilege(priv.role, n.t, 'select, insert, update, references'))
  from priv, n
  union all
  select 'table itsupport.notifications',
    exists (select 1 from pg_catalog.pg_class r, n where r.oid = n.t and r.relkind = 'r')
  union all
  select 'columns itsupport.notifications', (
    select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull
      || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), ', ' order by a.attnum)
    from n, pg_catalog.pg_attribute a
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = n.t and a.attnum > 0 and not a.attisdropped
  ) = 'id uuid true gen_random_uuid(), ticket_id uuid true -, channel text true -, kind text true -, '
    || 'status text true -, provider_id text false -, reason text false -, '
    || 'at timestamp with time zone true now()'
  union all
  select 'rls itsupport.notifications', exists (
    select 1 from pg_catalog.pg_class r, n
    where r.oid = n.t and r.relrowsecurity and not r.relforcerowsecurity
      and not exists (select 1 from pg_catalog.pg_policy y where y.polrelid = r.oid)
  )
  union all
  select 'index itsupport.tickets_servicenow_sys_id_idx', exists (
    select 1 from pg_catalog.pg_indexes i
    where i.schemaname = 'itsupport' and i.indexname = 'tickets_servicenow_sys_id_idx'
      and i.indexdef = 'CREATE INDEX tickets_servicenow_sys_id_idx ON itsupport.tickets '
        || 'USING btree (servicenow_sys_id)'
  )
  union all
  select 'column itsupport.tickets.ticket_number', exists (
    select 1 from pg_catalog.pg_attribute a
    join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = to_regclass('itsupport.tickets') and a.attname = 'ticket_number'
      and not a.attisdropped and a.atttypid = 'text'::regtype and a.attnotnull
      and pg_get_expr(d.adbin, d.adrelid) = 'itsupport.next_ticket_number()'
  )
  union all
  select 'tickets without a number', case
    when exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass('itsupport.tickets') and a.attname = 'ticket_number'
        and not a.attisdropped
    )
    -- The column may be missing (before up, after down), so the count runs as a
    -- string only when it exists.
    then (xpath('/row/c/text()', query_to_xml(
      'select count(*) as c from itsupport.tickets where ticket_number is null', false, true, '')
    ))[1]::text = '0'
  end
  union all
  select 'sequence itsupport.ticket_number_seq', exists (
    select 1 from pg_catalog.pg_sequence q, s
    where q.seqrelid = s.q and q.seqtypid = 'integer'::regtype and q.seqstart = 1
      and q.seqincrement = 1 and q.seqmin = 1 and q.seqmax = 999999 and not q.seqcycle
  )
  union all
  select 'grants itsupport.ticket_number_seq', s.q is not null
    and not exists (
      select 1 from pg_catalog.pg_class r, aclexplode(coalesce(r.relacl, acldefault('s', r.relowner))) x
      where r.oid = s.q and x.grantee <> r.relowner
    )
    and not exists (
      select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role']) as g (role)
      where has_sequence_privilege(g.role, s.q, 'usage, select, update')
    )
  from s
  union all
  select 'function itsupport.next_ticket_number()', exists (
    select 1 from pg_catalog.pg_proc p, f, s
    where p.oid = f.p and p.prosecdef and p.provolatile = 'v' and p.prorettype = 'text'::regtype
      and not p.proretset and p.proconfig = array['search_path=""']
      and btrim(p.prosrc, E' \t\r\n')
        = 'select ''ITS-'' || lpad(nextval(''itsupport.ticket_number_seq'')::text, 6, ''0'')'
      and p.proowner = (select r.relowner from pg_catalog.pg_class r where r.oid = s.q)
      and p.proowner = (select r.relowner from pg_catalog.pg_class r
        where r.oid = to_regclass('itsupport.tickets'))
  )
  union all
  select 'execute itsupport.next_ticket_number()', (
    select string_agg(case x.grantee when 0 then 'public' else pg_get_userbyid(x.grantee) end
      || ' ' || x.privilege_type, ', ' order by x.grantee)
    from pg_catalog.pg_proc p, f, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    where p.oid = f.p and x.grantee <> p.proowner
  ) = 'service_role EXECUTE'
) as e (object, ok)
order by e.object;
