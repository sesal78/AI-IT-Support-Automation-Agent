-- 0003_itsupport_triage_kb (check)
--
-- Read-only verification of migration 0003, for human step H13 and the
-- integration test. Returns one row per object 0003 creates: (object, ok).
-- After the up file every row is ok = true; after the down file every row is
-- ok = false. A column is ok when it exists with the expected type,
-- nullability and default (or `generated <expression>`); a constraint (check,
-- primary key or unique) or an index is ok when it exists and its definition
-- is exactly the expected one (Postgres 17). A function is ok when its
-- language, arguments, result, volatility, security, strictness, settings,
-- body (MD5 with carriage returns removed, so CRLF and LF checkouts agree) and
-- the grants held by roles other than its owner are exactly the expected ones.
-- A numeric column carries its precision and scale (numeric(5,2) is not
-- numeric). `checks`, `columns` and `grants` rows list every check constraint,
-- column, or table and column privilege held by a role other than the owner,
-- so anything extra or missing fails. `rls` means RLS on with no policies.

select e.object,
  case e.kind
    when 'column' then exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'itsupport' and c.table_name = e.tbl
        and c.column_name = e.name and c.is_nullable = e.nullable
        and c.udt_name || case when c.data_type = 'numeric'
          then coalesce('(' || c.numeric_precision || ',' || c.numeric_scale || ')', '') else '' end = e.udt
        and coalesce('generated ' || c.generation_expression, c.column_default)
          is not distinct from e.def
    )
    when 'index' then exists (
      select 1 from pg_catalog.pg_indexes i
      where i.schemaname = 'itsupport' and i.tablename = e.tbl
        and i.indexname = e.name and i.indexdef = e.def
    )
    when 'function' then exists (
      select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_language l on l.oid = p.prolang
      where p.oid = to_regprocedure('itsupport.' || e.name) and l.lanname = e.udt
        and concat_ws(' ', pg_get_function_arguments(p.oid), '->', pg_get_function_result(p.oid),
          p.provolatile, p.prosecdef, p.proisstrict, p.proconfig, (
            select string_agg(case x.grantee when 0 then 'public' else pg_get_userbyid(x.grantee) end
              || '=' || x.privilege_type, ',' order by x.grantee)
            from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
            where x.grantee <> p.proowner
          ), md5(replace(p.prosrc, chr(13), ''))) = e.def
    )
    when 'collation' then exists (
      select 1 from pg_catalog.pg_attribute a join pg_catalog.pg_collation k on k.oid = a.attcollation
      where a.attrelid = to_regclass('itsupport.' || e.tbl) and a.attname = e.name and k.collname = e.def
    )
    when 'rls' then exists (
      select 1 from pg_catalog.pg_class r
      where r.oid = to_regclass('itsupport.' || e.tbl) and r.relrowsecurity
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
    when 'grants' then e.def = (
      select coalesce(string_agg(w.who || ' ' || g.priv, ', ' order by w.who, g.priv), '')
      from (
        select x.grantee, x.privilege_type
        from pg_catalog.pg_class r, aclexplode(coalesce(r.relacl, acldefault('r', r.relowner))) x
        where r.oid = to_regclass('itsupport.' || e.tbl) and x.grantee <> r.relowner
        union all
        select x.grantee, a.attname || '.' || x.privilege_type
        from pg_catalog.pg_attribute a, aclexplode(a.attacl) x
        where a.attrelid = to_regclass('itsupport.' || e.tbl)
      ) as g (grantee, priv),
      lateral (select case g.grantee when 0 then 'public' else pg_get_userbyid(g.grantee) end) as w (who)
    )
    else exists (
      select 1 from pg_catalog.pg_constraint k
      join pg_catalog.pg_class r on r.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'itsupport' and r.relname = e.tbl
        and k.conname = e.name and k.contype in ('c', 'p', 'u')
        and pg_get_constraintdef(k.oid) = e.def
    )
  end as ok
from (
  values
    -- Part 1: tickets.
    ('column itsupport.tickets.is_test', 'column', 'tickets', 'is_test', 'bool', 'NO', 'false'),
    ('constraint itsupport.tickets.tickets_status_check', 'constraint', 'tickets', 'tickets_status_check', null, null,
      'CHECK ((status = ANY (ARRAY['
      || '''new''::text, ''redacted''::text, ''triaged''::text, ''auto''::text, '
      || '''helpdesk_pending''::text, ''incident_created''::text, ''incident_skipped_shadow''::text, '
      || '''review_pending''::text, ''approved''::text, ''rejected''::text, '
      || '''escalated_manual''::text, ''failed''::text])))'),
    -- Part 1: triage_results (nullable, no default).
    ('column itsupport.triage_results.category', 'column', 'triage_results', 'category', 'text', 'YES', null),
    ('column itsupport.triage_results.subcategory', 'column', 'triage_results', 'subcategory', 'text', 'YES', null),
    ('column itsupport.triage_results.priority', 'column', 'triage_results', 'priority', 'text', 'YES', null),
    ('column itsupport.triage_results.urgency', 'column', 'triage_results', 'urgency', 'text', 'YES', null),
    ('column itsupport.triage_results.assignment_group', 'column', 'triage_results', 'assignment_group', 'text', 'YES', null),
    ('column itsupport.triage_results.route', 'column', 'triage_results', 'route', 'text', 'YES', null),
    ('column itsupport.triage_results.probabilities', 'column', 'triage_results', 'probabilities', 'jsonb', 'YES', null),
    ('column itsupport.triage_results.flags', 'column', 'triage_results', 'flags', '_text', 'YES', null),
    ('column itsupport.triage_results.grounding_score', 'column', 'triage_results', 'grounding_score', 'numeric', 'YES', null),
    ('column itsupport.triage_results.kb_article_ids', 'column', 'triage_results', 'kb_article_ids', '_uuid', 'YES', null),
    ('column itsupport.triage_results.suggested_fix', 'column', 'triage_results', 'suggested_fix', 'jsonb', 'YES', null),
    ('column itsupport.triage_results.model_versions', 'column', 'triage_results', 'model_versions', 'jsonb', 'YES', null),
    ('column itsupport.triage_results.triaged_at', 'column', 'triage_results', 'triaged_at', 'timestamptz', 'YES', null),
    ('constraint itsupport.triage_results.triage_results_category_check', 'constraint', 'triage_results', 'triage_results_category_check', null, null,
      'CHECK ((category = ANY (ARRAY['
      || '''database''::text, ''inquiry''::text, ''software''::text, '
      || '''hardware''::text, ''password_reset''::text, ''network''::text])))'),
    ('constraint itsupport.triage_results.triage_results_priority_check', 'constraint', 'triage_results', 'triage_results_priority_check', null, null,
      'CHECK ((priority = ANY (ARRAY[''P1''::text, ''P2''::text, ''P3''::text, ''P4''::text])))'),
    ('constraint itsupport.triage_results.triage_results_route_check', 'constraint', 'triage_results', 'triage_results_route_check', null, null,
      'CHECK ((route = ANY (ARRAY[''auto''::text, ''review''::text])))'),
    ('constraint itsupport.triage_results.triage_results_grounding_score_check', 'constraint', 'triage_results', 'triage_results_grounding_score_check', null, null,
      'CHECK (((grounding_score >= (0)::numeric) AND (grounding_score <= (1)::numeric)))'),
    -- Part 2: kb_articles.
    ('column itsupport.kb_articles.id', 'column', 'kb_articles', 'id', 'uuid', 'NO', 'gen_random_uuid()'),
    ('column itsupport.kb_articles.slug', 'column', 'kb_articles', 'slug', 'text', 'NO', null),
    ('column itsupport.kb_articles.title', 'column', 'kb_articles', 'title', 'text', 'NO', null),
    ('column itsupport.kb_articles.content', 'column', 'kb_articles', 'content', 'text', 'NO', null),
    ('column itsupport.kb_articles.category', 'column', 'kb_articles', 'category', 'text', 'NO', null),
    ('column itsupport.kb_articles.assignment_group', 'column', 'kb_articles', 'assignment_group', 'text', 'NO', null),
    ('column itsupport.kb_articles.search', 'column', 'kb_articles', 'search', 'tsvector', 'YES',
      'generated to_tsvector(''english''::regconfig, ((title || '' ''::text) || content))'),
    ('constraint itsupport.kb_articles.kb_articles_pkey', 'constraint', 'kb_articles', 'kb_articles_pkey', null, null,
      'PRIMARY KEY (id)'),
    ('constraint itsupport.kb_articles.kb_articles_slug_key', 'constraint', 'kb_articles', 'kb_articles_slug_key', null, null,
      'UNIQUE (slug)'),
    ('constraint itsupport.kb_articles.kb_articles_category_check', 'constraint', 'kb_articles', 'kb_articles_category_check', null, null,
      'CHECK ((category = ANY (ARRAY['
      || '''database''::text, ''inquiry''::text, ''software''::text, '
      || '''hardware''::text, ''password_reset''::text, ''network''::text])))'),
    ('index itsupport.kb_articles.kb_articles_search_idx', 'index', 'kb_articles', 'kb_articles_search_idx', null, null,
      'CREATE INDEX kb_articles_search_idx ON itsupport.kb_articles USING gin (search)'),
    -- Part 2b: kb_search (stable, invoker rights, empty search_path, execute for service_role only).
    ('function itsupport.kb_search', 'function', null, 'kb_search(text, integer)', 'sql', null,
      'p_query text, p_limit integer DEFAULT 5 -> TABLE(id uuid, slug text, title text, content text, '
      || 'category text, assignment_group text, rank real) s f f {"search_path=\"\""} service_role=EXECUTE '
      || '23931aae659bf152717db289277f2288'),
    -- Exact lists: check constraints of every 0003 table; kb_articles columns,
    -- privileges (no delete, nothing for anon or authenticated), RLS and slug collation.
    ('checks itsupport.tickets', 'checks', 'tickets', null, null, null, 'tickets_source_check, tickets_status_check'),
    ('checks itsupport.triage_results', 'checks', 'triage_results', null, null, null,
      'triage_results_category_check, triage_results_grounding_score_check, '
      || 'triage_results_priority_check, triage_results_route_check'),
    ('checks itsupport.kb_articles', 'checks', 'kb_articles', null, null, null, 'kb_articles_category_check'),
    ('columns itsupport.kb_articles', 'columns', 'kb_articles', null, null, null,
      'id, slug, title, content, category, assignment_group, search'),
    ('grants itsupport.kb_articles', 'grants', 'kb_articles', null, null, null,
      'service_role INSERT, service_role SELECT, service_role UPDATE'),
    ('rls itsupport.kb_articles', 'rls', 'kb_articles', null, null, null, null),
    ('collation itsupport.kb_articles.slug', 'collation', 'kb_articles', 'slug', null, null, 'default')
) as e (object, kind, tbl, name, udt, nullable, def)
order by e.object;
