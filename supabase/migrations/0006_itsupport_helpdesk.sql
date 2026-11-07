-- 0006_itsupport_helpdesk (up)
--
-- Phase 5 (helpdesk): the itsupport.notifications table (one row per reply
-- email of a ticket and kind), an index on tickets.servicenow_sys_id, and the
-- display-only ticket number ITS-000001 (tickets.ticket_number, filled by
-- itsupport.next_ticket_number() over itsupport.ticket_number_seq), for the
-- AI IT Support agent on the SHARED Supabase stack. Existing tickets are
-- numbered by a backfill in created_at order (ties by id) before the column
-- becomes not null, and the sequence continues after the highest number.
-- Touches only the `itsupport` schema. Requires 0001 to 0005.
-- Written in two parts (P5-T1a: objects; P5-T1b: backfill). Apply only the
-- complete 0006 (P5-T1a + P5-T1b), in one transaction: without the backfill,
-- `set not null` fails with 23502 on a stack that holds tickets.
-- Idempotent: safe to run more than once; a second run numbers nothing and
-- leaves the sequence where it was. Reverse with
-- 0006_itsupport_helpdesk.down.sql. Verify with
-- supabase/checks/0006_itsupport_helpdesk.check.sql; after 0006 the 0003,
-- 0004 and 0005 checks also stay all ok = true.
-- Applying this to the shared Supabase database is human step H28b.
-- Apply as ONE transaction: Supabase Studio runs a script as one transaction; with psql use --single-transaction.
-- The down file is DESTRUCTIVE (it drops every notification row, the index
-- and every ticket number); it needs human approval.
-- No identity column. The one new sequence is read only inside the security
-- definer function, so no role gets a sequence right and 0004's lock holds.

create table if not exists itsupport.notifications (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null
    constraint notifications_ticket_id_fkey references itsupport.tickets (id) on delete restrict,
  channel text not null,
  kind text not null,
  status text not null,
  provider_id text,
  reason text,
  at timestamptz not null default now()
);

-- Row checks and the unique key are dropped and re-added by name, so a re-run
-- is a no-op and leaves the expected definitions.
alter table itsupport.notifications
  drop constraint if exists notifications_channel_check,
  drop constraint if exists notifications_kind_check,
  drop constraint if exists notifications_status_check,
  drop constraint if exists notifications_reason_check,
  drop constraint if exists notifications_sent_check,
  drop constraint if exists notifications_skipped_check,
  drop constraint if exists notifications_failed_check,
  drop constraint if exists notifications_ticket_channel_kind_key;
alter table itsupport.notifications
  add constraint notifications_channel_check check (channel in ('email')),
  add constraint notifications_kind_check check (kind in ('incident_reply', 'needs_info')),
  add constraint notifications_status_check check (status in ('sent', 'skipped', 'failed')),
  add constraint notifications_reason_check check (reason in ('not_allow_listed', 'provider_error')),
  -- `is not distinct from` makes a null reason fail, where `=` would pass it.
  add constraint notifications_sent_check
    check (status <> 'sent' or (provider_id is not null and reason is null)),
  add constraint notifications_skipped_check
    check (status <> 'skipped' or (reason is not distinct from 'not_allow_listed' and provider_id is null)),
  add constraint notifications_failed_check
    check (status <> 'failed' or reason is not distinct from 'provider_error'),
  -- One email per ticket and kind, so a retried task cannot send twice.
  add constraint notifications_ticket_channel_kind_key unique (ticket_id, channel, kind);

-- Row level security on, no policies. Only service_role may read, add or
-- change notifications; nobody but the owner may delete them. service_role is
-- revoked first because default privileges may have granted it more.
alter table itsupport.notifications enable row level security;
revoke all on table itsupport.notifications from public, anon, authenticated, service_role;
grant select, insert, update on table itsupport.notifications to service_role;

create index if not exists tickets_servicenow_sys_id_idx on itsupport.tickets (servicenow_sys_id);

-- Ticket number. nextval fails with 2200H past 999999 (no cycle): a wider
-- format would be a later migration. No role gets any right on the sequence.
create sequence if not exists itsupport.ticket_number_seq
  as integer minvalue 1 maxvalue 999999 no cycle;
revoke all on sequence itsupport.ticket_number_seq from public, anon, authenticated, service_role;

-- Runs as its owner (the role that applies the migrations), so the inserting
-- role needs EXECUTE only, never a sequence right.
create or replace function itsupport.next_ticket_number()
  returns text
  language sql
  volatile
  security definer
  set search_path = ''
as $$
  select 'ITS-' || lpad(nextval('itsupport.ticket_number_seq')::text, 6, '0')
$$;
revoke all on function itsupport.next_ticket_number() from public, anon, authenticated, service_role;
grant execute on function itsupport.next_ticket_number() to service_role;

alter table itsupport.tickets add column if not exists ticket_number text;

-- Backfill: number every ticket that has no number, ITS- + 6 digits, in
-- created_at order (ties by id), after the highest number already given. The
-- `add column` above holds an ACCESS EXCLUSIVE lock on tickets until commit,
-- so no insert runs in between. Then the sequence continues after the highest
-- number. When nothing was numbered (no ticket, or a re-run) the sequence is
-- left where it is, so a re-run neither renumbers nor moves it.
with top (n) as (
  select coalesce(max(substr(ticket_number, 5)::integer), 0) from itsupport.tickets
),
todo (id, n) as (
  select t.id, top.n + row_number() over (order by t.created_at, t.id)
  from itsupport.tickets t, top
  where t.ticket_number is null
),
done (n) as (
  update itsupport.tickets t set ticket_number = 'ITS-' || lpad(todo.n::text, 6, '0')
  from todo where t.id = todo.id
  returning todo.n
)
select setval('itsupport.ticket_number_seq', max(done.n), true) from done having count(*) > 0;

alter table itsupport.tickets
  drop constraint if exists tickets_ticket_number_key,
  drop constraint if exists tickets_ticket_number_format;
alter table itsupport.tickets
  add constraint tickets_ticket_number_key unique (ticket_number),
  add constraint tickets_ticket_number_format check (ticket_number ~ '^ITS-[0-9]{6}$'),
  alter column ticket_number set default itsupport.next_ticket_number(),
  alter column ticket_number set not null;
