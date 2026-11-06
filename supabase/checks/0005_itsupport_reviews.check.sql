-- 0005_itsupport_reviews (check)
--
-- Read-only verification of migration 0005, for human step H15 and the
-- integration test. Returns one row per object 0005 creates: (object, ok).
-- After the up file every row is ok = true; after the down file every row is
-- ok = false. `table` means itsupport.reviews exists as an ordinary table.
-- A column is ok when it exists with the expected type, nullability and
-- default; a constraint (check, primary key, unique or foreign key) is ok when
-- it exists and its definition is exactly the expected one (Postgres 17).
-- A time column carries any precision other than the default 6
-- (timestamptz(3) is not timestamptz), and no column may use a domain.
-- `checks`, `columns`, `grants`, `triggers` (user triggers), `rules` and
-- `publications` rows list every check constraint, column, table and column
-- privilege held by a role other than the owner, trigger, rewrite rule or
-- publication of the table, so anything extra or missing fails; a grant with
-- grant option ends in `*`. `indexes` means no index other than the listed
-- ones. `privileges <role>` asks has_table_privilege and
-- has_any_column_privilege directly: public, anon and authenticated hold no
-- right; service_role holds SELECT, INSERT and UPDATE and nothing else.
-- `rls` means RLS on, not forced, with no policies. `owner` means the same owner as
-- itsupport.tickets (whichever role applied the migrations).
-- 0005 runs on the SHARED Supabase stack; applying it there is human step H15.
-- The up file is idempotent; the down file is destructive.

