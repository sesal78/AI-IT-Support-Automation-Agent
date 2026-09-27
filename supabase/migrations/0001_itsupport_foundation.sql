-- 0001_itsupport_foundation (up)
--
-- Foundation for the AI IT Support agent on the SHARED Supabase stack.
-- Touches only the `itsupport` schema and enables `vector` in `extensions`.
-- Idempotent: safe to run more than once. Reverse with
-- 0001_itsupport_foundation.down.sql (which keeps the vector extension).
-- Applying this to the shared Dokploy database is human step H4.

-- 1. Dedicated schema for this project.
create schema if not exists itsupport;

-- 2. pgvector, in Supabase's shared extensions schema (used from phase 3).
create extension if not exists vector with schema extensions;

-- 3. Base tables (docs/PROJECT.md §5 data model sketch).

-- Raw tickets. Confidential (synthetic data in the demo).
create table if not exists itsupport.tickets (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('web', 'email')),
  raw_title text not null,
  raw_description text not null,
  requester_email text not null,
  requester_name text,
  department text,
  status text not null default 'new',
  servicenow_sys_id text,
  servicenow_number text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

-- Append-only audit log. Internal.
create table if not exists itsupport.ticket_events (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references itsupport.tickets (id),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index if not exists ticket_events_ticket_id_at_idx
  on itsupport.ticket_events (ticket_id, at);

-- Append-only guard: rejects UPDATE, DELETE and TRUNCATE for every role,
-- including roles that bypass RLS or hold table privileges.
create or replace function itsupport.reject_ticket_event_change()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  raise exception 'ticket_events is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists ticket_events_append_only_row on itsupport.ticket_events;
create trigger ticket_events_append_only_row
  before update or delete on itsupport.ticket_events
  for each row execute function itsupport.reject_ticket_event_change();

drop trigger if exists ticket_events_append_only_truncate on itsupport.ticket_events;
create trigger ticket_events_append_only_truncate
  before truncate on itsupport.ticket_events
  for each statement execute function itsupport.reject_ticket_event_change();

-- 4. Row level security: enabled, no policies, so deny by default.
alter table itsupport.tickets enable row level security;
alter table itsupport.ticket_events enable row level security;

-- Privileges: only service_role (server-side code) may use this schema.
revoke all on schema itsupport from public, anon, authenticated;
revoke all on all tables in schema itsupport from public, anon, authenticated;
revoke all on function itsupport.reject_ticket_event_change() from public, anon, authenticated;

grant usage on schema itsupport to service_role;
grant select, insert, update, delete on itsupport.tickets to service_role;
grant select, insert on itsupport.ticket_events to service_role;
revoke update, delete, truncate on itsupport.ticket_events from service_role;
