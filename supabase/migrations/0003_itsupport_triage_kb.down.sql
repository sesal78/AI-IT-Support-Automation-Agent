-- 0003_itsupport_triage_kb (down)
--
-- Removes only what 0003 added. itsupport.tickets, ticket_events,
-- ticket_redactions, triage_results, their phase-2 columns and the schema
-- stay in place.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- DESTRUCTIVE: deletes all triage output, the is_test flags and the KB articles. Human approval required.
-- Parts are removed in reverse order: part 2 first, then part 1.

-- Part 2: kb_articles and its index.
drop index if exists itsupport.kb_articles_search_idx;
drop table if exists itsupport.kb_articles;

-- Part 1: triage_results columns and checks.
alter table itsupport.triage_results
  drop constraint if exists triage_results_category_check,
  drop constraint if exists triage_results_priority_check,
  drop constraint if exists triage_results_route_check,
  drop constraint if exists triage_results_grounding_score_check,
  drop column if exists category,
  drop column if exists subcategory,
  drop column if exists priority,
  drop column if exists urgency,
  drop column if exists assignment_group,
  drop column if exists route,
  drop column if exists probabilities,
  drop column if exists flags,
  drop column if exists grounding_score,
  drop column if exists kb_article_ids,
  drop column if exists suggested_fix,
  drop column if exists model_versions,
  drop column if exists triaged_at;

-- Part 1: tickets.is_test and the status check.
alter table itsupport.tickets
  drop constraint if exists tickets_status_check,
  drop column if exists is_test;
