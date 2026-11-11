import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbClient } from "./client.js";
import { createRepositories } from "./repositories.js";

const SECRET_KEY = "test-service-role-key";
const repos = createRepositories(
  createDbClient({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY,
    SUPABASE_DB_SCHEMA: "itsupport",
  }),
);

const TABLES = [
  "staff",
  "helpdesk_tickets",
  "helpdesk_notes",
  "helpdesk_assignments",
  "helpdesk_state_transitions",
  "tickets",
  "reviews",
];
const FUNCTIONS = [
  "current_staff",
  "is_staff",
  "is_admin",
  "staff_add_note",
  "staff_assign",
  "staff_set_state",
];

const pgError = (code: string, status: number) =>
  Response.json({ code, message: "MARKER-DB-TEXT", details: null, hint: null }, { status });

/** Stubs fetch: every call is answered by `answer(name)`, where name is the table or function. */
function stub(answer: (name: string) => Response | Promise<Response>) {
  const seen: Array<{ method: string; name: string }> = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname.replace("/rest/v1/", "");
    const name = path.replace("rpc/", "");
    seen.push({ method: init.method ?? "GET", name });
    return answer(name);
  });
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeBuiltinHelpdesk", () => {
  it("is true when every 0007 table answers and every 0008 function exists", async () => {
    // A function the service role may not run answers 42501 before its body: it exists.
    const seen = stub((name) =>
      FUNCTIONS.includes(name) ? pgError("42501", 403) : Response.json([]),
    );
    expect(await repos.probeBuiltinHelpdesk()).toBe(true);
    expect(seen.map((call) => call.name).sort()).toEqual([...TABLES, ...FUNCTIONS].sort());
  });

  it("also counts a function that runs without error as present", async () => {
    stub((name) => (FUNCTIONS.includes(name) ? Response.json(null) : Response.json([])));
    expect(await repos.probeBuiltinHelpdesk()).toBe(true);
  });

  it.each([...TABLES, ...FUNCTIONS])("is false when %s is missing", async (missing) => {
    stub((name) => {
      if (name === missing) return pgError(FUNCTIONS.includes(name) ? "PGRST202" : "42P01", 404);
      return FUNCTIONS.includes(name) ? pgError("42501", 403) : Response.json([]);
    });
    expect(await repos.probeBuiltinHelpdesk()).toBe(false);
  });

  it("is false, never throws and leaks no text when the database is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed MARKER-DB-TEXT");
    });
    await expect(repos.probeBuiltinHelpdesk()).resolves.toBe(false);
  });

  it("is false when the database does not answer in time", async () => {
    stub(() => new Promise<Response>(() => undefined));
    expect(await repos.probeBuiltinHelpdesk(20)).toBe(false);
  });

  it("sends no row ID and no ticket text: selects are GETs, and function bodies hold the all-zero ID only", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
      const name = new URL(String(input)).pathname.replace("/rest/v1/", "").replace("rpc/", "");
      if (FUNCTIONS.includes(name)) bodies.push(String(init.body ?? ""));
      else expect(init.method ?? "GET").toBe("GET");
      return FUNCTIONS.includes(name) ? pgError("42501", 403) : Response.json([]);
    });
    await repos.probeBuiltinHelpdesk();
    const ids = bodies.join(" ").match(/[0-9a-f]{8}-[0-9a-f-]{27}/g) ?? [];
    expect(new Set(ids)).toEqual(new Set(["00000000-0000-4000-8000-000000000000"]));
  });
});
