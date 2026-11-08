-- 0007_itsupport_builtin_helpdesk (check)
--
-- Read-only verification of migration 0007, for human step H28b and the
-- integration test. Returns one row per object 0007 creates: (object, ok).
-- After the up file every row is ok = true; after the down file every row is
-- ok = false. For each of the 5 new tables: `table` means an ordinary table;
-- `columns` is the exact column list with type, not null, default (or the
-- generation expression) and identity; `constraints` lists every constraint
-- of the table, and each `constraint` row is ok when it exists and its
-- definition is exactly the expected one (Postgres 17); `indexes` means no
-- index other than the constraint ones; `triggers` lists every user trigger,
-- each enabled ALWAYS (tgenabled = 'A', so it fires under replica too);
-- `grants` lists every table and column privilege held by a role other than
-- the owner (service_role INSERT, SELECT and UPDATE only); `privileges <role>`
-- asks has_table_privilege and has_any_column_privilege directly: public,
-- anon and authenticated hold no right, service_role holds SELECT, INSERT and
-- UPDATE and nothing else; `rls` means RLS on, not forced, with no policies;
-- `owner` means the same owner as itsupport.tickets.
-- `column itsupport.tickets.helpdesk` and `column itsupport.reviews.staff_id`
-- are nullable with no default; `checks itsupport.reviews` is the exact list
-- of reviews checks (0005's reviews_slack_user_check replaced by
-- reviews_decided_by_check). `transitions` is the exact set of G3 pairs.
-- `sequence` means the identity sequence of helpdesk_tickets.seq is integer,
-- 1 to 9999999, no cycle; its `grants` row means no role but the owner holds
-- a right on it (0004's lock), and none of public, anon, authenticated or
-- service_role has USAGE, SELECT or UPDATE. `function` means the append-only
-- trigger function is plpgsql, security invoker, search_path '', has the
-- expected body (white space and carriage returns trimmed, so CRLF and LF
-- checkouts agree) and no role but its owner may run it.
-- 0007 runs on the SHARED Supabase stack; applying it there is human step H28b.
-- The up file is idempotent; the down file is destructive.

with t (tbl, cols, idx, trg) as (
  values
    ('staff', 'id uuid true gen_random_uuid(), auth_user_id uuid true -, email text true -, '
      || 'display_name text true -, role text true -, active boolean true true, '
      || 'created_at timestamp with time zone true now()',
      'staff_auth_user_id_key, staff_email_key, staff_pkey', ''),
    ('helpdesk_tickets', 'id uuid true gen_random_uuid(), ticket_id uuid true -, '
      || 'seq integer true - identity a, number text true (''HD''::text || lpad((seq)::text, '
      || 'GREATEST(7, length((seq)::text)), ''0''::text)) generated s, state text true ''new''::text, '
      || 'priority text true -, category text true -, assignee_id uuid false -, '
      || 'created_at timestamp with time zone true now(), updated_at timestamp with time zone true now()',
      'helpdesk_tickets_number_key, helpdesk_tickets_pkey, helpdesk_tickets_ticket_id_key', ''),
    ('helpdesk_notes', 'id uuid true gen_random_uuid(), helpdesk_ticket_id uuid true -, '
      || 'author_kind text true -, author_staff_id uuid false -, body text true -, '
      || 'created_at timestamp with time zone true now()',
      'helpdesk_notes_pkey', 'helpdesk_notes_append_only_row, helpdesk_notes_append_only_truncate'),
    ('helpdesk_assignments', 'id uuid true gen_random_uuid(), helpdesk_ticket_id uuid true -, '
      || 'assignee_id uuid true -, assigned_by_staff_id uuid false -, at timestamp with time zone true now()',
      'helpdesk_assignments_pkey',
      'helpdesk_assignments_append_only_row, helpdesk_assignments_append_only_truncate'),
    ('helpdesk_state_transitions', 'from_state text true -, to_state text true -',
      'helpdesk_state_transitions_pkey', '')
),
con (tbl, name, def) as (
  values
    ('staff', 'staff_pkey', 'PRIMARY KEY (id)'),
    ('staff', 'staff_auth_user_id_key', 'UNIQUE (auth_user_id)'),
    ('staff', 'staff_email_key', 'UNIQUE (email)'),
    ('staff', 'staff_email_check', 'CHECK ((email = lower(email)))'),
    ('staff', 'staff_role_check', 'CHECK ((role = ANY (ARRAY[''agent''::text, ''admin''::text])))'),
    ('helpdesk_tickets', 'helpdesk_tickets_pkey', 'PRIMARY KEY (id)'),
    ('helpdesk_tickets', 'helpdesk_tickets_ticket_id_key', 'UNIQUE (ticket_id)'),
    ('helpdesk_tickets', 'helpdesk_tickets_ticket_id_fkey',
      'FOREIGN KEY (ticket_id) REFERENCES itsupport.tickets(id) ON DELETE RESTRICT'),
    ('helpdesk_tickets', 'helpdesk_tickets_number_key', 'UNIQUE (number)'),
    ('helpdesk_tickets', 'helpdesk_tickets_number_check', 'CHECK ((number ~ ''^HD[0-9]{7}$''::text))'),
    ('helpdesk_tickets', 'helpdesk_tickets_state_check', 'CHECK ((state = ANY (ARRAY[''new''::text, '
      || '''in_progress''::text, ''on_hold''::text, ''resolved''::text, ''closed''::text])))'),
    ('helpdesk_tickets', 'helpdesk_tickets_priority_check',
      'CHECK ((priority = ANY (ARRAY[''P1''::text, ''P2''::text, ''P3''::text, ''P4''::text])))'),
    ('helpdesk_tickets', 'helpdesk_tickets_category_check', 'CHECK ((category = ANY (ARRAY['
      || '''database''::text, ''inquiry''::text, ''software''::text, ''hardware''::text, '
      || '''password_reset''::text, ''network''::text])))'),
    ('helpdesk_tickets', 'helpdesk_tickets_assignee_id_fkey',
      'FOREIGN KEY (assignee_id) REFERENCES itsupport.staff(id) ON DELETE RESTRICT'),
    ('helpdesk_notes', 'helpdesk_notes_pkey', 'PRIMARY KEY (id)'),
    ('helpdesk_notes', 'helpdesk_notes_helpdesk_ticket_id_fkey',
      'FOREIGN KEY (helpdesk_ticket_id) REFERENCES itsupport.helpdesk_tickets(id) ON DELETE RESTRICT'),
    ('helpdesk_notes', 'helpdesk_notes_author_kind_check',
      'CHECK ((author_kind = ANY (ARRAY[''system''::text, ''staff''::text])))'),
    ('helpdesk_notes', 'helpdesk_notes_author_staff_id_fkey',
      'FOREIGN KEY (author_staff_id) REFERENCES itsupport.staff(id) ON DELETE RESTRICT'),
    ('helpdesk_notes', 'helpdesk_notes_author_check',
      'CHECK (((author_kind = ''staff''::text) = (author_staff_id IS NOT NULL)))'),
    ('helpdesk_notes', 'helpdesk_notes_body_check',
      'CHECK (((char_length(body) >= 1) AND (char_length(body) <= 5000)))'),
    ('helpdesk_assignments', 'helpdesk_assignments_pkey', 'PRIMARY KEY (id)'),
    ('helpdesk_assignments', 'helpdesk_assignments_helpdesk_ticket_id_fkey',
      'FOREIGN KEY (helpdesk_ticket_id) REFERENCES itsupport.helpdesk_tickets(id) ON DELETE RESTRICT'),
    ('helpdesk_assignments', 'helpdesk_assignments_assignee_id_fkey',
      'FOREIGN KEY (assignee_id) REFERENCES itsupport.staff(id) ON DELETE RESTRICT'),
    ('helpdesk_assignments', 'helpdesk_assignments_assigned_by_staff_id_fkey',
      'FOREIGN KEY (assigned_by_staff_id) REFERENCES itsupport.staff(id) ON DELETE RESTRICT'),
    ('helpdesk_state_transitions', 'helpdesk_state_transitions_pkey', 'PRIMARY KEY (from_state, to_state)'),
    ('helpdesk_state_transitions', 'helpdesk_state_transitions_from_state_check',
      'CHECK ((from_state = ANY (ARRAY[''new''::text, ''in_progress''::text, ''on_hold''::text, '
      || '''resolved''::text, ''closed''::text])))'),
    ('helpdesk_state_transitions', 'helpdesk_state_transitions_to_state_check',
      'CHECK ((to_state = ANY (ARRAY[''new''::text, ''in_progress''::text, ''on_hold''::text, '
      || '''resolved''::text, ''closed''::text])))'),
    -- On existing tables (each has more constraints from earlier migrations).
    ('tickets', 'tickets_helpdesk_check',
      'CHECK ((helpdesk = ANY (ARRAY[''servicenow''::text, ''builtin''::text])))'),
    ('reviews', 'reviews_staff_id_fkey',
      'FOREIGN KEY (staff_id) REFERENCES itsupport.staff(id) ON DELETE RESTRICT'),
    ('reviews', 'reviews_decided_by_check', 'CHECK ((num_nonnulls(slack_user_id, staff_id) = '
      || '(((decision = ANY (ARRAY[''approve''::text, ''reject''::text])) IS TRUE))::integer))')
),
priv (role, has, hasnt) as (
  values
    ('public', null, 'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('anon', null, 'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('authenticated', null, 'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('service_role', 'select, insert, update', 'delete, truncate, references, trigger, maintain')
),
r (tbl, oid) as (select t.tbl, to_regclass('itsupport.' || t.tbl) from t),
f (p) as (select to_regprocedure('itsupport.reject_helpdesk_log_change()')),
s (q) as (select to_regclass('itsupport.helpdesk_tickets_seq_seq'))
select e.object, coalesce(e.ok, false) as ok
from (
  select 'table itsupport.' || r.tbl,
    exists (select 1 from pg_catalog.pg_class c where c.oid = r.oid and c.relkind = 'r')
  from r
  union all
  select 'columns itsupport.' || t.tbl, (
    select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull
      || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
      || case when a.attidentity <> '' then ' identity ' || a.attidentity::text else '' end
      || case when a.attgenerated <> '' then ' generated ' || a.attgenerated::text else '' end,
      ', ' order by a.attnum)
    from pg_catalog.pg_attribute a
    left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = r.oid and a.attnum > 0 and not a.attisdropped
  ) = t.cols
  from t join r using (tbl)
  union all
  select 'constraint itsupport.' || con.tbl || '.' || con.name, exists (
    select 1 from pg_catalog.pg_constraint k
    where k.conrelid = to_regclass('itsupport.' || con.tbl) and k.conname = con.name
      and pg_get_constraintdef(k.oid) = con.def
  )
  from con
  union all
  select 'constraints itsupport.' || r.tbl, r.oid is not null and (
    select coalesce(string_agg(k.conname, ', ' order by k.conname), '') from pg_catalog.pg_constraint k
    where k.conrelid = r.oid
  ) = (select string_agg(con.name, ', ' order by con.name) from con where con.tbl = r.tbl)
  from r
  union all
  select 'indexes itsupport.' || t.tbl, r.oid is not null and (
    select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
    from pg_catalog.pg_index x join pg_catalog.pg_class c on c.oid = x.indexrelid
    where x.indrelid = r.oid
  ) = t.idx
  from t join r using (tbl)
  union all
  select 'triggers itsupport.' || t.tbl, r.oid is not null and (
    select coalesce(string_agg(g.tgname, ', ' order by g.tgname), '') from pg_catalog.pg_trigger g
    where g.tgrelid = r.oid and not g.tgisinternal
  ) = t.trg and not exists (
    -- All user trigger names must match; every guard must use the function in ALWAYS mode.
    select 1 from pg_catalog.pg_trigger g
    where g.tgrelid = r.oid and not g.tgisinternal
      and (g.tgfoid is distinct from (select f.p from f) or g.tgenabled <> 'A')
    union all
    select 1 from pg_catalog.pg_rewrite w where w.ev_class = r.oid
    union all
    select 1 from pg_catalog.pg_publication_tables b
    where b.schemaname = 'itsupport' and b.tablename = r.tbl
  )
  from t join r using (tbl)
  union all
  select 'grants itsupport.' || r.tbl, r.oid is not null and (
    select coalesce(string_agg(w.who || ' ' || g.priv, ', ' order by w.who, g.priv), '')
    from (
      select x.grantee, x.privilege_type || case when x.is_grantable then '*' else '' end
      from pg_catalog.pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
      where c.oid = r.oid and x.grantee <> c.relowner
      union all
      select x.grantee, a.attname || '.' || x.privilege_type || case when x.is_grantable then '*' else '' end
      from pg_catalog.pg_attribute a, aclexplode(a.attacl) x
      where a.attrelid = r.oid
    ) as g (grantee, priv),
    lateral (select case g.grantee when 0 then 'public' else pg_get_userbyid(g.grantee) end) as w (who)
  ) = 'service_role INSERT, service_role SELECT, service_role UPDATE'
  from r
  union all
  select 'privileges ' || priv.role || ' itsupport.' || r.tbl, r.oid is not null
    and coalesce((
      select bool_and(has_table_privilege(priv.role, r.oid, p.p))
      from unnest(string_to_array(priv.has, ', ')) as p (p)
    ), true)
    and not has_table_privilege(priv.role, r.oid, priv.hasnt)
    and (priv.has is not null
      or not has_any_column_privilege(priv.role, r.oid, 'select, insert, update, references'))
  from priv, r
  union all
  select 'rls itsupport.' || r.tbl, exists (
    select 1 from pg_catalog.pg_class c
    where c.oid = r.oid and c.relrowsecurity and not c.relforcerowsecurity
      and not exists (select 1 from pg_catalog.pg_policy y where y.polrelid = c.oid)
  )
  from r
  union all
  select 'owner itsupport.' || r.tbl, (
    select c.relowner from pg_catalog.pg_class c where c.oid = to_regclass('itsupport.tickets')
  ) = (select c.relowner from pg_catalog.pg_class c where c.oid = r.oid)
  from r
  union all
  select 'column itsupport.' || v.tbl || '.' || v.col, exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid = to_regclass('itsupport.' || v.tbl) and a.attname = v.col and not a.attisdropped
      and a.atttypid = v.typ::regtype and not a.attnotnull and not a.atthasdef
      and a.attidentity = '' and a.attgenerated = ''
  )
  from (values ('tickets', 'helpdesk', 'text'), ('reviews', 'staff_id', 'uuid')) as v (tbl, col, typ)
  union all
  select 'checks itsupport.reviews', (
    select string_agg(k.conname, ', ' order by k.conname) from pg_catalog.pg_constraint k
    where k.conrelid = to_regclass('itsupport.reviews') and k.contype = 'c'
  ) = 'reviews_decided_by_check, reviews_decided_check, reviews_decision_check, reviews_kind_check, '
    || 'reviews_proposal_check'
  union all
  select 'transitions itsupport.helpdesk_state_transitions', case
    when to_regclass('itsupport.helpdesk_state_transitions') is not null
    -- The table may be missing (before up, after down), so the query runs as a
    -- string only when it exists.
    then (xpath('/row/p/text()', query_to_xml(
      'select string_agg(from_state || '':'' || to_state, '','' order by from_state collate "C", '
      || 'to_state collate "C") as p '
      || 'from itsupport.helpdesk_state_transitions', false, true, '')
    ))[1]::text = 'in_progress:on_hold,in_progress:resolved,new:closed,new:in_progress,new:on_hold,'
      || 'new:resolved,on_hold:in_progress,on_hold:resolved,resolved:closed,resolved:in_progress'
  end
  union all
  select 'sequence itsupport.helpdesk_tickets_seq_seq', exists (
    select 1 from pg_catalog.pg_sequence q, s
    where q.seqrelid = s.q and q.seqtypid = 'integer'::regtype and q.seqstart = 1
      and q.seqincrement = 1 and q.seqmin = 1 and q.seqmax = 9999999 and not q.seqcycle
      -- It is the identity sequence of helpdesk_tickets.seq.
      and exists (
        select 1 from pg_catalog.pg_depend dp
        join pg_catalog.pg_attribute a on a.attrelid = dp.refobjid and a.attnum = dp.refobjsubid
        where dp.classid = 'pg_catalog.pg_class'::regclass and dp.objid = s.q and dp.deptype = 'i'
          and dp.refobjid = to_regclass('itsupport.helpdesk_tickets') and a.attname = 'seq'
      )
  )
  union all
  select 'grants itsupport.helpdesk_tickets_seq_seq', s.q is not null
    and not exists (
      select 1 from pg_catalog.pg_class c, aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) x
      where c.oid = s.q and x.grantee <> c.relowner
    )
    and not exists (
      select 1 from unnest(array['public', 'anon', 'authenticated', 'service_role']) as g (role)
      where has_sequence_privilege(g.role, s.q, 'usage, select, update')
    )
  from s
  union all
  select 'function itsupport.reject_helpdesk_log_change()', exists (
    select 1 from pg_catalog.pg_proc p, f
    where p.oid = f.p and not p.prosecdef and p.prolang = (select l.oid from pg_catalog.pg_language l
        where l.lanname = 'plpgsql')
      and p.prorettype = 'trigger'::regtype and p.proconfig = array['search_path=""']
      and regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g')
        = 'begin raise exception ''% is append-only: % is not allowed'', tg_table_name, tg_op '
          || 'using errcode = ''insufficient_privilege''; end;'
      and not exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
        where x.grantee <> p.proowner
      )
  )
) as e (object, ok)
order by e.object;
