import { randomBytes, randomUUID } from "node:crypto";
import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { signSlackRequest } from "@ai-it-support/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canaryTicketText } from "../../../packages/shared/src/canaries.js";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import {
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../packages/db/integration/rest-stack.js";
import { egress } from "../../../services/pipeline/test-support/egress.js";

// P4-T9b: POST /api/slack/interactivity, the real route against the local REST
// stack (migrations 0001-0005). The recorder runs for every test (setup file).
// The Trigger.dev API (wait.completeToken of @trigger.dev/sdk 4.6.4) and
// hooks.slack.com (the ephemeral notice) are mocked at HTTP. Each test seeds
// its own review_pending ticket with a reviews row that has a slack_ts and a
// wait_token_id. Every value below is a test fake.

const SECRET = "f".repeat(32);
const REVIEWER = "U0000000000";
const STRANGER = "U0000000099";
const CHANNEL = "C0000000000";
const TRIGGER_ORIGIN = "https://api.trigger.dev";
const TRIGGER_HOST = "api.trigger.dev";
const HOOKS_ORIGIN = "https://hooks.slack.com";
const HOOKS_HOST = "hooks.slack.com";
const RESPONSE_URL = `${HOOKS_ORIGIN}/actions/T00000000/1790000000/fakeResponseUrl`;
const URL_PATH = "http://localhost/api/slack/interactivity";

let full: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
let repos: Repositories | undefined;
const sql = (): NonNullable<typeof db> => {
  if (!db) throw new Error("database client not connected");
  return db;
};
const stack = (): RestStack => {
  if (!full) throw new Error("stack not started");
  return full;
};

type Route = typeof import("../src/app/api/slack/interactivity/route");

/** Fresh module graph: the route reads its env at import. */
async function load(e2eMode = true): Promise<Route> {
  vi.resetModules();
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", stack().url);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", stack().serviceRoleKey);
  vi.stubEnv("SUPABASE_DB_SCHEMA", "itsupport");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("TRIGGER_API_URL", TRIGGER_ORIGIN);
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "fake-turnstile-secret-key");
  vi.stubEnv("TURNSTILE_SITE_KEY", "fake-turnstile-site-key");
  vi.stubEnv("INTERNAL_API_TOKEN", "Token0".repeat(6));
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("SLACK_REVIEWER_IDS", REVIEWER);
  vi.stubEnv("SLACK_CHANNEL_ID", CHANNEL);
  vi.stubEnv("E2E_MODE", e2eMode ? "true" : "false");
  return import("../src/app/api/slack/interactivity/route");
}

// ---- HTTP mocks ----------------------------------------------------------------

let completionStatus = 200;
const requestsTo = (host: string) => egress.requests().filter((r) => r.host === host);

beforeEach(() => {
  completionStatus = 200;
  egress.mock(TRIGGER_ORIGIN, () =>
    completionStatus === 200
      ? Response.json({ success: true })
      : Response.json({ error: "Internal Server Error" }, { status: completionStatus }),
  );
  egress.mock(HOOKS_ORIGIN, () => new Response("ok"));
});

/** Completion requests the Trigger.dev mock received for a token. */
const completionsFor = (tokenId: string) =>
  requestsTo(TRIGGER_HOST).filter(
    (r) => r.method === "POST" && r.path === `/api/v1/waitpoints/tokens/${tokenId}/complete`,
  );

// ---- Seed and requests ---------------------------------------------------------

type Seeded = { ticketId: string; reviewId: string; tokenId: string; ts: string };

