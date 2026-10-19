import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trigger = vi.hoisted(() => vi.fn());
const retrieve = vi.hoisted(() => vi.fn());
const ApiError = vi.hoisted(
  () =>
    class ApiError extends Error {
      constructor(readonly status: number) {
        super(`api ${status}`);
      }
    },
);
const repo = vi.hoisted(() => ({ recordSecurityEvent: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger }, runs: { retrieve }, ApiError }));
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => repo,
}));

const TOKEN = "x".repeat(40);
const MARKER = "q".repeat(14);
const auth = { authorization: `Bearer ${TOKEN}` };
const BASE = "http://localhost/api/internal/judgments";
const valid = {
  judgeId: "J1",
  version: 1,
  question: { type: "score", instructions: "Do the `fix` steps work?", criteria: ["no", "yes"] },
  state: { fix: `Restart ${MARKER}` },
};

type Post = typeof import("./route");
type Get = typeof import("./[runId]/route");
let post: Post;
let get: Get;
const logs: unknown[][] = [];

async function load(e2e: string | undefined) {
  vi.resetModules();
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "x".repeat(20));
  vi.stubEnv("TRIGGER_SECRET_KEY", "x".repeat(20));
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "x".repeat(20));
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("INTERNAL_API_TOKEN", TOKEN);
  vi.stubEnv("E2E_MODE", e2e);
  post = await import("./route");
  get = await import("./[runId]/route");
}