select e.object,
  case e.kind
    when 'table' then exists (
      select 1 from pg_catalog.pg_class r
      where r.oid = to_regclass('itsupport.' || e.tbl) and r.relkind = 'r'
    )
    when 'column' then exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'itsupport' and c.table_name = e.tbl
        and c.column_name = e.name and c.is_nullable = e.nullable and c.domain_name is null
        and c.udt_name || case when c.data_type like 'time%' and c.datetime_precision <> 6
          then '(' || c.datetime_precision || ')' else '' end = e.udt
        and coalesce('generated ' || c.generation_expression, 'identity ' || c.identity_generation,
          c.column_default)
          is not distinct from e.def
    )
    when 'rls' then exists (
      select 1 from pg_catalog.pg_class r
      where r.oid = to_regclass('itsupport.' || e.tbl) and r.relrowsecurity and not r.relforcerowsecurity
        and not exists (select 1 from pg_catalog.pg_policy y where y.polrelid = r.oid)
    )
    when 'columns' then e.def = (
      select coalesce(string_agg(a.attname, ', ' order by a.attnum), '') from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass('itsupport.' || e.tbl) and a.attnum > 0 and not a.attisdropped
    )
    when 'checks' then e.def = (
      select coalesce(string_agg(k.conname, ', ' order by k.conname), '') from pg_catalog.pg_constraint k
      where k.conrelid = to_regclass('itsupport.' || e.tbl) and k.contype = 'c'
    )
    when 'indexes' then to_regclass('itsupport.' || e.tbl) is not null and not exists (
      select 1 from pg_catalog.pg_index x join pg_catalog.pg_class r on r.oid = x.indexrelid
      where x.indrelid = to_regclass('itsupport.' || e.tbl)
        and r.relname <> all (string_to_array(e.def, ', '))
    )
    when 'triggers' then to_regclass('itsupport.' || e.tbl) is not null and e.def = (
      select coalesce(string_agg(t.tgname, ', ' order by t.tgname), '') from pg_catalog.pg_trigger t
      where t.tgrelid = to_regclass('itsupport.' || e.tbl) and not t.tgisinternal
    )
    when 'rules' then to_regclass('itsupport.' || e.tbl) is not null and e.def = (
      select coalesce(string_agg(w.rulename, ', ' order by w.rulename), '') from pg_catalog.pg_rewrite w
      where w.ev_class = to_regclass('itsupport.' || e.tbl)
    )
    when 'publications' then to_regclass('itsupport.' || e.tbl) is not null and e.def = (
      select coalesce(string_agg(b.pubname, ', ' order by b.pubname), '')
      from pg_catalog.pg_publication_tables b
      where b.schemaname = 'itsupport' and b.tablename = e.tbl
    )
    when 'grants' then to_regclass('itsupport.' || e.tbl) is not null and e.def = (
      select coalesce(string_agg(w.who || ' ' || g.priv, ', ' order by w.who, g.priv), '')
      from (
        select x.grantee, x.privilege_type || case when x.is_grantable then '*' else '' end
        from pg_catalog.pg_class r, aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) x
        where r.oid = to_regclass('itsupport.' || e.tbl) and x.grantee <> r.relowner
        union all
        select x.grantee, a.attname || '.' || x.privilege_type || case when x.is_grantable then '*' else '' end
        from pg_catalog.pg_attribute a, aclexplode(a.attacl) x
        where a.attrelid = to_regclass('itsupport.' || e.tbl)
      ) as g (grantee, priv),
      lateral (select case g.grantee when 0 then 'public' else pg_get_userbyid(g.grantee) end) as w (who)
    )
    -- e.name is the role, e.udt the rights it must each hold, e.def the rights
    -- it must hold none of (has_table_privilege with a list means any of them).
    when 'privileges' then to_regclass('itsupport.' || e.tbl) is not null
      and coalesce((
        select bool_and(has_table_privilege(e.name, to_regclass('itsupport.' || e.tbl), p.priv))
        from unnest(string_to_array(e.udt, ', ')) as p (priv)
      ), true)
      and not has_table_privilege(e.name, to_regclass('itsupport.' || e.tbl), e.def)
      and (e.udt is not null or not has_any_column_privilege(e.name, to_regclass('itsupport.' || e.tbl),
        'select, insert, update, references'))
    when 'owner' then coalesce((
      select r.relowner from pg_catalog.pg_class r where r.oid = to_regclass('itsupport.tickets')
    ) = (
      select r.relowner from pg_catalog.pg_class r where r.oid = to_regclass('itsupport.' || e.tbl)
    ), false)
    else exists (
      select 1 from pg_catalog.pg_constraint k
      join pg_catalog.pg_class r on r.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'itsupport' and r.relname = e.tbl
        and k.conname = e.name and k.contype in ('c', 'p', 'u', 'f')
        and pg_get_constraintdef(k.oid) = e.def
    )
  end as ok
