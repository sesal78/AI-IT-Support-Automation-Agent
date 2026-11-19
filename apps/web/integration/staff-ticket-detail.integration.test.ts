import { afterAll, beforeAll, expect, it } from "vitest";
import { getStaffTicket } from "@/lib/staff/ticket-detail-query";
import { runSql } from "../../../packages/db/integration/pg-container.js";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import { signIn, startStaffStack, stopStaffStack, type SignedIn } from "./staff-stack.js";

const id = (n: number) => "11111111-1111-4111-8111-" + String(n).padStart(12, "0");
let agent: SignedIn;
let nonstaff: SignedIn;

beforeAll(async () => {
  const stack = await startStaffStack();
  const staff = await createTestStaffUser(stack, { role: "agent" });
  const user = await createTestStaffUser(stack);
  [agent, nonstaff] = await Promise.all([
    signIn(staff.email, staff.password),
    signIn(user.email, user.password),
  ]);
  expect(agent.response.status).toBe(200);
  expect(nonstaff.response.status).toBe(200);
  const seed = runSql(
    stack.pg,
    `
    insert into itsupport.tickets
      (id, source, raw_title, raw_description, requester_email, idempotency_key, is_test)
    select ('11111111-1111-4111-8111-' || lpad(n::text, 12, '0'))::uuid,
      'web', 'Private seed title', 'Private seed description', 'requester@example.test',
      'staff-detail-' || n, n = 3
    from generate_series(1,3) as n;
    insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
    values ('${id(1)}', 'Safe seed title', 'Safe seed description');
    insert into itsupport.kb_articles (id, slug, title, content, category, assignment_group)
    values ('${id(9)}', 'network-guide', 'Network guide', 'Private KB body', 'network', 'network');
    insert into itsupport.triage_results
      (ticket_id, sensitive, sensitive_flags, checker, category, priority, urgency, route,
        probabilities, kb_article_ids, suggested_fix)
    values ('${id(1)}', true, '["account_security"]', 'fixture', 'network',
      'P2', 'high', 'review', '{"priority":0.9}', array['${id(9)}']::uuid[],
      '{"steps":["Restart VPN"],"caveats":[]}');
    insert into itsupport.helpdesk_tickets (ticket_id, state, priority, category, assignee_id)
    values ('${id(1)}', 'in_progress', 'P2', 'network', (select id from itsupport.staff));
    insert into itsupport.ticket_events (ticket_id, type, at, payload)
    values ('${id(1)}', 'review_requested', '2026-11-19T00:00:00.000002Z', '{"private":"Private payload"}'),
      ('${id(2)}', 'escalated_manual', '2026-11-19T00:02:00Z', '{}');
    insert into itsupport.helpdesk_notes (helpdesk_ticket_id, author_kind, author_staff_id, body, created_at)
    values ((select id from itsupport.helpdesk_tickets), 'staff', (select id from itsupport.staff),
      'Staff note', '2026-11-19T00:00:00.000001Z');
    insert into itsupport.helpdesk_assignments (helpdesk_ticket_id, assignee_id, at)
    values ((select id from itsupport.helpdesk_tickets), (select id from itsupport.staff),
      '2026-11-19T00:02:00Z');
    -- Force the history reader to request its next page.
    insert into itsupport.ticket_events (ticket_id, type, at)
    select '${id(2)}', 'redacted', '2026-11-19T01:00:00Z'::timestamptz
    from generate_series(1, 250);
  `,
  );
  if (seed.status !== 0) throw new Error("Could not create ticket detail fixtures");
});
afterAll(stopStaffStack);

it("reads the safe detail and orders the three histories using the staff JWT", async () => {
  const detail = await getStaffTicket(agent.supabase, id(1), false);
  expect(detail).toMatchObject({
    ticket_number: expect.stringMatching(/^ITS-\d{6}$/),
    redaction: { redacted_title: "Safe seed title", redacted_description: "Safe seed description" },
    triage: {
      route: "review",
      probabilities: { priority: 0.9 },
      suggested_fix: { steps: ["Restart VPN"] },
    },
    articles: [{ slug: "network-guide", title: "Network guide" }],
    helpdesk: { state: "in_progress", assignee: { display_name: "Test agent" } },
  });
  expect(detail?.history.map((row) => row.label)).toEqual([
    "Note by Test agent",
    "Review requested",
    "Assigned to Test agent",
  ]);
  expect(JSON.stringify(detail)).not.toMatch(/Private|requester@example/);
});

it("handles manual tickets, multiple history pages and hidden or absent rows", async () => {
  const manual = await getStaffTicket(agent.supabase, id(2), false);
  expect(manual).toMatchObject({ helpdesk: null, redaction: null, triage: null });
  expect(manual?.history).toHaveLength(251);
  expect(manual?.history[0]?.label).toBe("Escalated manual");
  expect(await getStaffTicket(agent.supabase, id(3), false)).toBeNull();
  expect(await getStaffTicket(agent.supabase, id(3), true)).not.toBeNull();
  expect(await getStaffTicket(agent.supabase, id(4), false)).toBeNull();
  expect(await getStaffTicket(nonstaff.supabase, id(1), false)).toBeNull();
});
