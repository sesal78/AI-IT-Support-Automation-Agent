import { afterAll, beforeAll, expect, it } from "vitest";
import { parseTicketListQuery } from "@/lib/staff/ticket-list-filters";
import { listStaffTickets } from "@/lib/staff/ticket-list-query";
import { runSql } from "../../../packages/db/integration/pg-container.js";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import { signIn, startStaffStack, stopStaffStack, type SignedIn } from "./staff-stack.js";

let agent: SignedIn;
let nonstaff: SignedIn;

// Every timestamp is tied, so page 2 also proves the UUID tie-break.
const id = (n: number) => "11111111-1111-4111-8111-" + String(n).padStart(12, "0");
const list = (params = {}, e2eMode = false, user = agent) =>
  listStaffTickets(user.supabase, parseTicketListQuery(params, { e2eMode }).filters);

beforeAll(async () => {
  const stack = await startStaffStack();
  const staff = await createTestStaffUser(stack, { role: "agent" });
  const regular = await createTestStaffUser(stack);
  [agent, nonstaff] = await Promise.all([
    signIn(staff.email, staff.password),
    signIn(regular.email, regular.password),
  ]);
  expect(agent.response.status).toBe(200);
  expect(nonstaff.response.status).toBe(200);
  const seed = runSql(
    stack.pg,
    `
    insert into itsupport.tickets
      (id, source, raw_title, raw_description, requester_email, idempotency_key, status, is_test, created_at)
    select ('11111111-1111-4111-8111-' || lpad(n::text, 12, '0'))::uuid,
      'web', 'Private seed title', 'Private seed description', 'requester@example.test',
      'staff-list-' || n, case n when 117 then 'rejected' when 118 then 'escalated_manual'
      when 119 then 'review_pending' else 'new' end, n = 121, '2026-11-19T00:00:00Z'
    from generate_series(1, 121) as n;
    insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
      select id, 'Safe seed title', 'Safe seed description' from itsupport.tickets;
    insert into itsupport.triage_results (ticket_id, sensitive, sensitive_flags, checker, priority, category)
      select id, false, '[]', 'fixture', 'P2', 'network' from itsupport.tickets
      where id in ('${id(117)}', '${id(118)}', '${id(119)}', '${id(120)}');
    insert into itsupport.helpdesk_tickets (ticket_id, state, priority, category, assignee_id)
      values ('${id(120)}', 'on_hold', 'P1', 'hardware', (select id from itsupport.staff)),
             ('${id(118)}', 'new', 'P1', 'hardware', null),
             ('${id(110)}', 'in_progress', 'P4', 'software', null),
             ('${id(111)}', 'resolved', 'P4', 'software', null),
             ('${id(112)}', 'closed', 'P4', 'software', null);
  `,
  );
  if (seed.status !== 0) throw new Error("Could not create ticket list fixtures");
});
afterAll(stopStaffStack);

it("reads page 2 in stable order with the filtered count, and handles an empty page", async () => {
  const page = await list({ page: "2" });
  expect(page.rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, i) => id(i + 51)));
  expect(page).toMatchObject({ page: 2, pageCount: 3, total: 120 });
  expect(page.rows[0]).toMatchObject({
    ticketNumber: expect.stringMatching(/^ITS-/),
    redactedTitle: "Safe seed title",
  });
  expect(await list({ page: "99" })).toMatchObject({
    rows: [],
    page: 99,
    pageCount: 3,
    total: 120,
  });
  expect((await list({}, true)).total).toBe(121);
});

it.each([
  [{ status: "manual" }, [117, 118]],
  [{ status: "review_pending" }, [119]],
  [{ status: "new" }, [118]],
  [{ status: "in_progress" }, [110]],
  [{ status: "on_hold" }, [120]],
  [{ status: "resolved" }, [111]],
  [{ status: "closed" }, [112]],
  [{ priority: "P1" }, [118, 120]],
  [{ category: "network" }, [117, 119]],
  [{ status: "manual", priority: "P2", category: "network" }, [117]],
  [{ status: "on_hold", priority: "P1", category: "hardware" }, [120]],
  [{ status: "on_hold", priority: "P2", category: "network" }, []],
] as const)("returns exactly the matches for %j", async (filters, matches) => {
  const page = await list(filters);
  expect(page.rows.map((row) => row.id)).toEqual(matches.map(id));
  expect(page.total).toBe(matches.length);
});

it("keeps the helpdesk values and assignee, and blocks nonstaff reads through RLS", async () => {
  const { rows } = await list({ status: "on_hold" });
  expect(rows[0]).toMatchObject({
    id: id(120),
    helpdeskNumber: expect.stringMatching(/^HD/),
    priority: "P1",
    category: "hardware",
    assigneeName: "Test agent",
  });
  expect(await list({}, false, nonstaff)).toMatchObject({ rows: [], total: 0 });
});
