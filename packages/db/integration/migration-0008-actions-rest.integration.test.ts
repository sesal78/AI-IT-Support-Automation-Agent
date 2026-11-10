import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED, UP } from "./migration-0008-harness.js";
import { clientFor, runSql } from "./pg-container.js";
import { removeRestStack, startRestStack, type RestStack } from "./rest-stack.js";
import { createTestStaffUser } from "./test-users.js";

// P5-T11b, layer D: the staff_* functions through PostgREST with real GoTrue
// JWTs on the local REST stack. Rules and the lock test are in
// migration-0008-actions.integration.test.ts.
let stack: RestStack;
let hd = "";
let agentStaffId = "";
let assigneeStaffId = "";
const tokens = { agent: "", inactive: "", none: "" };

async function query<T = Record<string, unknown>>(text: string) {
  const db = clientFor(stack.pg);
  await db.connect();
  try {
    return (await db.query(text)).rows as T[];
  } finally {
    await db.end();
  }
}
const COUNTS = `select (select count(*) from itsupport.helpdesk_notes) || '/' ||
  (select count(*) from itsupport.helpdesk_assignments) || '/' ||
  (select count(*) from itsupport.ticket_events) || '/' ||
  (select state from itsupport.helpdesk_tickets) as c`;
const counts = async () => (await query<{ c: string }>(COUNTS))[0]?.c;

async function rpc(fn: string, args: Record<string, string>, token?: string) {
  const res = await fetch(`${stack.url}/rest/v1/rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify(args),
    headers: {
      "content-profile": "itsupport",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return (await res.json()) as unknown;
}
const CALLS = (assignee: string): [string, Record<string, string>][] => [
  ["staff_add_note", { helpdesk_ticket_id: hd, body: "<i>note</i>" }],
  ["staff_assign", { helpdesk_ticket_id: hd, assignee_id: assignee }],
  ["staff_set_state", { helpdesk_ticket_id: hd, to_state: "in_progress" }],
];

beforeAll(async () => {
  stack = await startRestStack();
  for (const [key, opts] of [
    ["agent", { role: "agent" }],
    ["inactive", { role: "agent", active: false }],
    ["none", {}],
  ] as const) {
    const user = await createTestStaffUser(stack, opts);
    if (key === "agent") agentStaffId = user.staffId!;
    const res = await fetch(`${stack.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    tokens[key] = ((await res.json()) as { access_token: string }).access_token;
  }
  assigneeStaffId = (await createTestStaffUser(stack, { role: "agent" })).staffId!;
  expect(runSql(stack.pg, `${SEED};\n${UP}\nnotify pgrst, 'reload schema';`).status).toBe(0);
  hd = (await query<{ id: string }>("select id from itsupport.helpdesk_tickets"))[0]!.id;
  // Wait until PostgREST's schema cache has the 0008 functions.
  for (let i = 0; i < 120 && (await rpc("is_staff", {}, tokens.agent)) !== true; i++)
    await new Promise((done) => setTimeout(done, 250));
}, 300_000);
afterAll(() => removeRestStack(stack));

describe("migration 0008 staff actions (PostgREST + JWT)", () => {
  it("refuses anon, service_role, non-staff and inactive staff with 42501, writing nothing", async () => {
    const before = await counts();
    for (const token of [undefined, stack.serviceRoleKey, tokens.none, tokens.inactive])
      for (const [fn, args] of CALLS(assigneeStaffId))
        expect(await rpc(fn, args, token), fn).toMatchObject({ code: "42501" });
    expect(await counts()).toBe(before);
  });

  it("lets an active staff JWT note, assign and change state, one event each", async () => {
    const [note, assign, state] = CALLS(assigneeStaffId);
    const noteId = await rpc(note![0], note![1], tokens.agent);
    await rpc(assign![0], assign![1], tokens.agent);
    expect(await rpc(state![0], state![1], tokens.agent)).toBe("in_progress");
    expect(
      await query(
        "select type, payload from itsupport.ticket_events where type like 'staff_%' order by id",
      ),
    ).toEqual([
      { type: "staff_note_added", payload: { noteId, staffId: agentStaffId } },
      {
        type: "staff_assigned",
        payload: { helpdeskTicketId: hd, staffId: agentStaffId, assigneeId: assigneeStaffId },
      },
      {
        type: "staff_state_changed",
        payload: { helpdeskTicketId: hd, staffId: agentStaffId, from: "new", to: "in_progress" },
      },
    ]);
  });
});