const postReq = (body: unknown, headers: Record<string, string> = auth, query = "") =>
  new Request(`${BASE}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const getRun = (runId: string, headers: Record<string, string> = auth) =>
  get.GET(new Request(`${BASE}/${encodeURIComponent(runId)}`, { headers }), {
    params: Promise.resolve({ runId }),
  });
const run = (fields: Record<string, unknown>) => ({
  taskIdentifier: "judge-text",
  isCompleted: true,
  isSuccess: true,
  ...fields,
});

beforeEach(() => {
  logs.length = 0;
  for (const fn of [trigger, retrieve, repo.recordSecurityEvent]) fn.mockReset();
  repo.recordSecurityEvent.mockResolvedValue(undefined);
  trigger.mockResolvedValue({ id: "run_abc123" });
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
});
afterEach(() => {
  // No log line ever holds the judged text.
  expect(JSON.stringify(logs)).not.toContain(MARKER);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/internal/judgments with E2E_MODE=true", () => {
  beforeEach(() => load("true"));

  it("triggers judge-text with the same payload and answers 202 { runId }", async () => {
    const res = await post.POST(postReq(valid));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "run_abc123" });
    expect(trigger).toHaveBeenCalledWith("judge-text", valid);
  });

  it.each([
    ["an email", { a: [{ b: ["jo.private@example.com"] }] }],
    ["a phone number", { a: { b: "call +61 412 345 678" } }],
    ["an email split across fields", { a: "jane@", b: "example.com" }],
  ])("answers 422 unredacted_input for a state with %s and triggers nothing", async (_n, state) => {
    const res = await post.POST(postReq({ ...valid, state }));
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "unredacted_input" });
    expect(text).not.toContain("example.com");
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a choice question",
      { question: { type: "choice", instructions: "x", criteria: { a: "b" } } },
      "question",
    ],
    ["a Score with 1 level", { question: { ...valid.question, criteria: ["only"] } }, "question"],
    ["a missing judgeId", { judgeId: undefined }, "judgeId"],
    [
      "a __proto__ key in the state",
      { state: JSON.parse(`{"__proto__":{"x":"${MARKER}"}}`) },
      "state",
    ],
  ])("answers 400 with field errors for %s", async (_n, change, field) => {
    const res = await post.POST(postReq({ ...valid, ...change }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).fieldErrors[field]).toBeDefined();
    expect(text).not.toContain(MARKER);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("answers 400 to bad JSON and 413 to a huge body, before parsing", async () => {
    expect((await post.POST(postReq("{not json"))).status).toBe(400);
    const huge = { ...valid, state: { fix: "y".repeat(70_000) } };
    expect((await post.POST(postReq(huge))).status).toBe(413);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("answers 502 with no detail when the trigger fails", async () => {
    trigger.mockRejectedValue(new Error(`boom ${MARKER}`));
    const res = await post.POST(postReq(valid));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "pipeline_unavailable" });
  });

  it.each([
    ["no token", {}],
    ["a wrong token", { authorization: `Bearer ${"y".repeat(40)}` }],
  ])("answers 401 and records a security event for %s", async (_n, headers) => {
    expect((await post.POST(postReq(valid, headers))).status).toBe(401);
    expect((await getRun("run_abc123", headers)).status).toBe(401);
    expect(repo.recordSecurityEvent).toHaveBeenCalledTimes(2);
    expect(trigger).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("answers 401 to a token in the query string even with a valid header", async () => {
    expect((await post.POST(postReq(valid, auth, `?token=${TOKEN}`))).status).toBe(401);
    expect(repo.recordSecurityEvent).toHaveBeenCalledWith("internal_api", "token_in_query", {
      path: "/api/internal/judgments",
      method: "POST",
    });
  });

  it("answers 405 to other methods with the token, 401 without", async () => {
    expect((await post.GET(new Request(BASE, { headers: auth }))).status).toBe(405);
    expect((await post.GET(new Request(BASE))).status).toBe(401);
    expect((await get.POST(new Request(`${BASE}/run_a`, { headers: auth }))).status).toBe(405);
  });
});

describe("GET /api/internal/judgments/:runId with E2E_MODE=true", () => {
  beforeEach(() => load("true"));

  it.each([
    [
      "pending for a running run",
      run({ isCompleted: false, isSuccess: false }),
      { status: "pending" },
    ],
    [
      "completed with { type, value }",
      run({ output: { type: "score", value: 0.8 } }),
      { status: "completed", output: { type: "score", value: 0.8 } },
    ],
    [
      "failed with no error detail",
      run({ isSuccess: false, isFailed: true, error: { message: `bad ${MARKER}` } }),
      { status: "failed" },
    ],
  ])("answers %s", async (_n, value, expected) => {
    retrieve.mockResolvedValue(value);
    const res = await getRun("run_abc123");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(expected);
    expect(text).not.toContain(MARKER);
    expect(retrieve).toHaveBeenCalledWith("run_abc123");
  });

  it("answers 404 to an unknown run id", async () => {
    retrieve.mockRejectedValue(new ApiError(404));
    const res = await getRun("run_unknown1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers 404 to a run of another task, never its output", async () => {
    retrieve.mockResolvedValue(run({ taskIdentifier: "intake-ticket", output: { ticketId: "t" } }));
    const res = await getRun("run_abc123");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("ticketId");
  });

  it.each(["../run_abc", "run_abc/../x", "run_ABC", "run_a%2F", "", "run_" + "a".repeat(65)])(
    "answers 404 to the run id %j without asking the API",
    async (runId) => {
      expect((await getRun(runId)).status).toBe(404);
      expect(retrieve).not.toHaveBeenCalled();
    },
  );

  it("answers 502 on an API failure and 500 on an unexpected output", async () => {
    retrieve.mockRejectedValue(new ApiError(500));
    expect((await getRun("run_abc123")).status).toBe(502);
    retrieve.mockResolvedValue(run({ output: { type: "score", value: 7, text: MARKER } }));
    const res = await getRun("run_abc123");
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(MARKER);
  });
});

describe("judgment routes outside E2E mode", () => {
  it("answer 404 with E2E_MODE unset, before the token, and count the probe", async () => {
    await load(undefined);
    const posted = await post.POST(postReq(valid));
    expect(posted.status).toBe(404);
    expect(posted.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect((await getRun("run_abc123")).status).toBe(404);
    expect((await getRun("run_abc123", {})).status).toBe(404);
    expect((await post.PUT(new Request(BASE, { method: "PUT" }))).status).toBe(404);
    expect((await get.DELETE(new Request(`${BASE}/run_a`))).status).toBe(404);
    expect(repo.recordSecurityEvent).toHaveBeenCalledWith("internal_api", "judgments_disabled", {
      path: "/api/internal/judgments",
      method: "POST",
    });
    expect(trigger).not.toHaveBeenCalled();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("answers 404 with E2E_MODE=false", async () => {
    await load("false");
    expect((await post.POST(postReq(valid))).status).toBe(404);
  });

  it.each(["TRUE", "1", " true", "yes"])("refuses to boot with E2E_MODE=%j", async (value) => {
    await expect(load(value)).rejects.toThrow(/E2E_MODE/);
  });
});
