import { signSlackRequest } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getReview: vi.fn(),
  getTicket: vi.fn(),
  decideReview: vi.fn(),
  recordSecurityEvent: vi.fn(),
  completeToken: vi.fn(),
}));
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => ({
    getReview: fakes.getReview,
    getTicket: fakes.getTicket,
    decideReview: fakes.decideReview,
    recordSecurityEvent: fakes.recordSecurityEvent,
  }),
}));
vi.mock("@trigger.dev/sdk", () => ({ wait: { completeToken: fakes.completeToken } }));

const SECRET = ["Route", "Test", "Secret"].join("").repeat(3);
const REVIEW_ID = "0b0e3f0c-5d7a-4c1e-9f3a-2b6c8d9e0a1b";
const TS = "1800000000.000100";
const URL_ = "https://app.example.test/api/slack/interactivity";

type Route = typeof import("./route");
async function load(): Promise<Route> {
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("E2E_MODE", "false");
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("SLACK_REVIEWER_IDS", "U0A5ATR4WJD");
  vi.stubEnv("SLACK_CHANNEL_ID", "C0000000001");
  return import("./route");
}

function signedApprove(): Request {
  const body = `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      user: { id: "U0A5ATR4WJD" },
      channel: { id: "C0000000001" },
      container: { message_ts: TS },
      response_url: "https://hooks.slack.com/actions/T0/1/abc",
      actions: [{ action_id: "review_approve", value: REVIEW_ID }],
    }),
  )}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request(URL_, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackRequest({ secret: SECRET, timestamp, body }),
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  for (const fake of Object.values(fakes)) fake.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  const review = { id: REVIEW_ID, ticket_id: "t1", slack_ts: TS, wait_token_id: "tok" };
  fakes.getReview.mockResolvedValue({ ...review, decision: null });
  fakes.getTicket.mockResolvedValue({ id: "t1", is_test: false });
  fakes.decideReview.mockResolvedValue({
    changed: true,
    review: { ...review, decision: "approve" },
  });
  fakes.completeToken.mockResolvedValue({ success: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/slack/interactivity", () => {
  it("is never prerendered", async () => {
    expect((await load()).dynamic).toBe("force-dynamic");
  });

  it("answers a signed approve through the handler with the real deps", async () => {
    const { POST } = await load();
    const res = await POST(signedApprove());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "recorded" });
    expect(fakes.decideReview).toHaveBeenCalledWith(REVIEW_ID, "approve", "U0A5ATR4WJD");
    expect(fakes.completeToken).toHaveBeenCalledWith("tok", {
      reviewId: REVIEW_ID,
      decision: "approve",
    });
  });

  it("records a refusal as a slack security event", async () => {
    const { POST } = await load();
    const res = await POST(new Request(URL_, { method: "POST", body: "x" }));
    expect(res.status).toBe(401);
    expect(fakes.recordSecurityEvent).toHaveBeenCalledWith("slack", "missing_signature", {
      path: "/api/slack/interactivity",
      method: "POST",
    });
  });
});

describe("other methods on /api/slack/interactivity", () => {
  it.each(["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"] as const)(
    "%s returns 405 with Allow: POST",
    async (method) => {
      const route = await load();
      const res = route[method]();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(fakes.getReview).not.toHaveBeenCalled();
    },
  );
});
