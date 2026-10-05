-- 0003_itsupport_triage_kb (check)
--
-- Read-only verification of migration 0003, for human step H13 and the
-- integration test. Returns one row per object 0003 creates: (object, ok).
-- After the up file every row is ok = true; after the down file every row is
-- ok = false. A column is ok when it exists with the expected type,
-- nullability and default; a constraint is ok when the check constraint exists
-- and pg_get_constraintdef returns exactly the expected definition (Postgres 17).

select e.object,
  case e.kind
    when 'column' then exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'itsupport' and c.table_name = e.tbl
        and c.column_name = e.name and c.udt_name = e.udt and c.is_nullable = e.nullable
        and c.column_default is not distinct from e.def
    )
    else exists (
      select 1 from pg_catalog.pg_constraint k
      join pg_catalog.pg_class r on r.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = r.relnamespace
      where n.nspname = 'itsupport' and r.relname = e.tbl
        and k.conname = e.name and k.contype = 'c'
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
      'CHECK (((grounding_score >= (0)::numeric) AND (grounding_score <= (1)::numeric)))')
) as e (object, kind, tbl, name, udt, nullable, def)
order by e.object;