/** A review_pending ticket with an open triage review that has a card ts and a token. */
async function seedReview(isTest = true): Promise<Seeded> {
  if (!repos) throw new Error("repositories not built");
  const suffix = randomUUID().slice(0, 8);
  const name = `Interactivity Requester ${suffix}`;
  const email = `interactivity.${suffix}@example.test`;
  egress.forbid(name);
  egress.forbid(email);
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: "Complaint about my team lead",
    raw_description: canaryTicketText(egress.runId),
    requester_email: email,
    requester_name: name,
    department: "Finance",
    idempotency_key: `it-interactivity-${suffix}`,
    is_test: isTest,
  });
  // The pipeline's path (intake, triage, review-ticket) is not under test here.
  await sql().query("update itsupport.tickets set status = 'review_pending' where id = $1", [
    ticket.id,
  ]);
  const tokenId = `waitpoint_${randomBytes(12).toString("hex")}`;
  const review = await repos.createTriageReview({ ticketId: ticket.id, waitTokenId: tokenId });
  const ts = `1790000000.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
  expect((await repos.setReviewSlackTs(review.id, ts)).changed).toBe(true);
  return { ticketId: ticket.id, reviewId: review.id, tokenId, ts };
}

type Click = {
  reviewId: string;
  ts: string;
  decision?: "approve" | "reject";
  userId?: string;
  channelId?: string;
};

function clickBody(click: Click): string {
  const payload = {
    type: "block_actions",
    user: { id: click.userId ?? REVIEWER },
    channel: { id: click.channelId ?? CHANNEL },
    container: { message_ts: click.ts },
    actions: [{ action_id: `review_${click.decision ?? "approve"}`, value: click.reviewId }],
    response_url: RESPONSE_URL,
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function slackRequest(
  body: string,
  options: { secret?: string; timestamp?: number; unsigned?: boolean; contentType?: string } = {},
): Request {
  const timestamp = String(options.timestamp ?? nowSeconds());
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/x-www-form-urlencoded",
  };
  if (!options.unsigned) {
    headers["x-slack-request-timestamp"] = timestamp;
    headers["x-slack-signature"] = signSlackRequest({
      secret: options.secret ?? SECRET,
      timestamp,
      body,
    });
  }
  return new Request(URL_PATH, { method: "POST", headers, body });
}

async function send(route: Route, request: Request) {
  const response = await route.POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function reviewRow(reviewId: string) {
  const { rows } = await sql().query<{
    decision: string | null;
    slack_user_id: string | null;
    decided_at: Date | null;
    slack_ts: string | null;
    wait_token_id: string;
  }>(
    "select decision, slack_user_id, decided_at, slack_ts, wait_token_id from itsupport.reviews where id = $1",
    [reviewId],
  );
  return rows[0];
}

async function slackSecurityRows() {
  const { rows } = await sql().query<{ kind: string; count: number }>(
    "select kind, count from itsupport.security_events where source = 'slack' order by kind, window_start",
  );
  return rows;
}

/** The only notice text the route may send for an already decided review. */
/** The notices hooks.slack.com received; none may carry the wait token ID. */
function notices(tokenId: string) {
  const sent = requestsTo(HOOKS_HOST);
  for (const notice of sent) expect(notice.body).not.toContain(tokenId);
  return sent;
}

const ALREADY_DECIDED_NOTICE = {
  response_type: "ephemeral",
  replace_original: false,
  text: "This ticket was already decided.",
};

// ---- Suite hooks -------------------------------------------------------------

beforeAll(async () => {
  full = await startRestStack();
  db = clientFor(full.pg);
  await db.connect();
  repos = createRepositories(
    createDbClient({
      SUPABASE_URL: full.url,
      SUPABASE_SERVICE_ROLE_KEY: full.serviceRoleKey,
      SUPABASE_DB_SCHEMA: "itsupport",
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(full);
});

// ---- Tests -------------------------------------------------------------------

describe("Slack interactivity on the local REST stack", () => {
  it("a signed approve → 200 recorded, the row says approve, one completion for the stored token", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const seeded = await seedReview();
    const route = await load();

    const answer = await send(route, slackRequest(clickBody(seeded)));

    expect(answer).toEqual({ status: 200, body: { outcome: "recorded" } });
    expect(await reviewRow(seeded.reviewId)).toMatchObject({
      decision: "approve",
      slack_user_id: REVIEWER,
      slack_ts: seeded.ts,
    });
    const completions = completionsFor(seeded.tokenId);
    expect(completions).toHaveLength(1);
    expect(JSON.parse(completions[0]!.body)).toEqual({
      data: { reviewId: seeded.reviewId, decision: "approve" },
    });
    expect(requestsTo(TRIGGER_HOST)).toHaveLength(1);
    expect(requestsTo(HOOKS_HOST)).toEqual([]);
  });

  it("T4.I.03: approve twice → one stored decision and already_decided", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const seeded = await seedReview();
    const route = await load();

    const first = await send(route, slackRequest(clickBody(seeded)));
    const decided = await reviewRow(seeded.reviewId);
    const second = await send(route, slackRequest(clickBody(seeded)));

    expect([first, second]).toEqual([
      { status: 200, body: { outcome: "recorded" } },
      { status: 200, body: { outcome: "already_decided" } },
    ]);
    expect(await reviewRow(seeded.reviewId)).toEqual(decided);
    // The stored decision is this one, so the token is completed again (a no-op in Trigger.dev).
    expect(completionsFor(seeded.tokenId)).toHaveLength(2);
    const sent = notices(seeded.tokenId);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body)).toEqual(ALREADY_DECIDED_NOTICE);
  });

  it("T4.I.03: approve then reject → the row stays approve and one ephemeral notice with the fixed text", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const seeded = await seedReview();
    const route = await load();

    const first = await send(route, slackRequest(clickBody(seeded)));
    const second = await send(route, slackRequest(clickBody({ ...seeded, decision: "reject" })));

    expect([first.body, second.body]).toEqual([
      { outcome: "recorded" },
      { outcome: "already_decided" },
    ]);
    expect((await reviewRow(seeded.reviewId))?.decision).toBe("approve");
    // Another decision is stored: the token is not completed for the reject.
    expect(completionsFor(seeded.tokenId)).toHaveLength(1);
    const sent = notices(seeded.tokenId);
    expect(sent.map((n) => `${n.method} ${n.path}`)).toEqual([
      `POST ${new URL(RESPONSE_URL).pathname}`,
    ]);
    expect(JSON.parse(sent[0]!.body)).toEqual(ALREADY_DECIDED_NOTICE);
  });

  it("T4.I.06: the completion fails with 500 → 500 internal_error; the same request again → already_decided, decided_at unchanged", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seeded = await seedReview();
    const route = await load();
    const body = clickBody(seeded);
    const timestamp = nowSeconds();

    completionStatus = 500;
    const failed = await send(route, slackRequest(body, { timestamp }));
    expect(failed).toEqual({ status: 500, body: { error: "internal_error" } });
    const afterFailure = await reviewRow(seeded.reviewId);
    expect(afterFailure?.decision).toBe("approve");
    const failedCompletions = completionsFor(seeded.tokenId).length;
    expect(failedCompletions).toBeGreaterThanOrEqual(1);

    completionStatus = 200;
    const retried = await send(route, slackRequest(body, { timestamp }));
    expect(retried).toEqual({ status: 200, body: { outcome: "already_decided" } });
    expect(completionsFor(seeded.tokenId)).toHaveLength(failedCompletions + 1);
    expect(await reviewRow(seeded.reviewId)).toEqual(afterFailure);
    expect(notices(seeded.tokenId).map((n) => JSON.parse(n.body))).toEqual([
      ALREADY_DECIDED_NOTICE,
    ]);
  }, 30_000);

  it("T4.S.01: unsigned, bad signature, stale timestamp, a stranger and another message ts → 401, 401, 401, 403, 403", async () => {
    await sql().query("truncate itsupport.security_events");
    const seeded = await seedReview();
    const route = await load();
    const before = await reviewRow(seeded.reviewId);
    const body = clickBody(seeded);

    const statuses = [
      (await send(route, slackRequest(body, { unsigned: true }))).status,
      (await send(route, slackRequest(body, { secret: "b".repeat(32) }))).status,
      (await send(route, slackRequest(body, { timestamp: nowSeconds() - 301 }))).status,
      (await send(route, slackRequest(clickBody({ ...seeded, userId: STRANGER })))).status,
      (await send(route, slackRequest(clickBody({ ...seeded, ts: "1790000000.999999" })))).status,
    ];

    expect(statuses).toEqual([401, 401, 401, 403, 403]);
    expect(await slackSecurityRows()).toEqual([
      { kind: "bad_signature", count: 1 },
      { kind: "binding_mismatch", count: 1 },
      { kind: "missing_signature", count: 1 },
      { kind: "not_allow_listed", count: 1 },
      { kind: "stale_timestamp", count: 1 },
    ]);
    expect(await reviewRow(seeded.reviewId)).toEqual(before);
    expect(requestsTo(TRIGGER_HOST)).toEqual([]);
  });

  it("T4.S.01: a burst of 30 bad-signature requests leaves at most 2 rows whose counts add up to 30", async () => {
    await sql().query("truncate itsupport.security_events");
    const seeded = await seedReview();
    const route = await load();
    const body = clickBody(seeded);

    const answers = await Promise.all(
      Array.from({ length: 30 }, () =>
        send(route, slackRequest(body, { secret: randomBytes(16).toString("hex") })),
      ),
    );

    expect(answers.map((a) => a.status)).toEqual(Array(30).fill(401));
    const rows = await slackSecurityRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.every((row) => row.kind === "bad_signature")).toBe(true);
    expect(rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(30);
    expect((await reviewRow(seeded.reviewId))?.decision).toBeNull();
  });

  it("T4.S.03: 200 seeded random bodies, content types and headers never get a 5xx and change no review", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const seeded = await seedReview();
    const route = await load();
    const before = await reviewRow(seeded.reviewId);
    const random = mulberry32(0x7a4c_2026);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const text = (max: number) =>
      Array.from({ length: Math.floor(random() * max) }, () =>
        String.fromCharCode(32 + Math.floor(random() * 95)),
      ).join("");
    const bodies = [
      () => text(200),
      () => `payload=${encodeURIComponent(text(80))}`,
      () => `payload=${encodeURIComponent(JSON.stringify({ type: text(12), actions: text(5) }))}`,
      () => clickBody({ ...seeded, userId: pick([REVIEWER, STRANGER, text(11)]) }),
      () => clickBody({ ...seeded, reviewId: randomUUID() }),
      () => clickBody({ ...seeded, channelId: `C${text(10)}` }),
      () => `${clickBody(seeded)}&payload=${encodeURIComponent("{}")}`,
      () => "x".repeat(130 * 1024),
    ];
    const contentTypes = [
      "application/x-www-form-urlencoded",
      "application/json",
      "text/plain",
      "multipart/form-data; boundary=x",
      "",
    ];

    const statuses: number[] = [];
    for (let i = 0; i < 200; i++) {
      const body = pick(bodies)();
      // A validly signed body with a random reviewer, review or channel is the
      // allowed-list and binding checks' job; a signed seeded click never goes out.
      const signing = pick(["valid", "unsigned", "random", "stale"] as const);
      const contentType = pick(contentTypes);
      const request =
        signing === "valid"
          ? slackRequest(body, { contentType })
          : signing === "unsigned"
            ? slackRequest(body, { unsigned: true, contentType })
            : signing === "random"
              ? slackRequest(body, { secret: text(40) || "r".repeat(32), contentType })
              : slackRequest(body, { timestamp: nowSeconds() - 400, contentType });
      if (random() < 0.2) request.headers.set("x-slack-signature", text(70));
      if (random() < 0.1) request.headers.set("x-slack-request-timestamp", text(14));
      statuses.push((await route.POST(request)).status);
    }

    expect(statuses.filter((status) => status >= 500)).toEqual([]);
    // Every layer refused some: the size cap, the signature, the payload and the reviewer/binding checks.
    for (const status of [400, 401, 403, 413]) expect(statuses).toContain(status);
    for (const status of statuses) expect([200, 400, 401, 403, 404, 413]).toContain(status);
    expect(await reviewRow(seeded.reviewId)).toEqual(before);
    expect(requestsTo(TRIGGER_HOST)).toEqual([]);
  }, 120_000);

  it("T4.S.04: with E2E_MODE=false a validly signed decision for a test ticket → 403 env_mismatch, the row unchanged", async () => {
    await sql().query("truncate itsupport.security_events");
    const seeded = await seedReview(true);
    const route = await load(false);
    const before = await reviewRow(seeded.reviewId);

    const answer = await send(route, slackRequest(clickBody(seeded)));

    expect(answer).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(await slackSecurityRows()).toEqual([{ kind: "env_mismatch", count: 1 }]);
    expect(await reviewRow(seeded.reviewId)).toEqual(before);
    expect(requestsTo(TRIGGER_HOST)).toEqual([]);
    expect(requestsTo(HOOKS_HOST)).toEqual([]);
  });
});

/** A small seeded PRNG, so the random bodies are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
