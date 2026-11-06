-- 0005_itsupport_reviews (up)
--
-- Phase 4 (human review), part 1: the itsupport.reviews table, for the AI IT
-- Support agent on the SHARED Supabase stack. One row per Slack review of a
-- ticket: a triage review, or an auto-fix review of one proposal. Internal
-- data (docs/PROJECT.md §5); slack_user_id holds a Slack user ID, not a name.
-- Touches only the `itsupport` schema. Requires 0001 to 0004.
-- Idempotent: safe to run more than once. Reverse with
-- 0005_itsupport_reviews.down.sql. Verify with
-- supabase/checks/0005_itsupport_reviews.check.sql.
-- Applying this to the shared Supabase database is human step H15.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- The down file is DESTRUCTIVE (it drops the table and every review row); it
-- needs human approval.
-- No identity column, so no sequence is created and 0004 needs no change.

create table if not exists itsupport.reviews (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null
    constraint reviews_ticket_id_fkey references itsupport.tickets (id) on delete restrict,
  kind text not null,
  proposal_id uuid,
  slack_user_id text,
  decision text,
  decided_at timestamptz,
  wait_token_id text not null,
  slack_ts text,
  created_at timestamptz not null default now()
);

-- Row checks and the unique key are dropped and re-added by name, so a re-run
-- is a no-op and leaves the expected definitions.
alter table itsupport.reviews
  drop constraint if exists reviews_kind_check,
  drop constraint if exists reviews_decision_check,
  drop constraint if exists reviews_decided_check,
  drop constraint if exists reviews_slack_user_check,
  drop constraint if exists reviews_proposal_check,
  drop constraint if exists reviews_ticket_kind_proposal_key;
alter table itsupport.reviews
  add constraint reviews_kind_check check (kind in ('triage', 'autofix')),
  -- A null decision means the review is still open.
  add constraint reviews_decision_check check (decision in ('approve', 'reject', 'timeout')),
  -- A decided row has a decision time; an open row has none.
  add constraint reviews_decided_check check ((decision is null) = (decided_at is null)),
  -- approve and reject name the Slack user who decided; timeout and an open
  -- row name nobody. `is true` turns a null decision into false.
  add constraint reviews_slack_user_check
    check (((decision in ('approve', 'reject')) is true) = (slack_user_id is not null)),
  -- A triage review has no proposal; an auto-fix review reviews exactly one.
  add constraint reviews_proposal_check check ((kind = 'autofix') = (proposal_id is not null)),
  -- NULLS NOT DISTINCT (Postgres 15+): two triage rows (proposal_id null) of
  -- one ticket collide, so a ticket has at most one triage review.
  add constraint reviews_ticket_kind_proposal_key
    unique nulls not distinct (ticket_id, kind, proposal_id);

-- Row level security on, no policies. Only service_role may read, add or
-- change reviews; nobody but the owner may delete them. service_role is
-- revoked first because default privileges may have granted it more.
alter table itsupport.reviews enable row level security;
revoke all on table itsupport.reviews from public, anon, authenticated, service_role;
grant select, insert, update on table itsupport.reviews to service_role;
