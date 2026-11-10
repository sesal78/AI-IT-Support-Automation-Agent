-- 0008_itsupport_staff_access (check). Read-only. One row per object,
-- (object text, ok boolean): all ok = true after up, all false after down.
-- cols null = every column of the table.
with t(name, cols) as (values
  ('tickets', 'id,source,department,status,servicenow_sys_id,servicenow_number,created_at,is_test,ticket_number,helpdesk'),
  ('ticket_redactions', 'ticket_id,redacted_title,redacted_description,created_at'),
  ('triage_results', null), ('ticket_events', null),
  ('reviews', 'id,ticket_id,kind,proposal_id,decision,decided_at,created_at,staff_id'),
  ('kb_articles', 'id,slug,title'), ('staff', 'id,display_name,role,active'),
  ('helpdesk_tickets', null), ('helpdesk_notes', null), ('helpdesk_assignments', null),
  ('helpdesk_state_transitions', null))
select 'schema usage: authenticated' as object,
  has_schema_privilege('authenticated', 'itsupport', 'usage') as ok
union all
select 'function ' || f, coalesce((select p.prosecdef
    and p.provolatile = case when f like 'staff\_%' then 'v' else 's' end
    and p.proconfig = array['search_path=""'] and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('service_role', p.oid, 'execute')
  from pg_proc p where p.oid = to_regprocedure('itsupport.' || f)), false)
from unnest(array['current_staff()', 'is_staff()', 'is_admin()',
  'staff_add_note(uuid,text)']) f
union all
select 'table ' || t.name, coalesce(c.relrowsecurity
  and exists (select 1 from pg_policies p where p.schemaname = 'itsupport' and p.tablename = t.name
    and p.policyname = t.name || '_staff_select' and p.cmd = 'SELECT'
    and p.roles = '{authenticated}' and p.qual = 'itsupport.is_staff()')
  and not has_table_privilege('authenticated', c.oid, 'insert,update,delete,truncate,references,trigger')
  and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', c.oid, a.attnum, 'select'))
  = (select array_agg(a.attname::text order by a.attname) from pg_attribute a
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      and (t.cols is null or a.attname = any (string_to_array(t.cols, ',')))), false)
from t left join pg_class c on c.oid = to_regclass('itsupport.' || t.name);