from (
  values
    ('table itsupport.reviews', 'table', 'reviews', null, null, null, null),
    ('column itsupport.reviews.id', 'column', 'reviews', 'id', 'uuid', 'NO', 'gen_random_uuid()'),
    ('column itsupport.reviews.ticket_id', 'column', 'reviews', 'ticket_id', 'uuid', 'NO', null),
    ('column itsupport.reviews.kind', 'column', 'reviews', 'kind', 'text', 'NO', null),
    ('column itsupport.reviews.proposal_id', 'column', 'reviews', 'proposal_id', 'uuid', 'YES', null),
    ('column itsupport.reviews.slack_user_id', 'column', 'reviews', 'slack_user_id', 'text', 'YES', null),
    ('column itsupport.reviews.decision', 'column', 'reviews', 'decision', 'text', 'YES', null),
    ('column itsupport.reviews.decided_at', 'column', 'reviews', 'decided_at', 'timestamptz', 'YES', null),
    ('column itsupport.reviews.wait_token_id', 'column', 'reviews', 'wait_token_id', 'text', 'NO', null),
    ('column itsupport.reviews.slack_ts', 'column', 'reviews', 'slack_ts', 'text', 'YES', null),
    ('column itsupport.reviews.created_at', 'column', 'reviews', 'created_at', 'timestamptz', 'NO', 'now()'),
    ('constraint itsupport.reviews.reviews_pkey', 'constraint', 'reviews', 'reviews_pkey', null, null,
      'PRIMARY KEY (id)'),
    ('constraint itsupport.reviews.reviews_ticket_id_fkey', 'constraint', 'reviews', 'reviews_ticket_id_fkey', null, null,
      'FOREIGN KEY (ticket_id) REFERENCES itsupport.tickets(id) ON DELETE RESTRICT'),
    ('constraint itsupport.reviews.reviews_ticket_kind_proposal_key', 'constraint', 'reviews',
      'reviews_ticket_kind_proposal_key', null, null, 'UNIQUE NULLS NOT DISTINCT (ticket_id, kind, proposal_id)'),
    ('constraint itsupport.reviews.reviews_kind_check', 'constraint', 'reviews', 'reviews_kind_check', null, null,
      'CHECK ((kind = ANY (ARRAY[''triage''::text, ''autofix''::text])))'),
    ('constraint itsupport.reviews.reviews_decision_check', 'constraint', 'reviews', 'reviews_decision_check', null, null,
      'CHECK ((decision = ANY (ARRAY[''approve''::text, ''reject''::text, ''timeout''::text])))'),
    ('constraint itsupport.reviews.reviews_decided_check', 'constraint', 'reviews', 'reviews_decided_check', null, null,
      'CHECK (((decision IS NULL) = (decided_at IS NULL)))'),
    ('constraint itsupport.reviews.reviews_slack_user_check', 'constraint', 'reviews', 'reviews_slack_user_check', null, null,
      'CHECK ((((decision = ANY (ARRAY[''approve''::text, ''reject''::text])) IS TRUE) = (slack_user_id IS NOT NULL)))'),
    ('constraint itsupport.reviews.reviews_proposal_check', 'constraint', 'reviews', 'reviews_proposal_check', null, null,
      'CHECK (((kind = ''autofix''::text) = (proposal_id IS NOT NULL)))'),
    -- Exact lists: check constraints, columns, privileges (no delete, nothing for
    -- public, anon or authenticated), RLS, indexes, and no user trigger, rewrite
    -- rule or publication.
    ('checks itsupport.reviews', 'checks', 'reviews', null, null, null,
      'reviews_decided_check, reviews_decision_check, reviews_kind_check, '
      || 'reviews_proposal_check, reviews_slack_user_check'),
    ('columns itsupport.reviews', 'columns', 'reviews', null, null, null,
      'id, ticket_id, kind, proposal_id, slack_user_id, decision, decided_at, wait_token_id, slack_ts, created_at'),
    ('grants itsupport.reviews', 'grants', 'reviews', null, null, null,
      'service_role INSERT, service_role SELECT, service_role UPDATE'),
    ('privileges public itsupport.reviews', 'privileges', 'reviews', 'public', null, null,
      'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('privileges anon itsupport.reviews', 'privileges', 'reviews', 'anon', null, null,
      'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('privileges authenticated itsupport.reviews', 'privileges', 'reviews', 'authenticated', null, null,
      'select, insert, update, delete, truncate, references, trigger, maintain'),
    ('privileges service_role itsupport.reviews', 'privileges', 'reviews', 'service_role', 'select, insert, update', null,
      'delete, truncate, references, trigger, maintain'),
    ('rls itsupport.reviews', 'rls', 'reviews', null, null, null, null),
    ('indexes itsupport.reviews', 'indexes', 'reviews', null, null, null,
      'reviews_pkey, reviews_ticket_kind_proposal_key'),
    ('triggers itsupport.reviews', 'triggers', 'reviews', null, null, null, ''),
    ('rules itsupport.reviews', 'rules', 'reviews', null, null, null, ''),
    ('publications itsupport.reviews', 'publications', 'reviews', null, null, null, ''),
    ('owner itsupport.reviews', 'owner', 'reviews', null, null, null, null)
) as e (object, kind, tbl, name, udt, nullable, def)
order by e.object;
