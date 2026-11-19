import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { POST } from "@/app/staff/tickets/[id]/actions/route";
import { getStaffTicket, listActiveStaff } from "@/lib/staff/ticket-detail-query";
import { runSql } from "../../../packages/db/integration/pg-container.js";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import { clientOn, Jar, signIn, startStaffStack, stopStaffStack } from "./staff-stack.js";

const { createServerSupabaseClient } = vi.hoisted(() => ({
  createServerSupabaseClient: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));
vi.mock("@/env", () => ({ env: { HELPDESK: "builtin", E2E_MODE: false } }));

const ticket = "11111111-1111-4111-8111-000000000011";
const manual = "11111111-1111-4111-8111-000000000022";
const testTicket = "11111111-1111-4111-8111-000000000033";
const refusalTicket = "11111111-1111-4111-8111-000000000044";
let agent: ReturnType<typeof clientOn>;
let admin: ReturnType<typeof clientOn>;
let inactiveId: string;
let adminId: string;

beforeAll(async () => {
  const stack = await startStaffStack();
  const users = await Promise.all([
    createTestStaffUser(stack, { role: "agent" }),
    createTestStaffUser(stack, { role: "admin" }),
    createTestStaffUser(stack, { role: "agent", active: false }),
  ]);
  const [agentSession, adminSession] = await Promise.all(
    users.slice(0, 2).map(({ email, password }) => signIn(email, password)),
  );
  expect(agentSession!.response.status).toBe(200);
  expect(adminSession!.response.status).toBe(200);
  agent = agentSession!.supabase;
  admin = adminSession!.supabase;
  const { data, error } = await agent.from("staff").select("id,role,active");
  expect(error).toBeNull();
  adminId = data!.find((row) => row.role === "admin")!.id;
  inactiveId = data!.find((row) => !row.active)!.id;

  const seed = runSql(
    stack.pg,
    `
    insert into itsupport.tickets
      (id, source, raw_title, raw_description, requester_email, idempotency_key, is_test)
    values ('${ticket}', 'web', 'Private', 'Private', 'requester@example.test', 'staff-actions-normal', false),
      ('${manual}', 'web', 'Private', 'Private', 'requester@example.test', 'staff-actions-manual', false),
      ('${testTicket}', 'web', 'Private', 'Private', 'requester@example.test', 'staff-actions-test', true),
      ('${refusalTicket}', 'web', 'Private', 'Private', 'requester@example.test', 'staff-actions-refusal', false);
    insert into itsupport.helpdesk_tickets (ticket_id, priority, category, state)
    values ('${ticket}', 'P2', 'network', 'new'), ('${testTicket}', 'P2', 'network', 'new'),
      ('${refusalTicket}', 'P2', 'network', 'in_progress');
  `,
  );
  if (seed.status !== 0) throw new Error("Could not seed staff action fixtures");
});
afterAll(stopStaffStack);

function post(id: string, body: unknown, fetchSite = "same-origin") {
  return POST(
    new Request(`https://example.test/staff/tickets/${id}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": fetchSite },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

const detail = () => getStaffTicket(agent, ticket, false);

it("returns 401 without a session and commits no rows", async () => {
  createServerSupabaseClient.mockResolvedValue(clientOn(new Jar()));
  const before = await detail();
  const result = await post(ticket, { kind: "note", body: "Unauthenticated note" });
  expect(result.status).toBe(401);
  expect(await detail()).toEqual(before);
});

it("applies both roles' actions and shows exactly one history event per accepted call", async () => {
  createServerSupabaseClient.mockResolvedValue(agent);
  const assignees = (await listActiveStaff(agent)).map((staff) => staff.id);
  expect(assignees).not.toContain(inactiveId);
  expect(assignees).toContain(adminId);
  const notes = await Promise.all([
    post(ticket, { kind: "note", body: "First staff note" }),
    post(ticket, { kind: "note", body: "Second staff note" }),
  ]);
  expect(notes.map((result) => result.status)).toEqual([204, 204]);
  expect((await post(ticket, { kind: "assign", assigneeId: adminId })).status).toBe(204);
  createServerSupabaseClient.mockResolvedValue(admin);
  expect((await post(ticket, { kind: "state", toState: "in_progress" })).status).toBe(204);
  const result = await detail();
  expect(result?.helpdesk).toMatchObject({
    state: "in_progress",
    assignee: { display_name: "Test admin" },
  });
  expect(result?.history.map(({ label }) => label).sort()).toEqual([
    "Assigned to Test admin",
    "Note by Test agent",
    "Note by Test agent",
    "Staff assigned",
    "Staff note added",
    "Staff note added",
    "Staff state changed",
  ]);
  expect(result?.history.flatMap(({ body }) => body ?? []).sort()).toEqual([
    "Assigned by Test agent",
    "First staff note",
    "Second staff note",
  ]);
});

it("refuses illegal state changes, inactive assignees and tickets without visible helpdesk rows", async () => {
  createServerSupabaseClient.mockResolvedValue(agent);
  const getRefusalTicket = () => getStaffTicket(agent, refusalTicket, false);
  const before = await getRefusalTicket();
  const state = await post(refusalTicket, { kind: "state", toState: "closed" });
  expect(state.status).toBe(409);
  expect(await state.json()).toEqual({
    message: "That change is not allowed from in progress; the page was refreshed",
  });
  expect((await post(refusalTicket, { kind: "assign", assigneeId: inactiveId })).status).toBe(409);
  for (const id of [manual, testTicket]) {
    expect((await post(id, { kind: "note", body: "Refused note" })).status).toBe(404);
    expect((await getStaffTicket(agent, id, true))?.history).toEqual([]);
  }
  const manualRpc = await agent.rpc("staff_add_note", {
    helpdesk_ticket_id: manual,
    body: "Manual queue has no helpdesk row",
  });
  expect(manualRpc.error?.code).toBe("P0002");
  expect((await getStaffTicket(agent, manual, false))?.history).toEqual([]);
  expect(
    (await post(refusalTicket, { kind: "note", body: "Cross-site note" }, "cross-site")).status,
  ).toBe(403);
  for (const body of ["", "🌐".repeat(5001)]) {
    expect((await post(refusalTicket, { kind: "note", body })).status).toBe(400);
  }
  expect(await getRefusalTicket()).toEqual(before);
});
