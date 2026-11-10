import { readFileSync } from "node:fs";

// Shared by the 0008 tests (P5-T11a): the migration files and one seeded row
// in every table 0008 grants on. Fake values only.
const file = (f: string) =>
  readFileSync(new URL(`../../../supabase/${f}`, import.meta.url), "utf8");
export const migration = (name: string) => file(`migrations/${name}`);
export const UP = file("migrations/0008_itsupport_staff_access.sql");
export const DOWN = file("migrations/0008_itsupport_staff_access.down.sql");
export const CHECK = file("checks/0008_itsupport_staff_access.check.sql");

export const SEED = `with t as (insert into itsupport.tickets (source, raw_title, raw_description,
    requester_email, idempotency_key) values ('web', 'r', 'r', 'r@example.test', 'k') returning id),
  r as (insert into itsupport.ticket_redactions select id, 't', 'd' from t),
  g as (insert into itsupport.triage_results (ticket_id, sensitive, sensitive_flags, checker)
    select id, false, '[]', 'c' from t),
  e as (insert into itsupport.ticket_events (ticket_id, type) select id, 'x' from t),
  v as (insert into itsupport.reviews (ticket_id, kind, wait_token_id, slack_ts)
    select id, 'triage', 'w', 's' from t),
  k as (insert into itsupport.kb_articles (slug, title, content, category, assignment_group)
    values ('s', 't', 'c', 'network', 'g')),
  s as (insert into itsupport.staff (auth_user_id, email, display_name, role)
    values (gen_random_uuid(), 'seed@example.test', 'Seed', 'agent') returning id),
  h as (insert into itsupport.helpdesk_tickets (ticket_id, priority, category)
    select id, 'P3', 'network' from t returning id),
  n as (insert into itsupport.helpdesk_notes (helpdesk_ticket_id, author_kind, body)
    select id, 'system', 'b' from h)
  insert into itsupport.helpdesk_assignments (helpdesk_ticket_id, assignee_id)
    select h.id, s.id from h, s`;
