import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEED, UP } from "./migration-0008-harness.js";
import { runSql } from "./pg-container.js";
import { removeRestStack, startRestStack, type RestStack } from "./rest-stack.js";
import { createTestStaffUser } from "./test-users.js";

// P5-T11a, layer B: 0008 through PostgREST with real GoTrue JWTs on the local
// REST stack. Up/down cycles and the check query are in migration-0008.integration.test.ts.
const READ: Record<string, string> = {
  tickets: "id,status,ticket_number,helpdesk,is_test",
  ticket_redactions: "ticket_id,redacted_title,redacted_description",
  triage_results: "*",
  ticket_events: "*",
  reviews: "id,ticket_id,kind,decision,staff_id",
  kb_articles: "id,slug,title",
  staff: "id,display_name,role,active",
  helpdesk_tickets: "*",
  helpdesk_notes: "*",
  helpdesk_assignments: "*",
  helpdesk_state_transitions: "*",
};
const RAW: [string, string][] = [
  ["tickets", "raw_title"],
  ["tickets", "raw_description"],
  ["tickets", "requester_email"],
  ["tickets", "requester_name"],
  ["tickets", "idempotency_key"],
  ["ticket_redactions", "redaction_log"],
  ["reviews", "wait_token_id"],
  ["reviews", "slack_user_id"],
  ["reviews", "slack_ts"],
  ["kb_articles", "content"],
  ["staff", "email"],
  ["staff", "auth_user_id"],
];
// A column each write names (identity and missing `id` columns avoided).
const WRITE_COL: Record<string, string> = {
  ticket_redactions: "ticket_id",
  triage_results: "ticket_id",
  ticket_events: "ticket_id",
  helpdesk_state_transitions: "from_state",
};

let stack: RestStack;
const tokens = { agent: "", admin: "", inactive: "", none: "" };

async function rest(path: string, token?: string, method = "GET", body = "{}") {
  const res = await fetch(`${stack.url}/rest/v1/${path}`, {
    method,
    body: method === "GET" ? undefined : body,
    headers: {
      "accept-profile": "itsupport",
      "content-profile": "itsupport",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  return (await res.json()) as unknown[] & { code?: string };
}

beforeAll(async () => {
  stack = await startRestStack();
  for (const [key, opts] of [
    ["agent", { role: "agent" }],
    ["admin", { role: "admin" }],
    ["inactive", { role: "agent", active: false }],
    ["none", {}],
  ] as const) {
    const user = await createTestStaffUser(stack, opts);
    const res = await fetch(`${stack.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    tokens[key] = ((await res.json()) as { access_token: string }).access_token;
  }
  expect(runSql(stack.pg, `${SEED};\n${UP}\nnotify pgrst, 'reload schema';`).status).toBe(0);
  // Wait until PostgREST's schema cache has the 0008 functions.
  for (let i = 0; i < 120 && (await rest("rpc/is_staff", tokens.agent)).code === "PGRST202"; i++)
    await new Promise((done) => setTimeout(done, 250));
}, 300_000);
afterAll(() => removeRestStack(stack));

describe("migration 0008 staff read access (PostgREST + JWT)", () => {
  it("lets active staff read the granted columns of every table", async () => {
    for (const [table, cols] of Object.entries(READ))
      expect((await rest(`${table}?select=${cols}`, tokens.agent)).length, table).toBeGreaterThan(
        0,
      );
    expect(await rest("rpc/is_admin", tokens.admin, "POST")).toBe(true);
    expect(await rest("rpc/is_admin", tokens.agent, "POST")).toBe(false);
  });
  it("refuses raw and private columns with 42501", async () => {
    for (const [table, col] of RAW)
      expect((await rest(`${table}?select=${col}`, tokens.agent)).code, col).toBe("42501");
  });
  it("gives non-staff and inactive staff 0 rows, anon 42501", async () => {
    for (const [table, cols] of Object.entries(READ)) {
      expect(await rest(`${table}?select=${cols}`, tokens.none)).toEqual([]);
      expect(await rest(`${table}?select=${cols}`, tokens.inactive)).toEqual([]);
      expect((await rest(`${table}?select=${cols}`)).code, table).toBe("42501");
    }
    for (const fn of ["current_staff", "is_staff", "is_admin"])
      expect((await rest(`rpc/${fn}`, undefined, "POST")).code, fn).toBe("42501");
  });
  it("refuses authenticated insert, update and delete with 42501", async () => {
    for (const table of Object.keys(READ)) {
      const col = WRITE_COL[table] ?? "id";
      const filtered = `${table}?${col}=is.null`;
      for (const [path, method] of [
        [table, "POST"],
        [filtered, "PATCH"],
        [filtered, "DELETE"],
      ] as const)
        expect((await rest(path, tokens.agent, method, `{"${col}":null}`)).code, path).toBe(
          "42501",
        );
    }
  });
});
