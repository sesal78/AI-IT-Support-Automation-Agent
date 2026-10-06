-- 0003_itsupport_triage_kb (up)
--
-- Phase 3 (AI triage + KB) changes for the AI IT Support agent on the SHARED
-- Supabase stack. Touches only the `itsupport` schema. Requires 0001 and 0002.
-- Idempotent: safe to run more than once. Reverse with
-- 0003_itsupport_triage_kb.down.sql. Verify with
-- supabase/checks/0003_itsupport_triage_kb.check.sql.
-- Applying this to the shared Dokploy database is human step H13.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
--
-- Part 1: tickets and triage_results. Additive only: one column with a
-- default, nullable columns and check constraints. Existing phase-2 rows stay
-- valid (status `new`, all new triage columns null). Row level security and
-- the table privileges of 0001/0002 cover the new columns unchanged.
-- Check constraints are dropped and re-added by name so a re-run is a no-op.

-- 1. Tickets created by the e2e app or the test endpoints (plan §6.1 DoD 6).
alter table itsupport.tickets
  add column if not exists is_test boolean not null default false;

-- 2. The 12 ticket statuses (plan §2.6); must equal TICKET_STATUSES in
--    packages/shared/src/status.ts (a test compares them).
alter table itsupport.tickets drop constraint if exists tickets_status_check;
alter table itsupport.tickets add constraint tickets_status_check check (status in (
  'new', 'redacted', 'triaged', 'auto', 'helpdesk_pending', 'incident_created',
  'incident_skipped_shadow', 'review_pending', 'approved', 'rejected',
  'escalated_manual', 'failed'
));

-- 3. Triage output, nullable so phase-2 rows (sensitive check only) stay valid.
alter table itsupport.triage_results
  add column if not exists category text,
  add column if not exists subcategory text,
  add column if not exists priority text,
  add column if not exists urgency text,
  add column if not exists assignment_group text,
  add column if not exists route text,
  add column if not exists probabilities jsonb,
  add column if not exists flags text[],
  add column if not exists grounding_score numeric,
  add column if not exists kb_article_ids uuid[],
  add column if not exists suggested_fix jsonb,
  add column if not exists model_versions jsonb,
  add column if not exists triaged_at timestamptz;

-- A null value passes a check constraint, so each column stays optional.
alter table itsupport.triage_results
  drop constraint if exists triage_results_category_check,
  drop constraint if exists triage_results_priority_check,
  drop constraint if exists triage_results_route_check,
  drop constraint if exists triage_results_grounding_score_check;
alter table itsupport.triage_results
  -- The 6 dev420188 incident categories (docs/PROJECT.md §5).
  add constraint triage_results_category_check check (category in (
    'database', 'inquiry', 'software', 'hardware', 'password_reset', 'network'
  )),
  add constraint triage_results_priority_check check (priority in ('P1', 'P2', 'P3', 'P4')),
  add constraint triage_results_route_check check (route in ('auto', 'review')),
  add constraint triage_results_grounding_score_check
    check (grounding_score between 0 and 1);

-- Part 2: knowledge base articles (plan §6.1). Internal; written by the
-- kb-ingest task (P3-T5b). A new table, so no existing row is touched.
create table if not exists itsupport.kb_articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  content text not null,
  -- The 6 dev420188 incident categories, as in triage_results_category_check.
  category text not null constraint kb_articles_category_check check (category in (
    'database', 'inquiry', 'software', 'hardware', 'password_reset', 'network'
  )),
  assignment_group text not null,
  search tsvector generated always as (to_tsvector('english', title || ' ' || content)) stored
);
create index if not exists kb_articles_search_idx on itsupport.kb_articles using gin (search);

-- Row level security on, no policies. Only service_role may read, add or
-- change articles; nobody but the owner may delete them.
alter table itsupport.kb_articles enable row level security;
revoke all on itsupport.kb_articles from public, anon, authenticated, service_role;
grant select, insert, update on itsupport.kb_articles to service_role;

-- Part 2b: ranked KB search. PostgREST cannot order by ts_rank (resolved
-- point 4), so the pipeline calls this function. It declares its own result
-- columns, so it does not depend on the kb_articles row type.
-- websearch_to_tsquery never raises on user input; a blank, stop-word-only or
-- null query has no lexemes and matches nothing. The limit is clamped to
-- 1-20; null means the default, 5.
create or replace function itsupport.kb_search(p_query text, p_limit integer default 5)
returns table (
  id uuid, slug text, title text, content text, category text, assignment_group text, rank real
)
language sql
stable
set search_path = ''
as $$
  select id, slug, title, content, category, assignment_group, ts_rank(search, query) as rank
  from itsupport.kb_articles, websearch_to_tsquery('english', coalesce(p_query, '')) as query
  where search @@ query
  order by rank desc, slug
  limit greatest(1, least(coalesce(p_limit, 5), 20))
$$;

-- A new function is executable by public; only service_role may call this one.
revoke all on function itsupport.kb_search(text, integer) from public, anon, authenticated;
grant execute on function itsupport.kb_search(text, integer) to service_role;

-- Part 3: AI call metering (plan §6.1, resolved points 2-4). One row per
-- reservation; a TypeSafe call is one question, an LLM call one request.
-- The reservation function comes in P3-T2d2.
create table if not exists itsupport.ai_calls (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references itsupport.tickets (id) on delete restrict,
  provider text not null constraint ai_calls_provider_check check (provider in ('typesafe', 'llm')),
  kind text not null,
  calls integer not null default 1 constraint ai_calls_calls_check check (calls > 0),
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric,
  environment text not null,
  at timestamptz not null default now()
);
create index if not exists ai_calls_provider_at_idx on itsupport.ai_calls (provider, at);

-- Row level security on, no policies. Only service_role may read, add or
-- change rows; nobody but the owner may delete them.
alter table itsupport.ai_calls enable row level security;
revoke all on itsupport.ai_calls from public, anon, authenticated, service_role;
grant select, insert, update on itsupport.ai_calls to service_role;

-- Usage per provider for the UTC month that contains p_month_start. The
-- month bounds are computed in UTC, so the session time zone does not matter.
create or replace function itsupport.ai_usage_month(p_month_start date)
returns table (provider text, calls bigint, tokens_in bigint, tokens_out bigint, cost_usd numeric)
language sql
stable
set search_path = ''
as $$
  select provider, sum(calls), sum(tokens_in), sum(tokens_out), sum(cost_usd)
  from itsupport.ai_calls
  where at >= date_trunc('month', p_month_start::timestamp) at time zone 'UTC'
    and at < (date_trunc('month', p_month_start::timestamp) + interval '1 month') at time zone 'UTC'
  group by provider
  order by provider
$$;

-- A new function is executable by public; only service_role may call this one.
revoke all on function itsupport.ai_usage_month(date) from public, anon, authenticated;
grant execute on function itsupport.ai_usage_month(date) to service_role;
