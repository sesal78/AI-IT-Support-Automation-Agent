-- 0008_itsupport_staff_access (check). Read-only. One row per object,
-- (object text, ok boolean): all ok = true after up, all false after down.
-- cols null = every column of the table. body: a read helper's exact SQL,
-- whitespace folded, so a weakened helper (no `active`, say) fails.
with t(name, cols) as (values
  ('tickets', 'id,source,department,status,servicenow_sys_id,servicenow_number,created_at,is_test,ticket_number,helpdesk'),
  ('ticket_redactions', 'ticket_id,redacted_title,redacted_description,created_at'),
  ('triage_results', null), ('ticket_events', null),
  ('reviews', 'id,ticket_id,kind,proposal_id,decision,decided_at,created_at,staff_id'),
  ('kb_articles', 'id,slug,title'), ('staff', 'id,display_name,role,active'),
  ('helpdesk_tickets', null), ('helpdesk_notes', null), ('helpdesk_assignments', null),
  ('helpdesk_state_transitions', null)),
f(name, body) as (values
  ('current_staff()', 'select id from itsupport.staff where auth_user_id = auth.uid() and active'),
  ('is_staff()', 'select itsupport.current_staff() is not null'),
  ('is_admin()', 'select exists (select 1 from itsupport.staff where auth_user_id = auth.uid() and active and role = ''admin'')'),
  ('staff_add_note(uuid,text)', null), ('staff_assign(uuid,uuid)', null),
  ('staff_set_state(uuid,text)', null))
select 'schema usage: authenticated' as object,
  has_schema_privilege('authenticated', 'itsupport', 'usage')
  and not has_schema_privilege('authenticated', 'itsupport', 'create')
  and not has_schema_privilege('anon', 'itsupport', 'usage, create')
  and not has_schema_privilege('public', 'itsupport', 'usage, create') as ok
union all
select 'function ' || f.name, coalesce((select p.prosecdef
    and p.provolatile = case when f.name like 'staff\_%' then 'v' else 's' end
    and p.proconfig = array['search_path=""']
    and (f.body is null or regexp_replace(btrim(p.prosrc, E' \t\r\n'), '\s+', ' ', 'g') = f.body)
    and has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute')
    and not has_function_privilege('public', p.oid, 'execute')
    and not has_function_privilege('service_role', p.oid, 'execute')
  from pg_proc p where p.oid = to_regprocedure('itsupport.' || f.name)), false)
from f
union all
select 'table ' || t.name, coalesce(c.relrowsecurity
  -- Exactly one policy on the table: the staff select policy.
  and (select count(*) = 1 and bool_and(p.policyname = t.name || '_staff_select'
      and p.permissive = 'PERMISSIVE' and p.cmd = 'SELECT' and p.roles = '{authenticated}'
      and p.qual = 'itsupport.is_staff()' and p.with_check is null)
    from pg_policies p where p.schemaname = 'itsupport' and p.tablename = t.name)
  and not has_table_privilege('authenticated', c.oid,
    'insert, update, delete, truncate, references, trigger, maintain')
  and not has_any_column_privilege('authenticated', c.oid, 'insert, update, references')
  and not exists (select from unnest(array['anon', 'public']) r
    where has_table_privilege(r, c.oid,
        'select, insert, update, delete, truncate, references, trigger, maintain')
      or has_any_column_privilege(r, c.oid, 'select, insert, update, references'))
  and (select array_agg(a.attname::text order by a.attname) from pg_attribute a
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', c.oid, a.attnum, 'select'))
  = (select array_agg(a.attname::text order by a.attname) from pg_attribute a
    where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      and (t.cols is null or a.attname = any (string_to_array(t.cols, ',')))), false)
from t left join pg_class c on c.oid = to_regclass('itsupport.' || t.name);
