import type { Review } from "@ai-it-support/db";
import { signSlackRequest } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecide, NOTICE_TIMEOUT_MS, type DecideDeps } from "./decide";
import { createInteractivityHandler } from "./handler";
import type { Interaction } from "./interaction";

const TOKEN_MARKER = "waittoken_marker_7f3a";
const REVIEW_ID = "0b0e3f0c-5d7a-4c1e-9f3a-2b6c8d9e0a1b";
const TICKET_ID = "1c1e3f0c-5d7a-4c1e-9f3a-2b6c8d9e0a1c";
const TS = "1800000000.000100";
const HOOK = "https://hooks.slack.com/actions/T0/1/abc";
const SAMPLE = { path: "/api/slack/interactivity", method: "POST" };

const click = (decision: Interaction["decision"], overrides: Partial<Interaction> = {}) => ({
  decision,
  reviewId: REVIEW_ID,
  userId: "U0A5ATR4WJD",
  channelId: "C0000000001",
  messageTs: TS,
  responseUrl: HOOK,
  ...overrides,
});

let stored: Review | null;
let isTest: boolean;
let changes: number;
let logs: string[];
let deps: DecideDeps & {
  completeToken: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  recordSecurityEvent: ReturnType<typeof vi.fn>;
};
let repos: { [K in keyof DecideDeps["repos"]]: ReturnType<typeof vi.fn> };

beforeEach(() => {
  changes = 0;
  isTest = false;
  logs = [];
  for (const level of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.join(" ")));
  }
  stored = {
    id: REVIEW_ID,
    ticket_id: TICKET_ID,
    kind: "triage",
    proposal_id: null,
    slack_user_id: null,
    decision: null,
    decided_at: null,
    wait_token_id: TOKEN_MARKER,
    slack_ts: TS,
    created_at: "2026-10-29T00:00:00.000Z",
  } as Review;
  repos = {
    getReview: vi.fn(async () => stored && { ...stored }),
    getTicket: vi.fn(async () => ({ id: TICKET_ID, is_test: isTest })),
    // Like the repository: one conditional update, else the stored row.
    decideReview: vi.fn(async (_id: string, decision: Review["decision"], user: string) => {
      if (stored!.decision !== null) return { changed: false, review: { ...stored! } };
      stored = { ...stored!, decision, slack_user_id: user };
      changes += 1;
      return { changed: true, review: { ...stored } };
    }),
  };
  deps = {
    repos: repos as unknown as DecideDeps["repos"],
    recordSecurityEvent: vi.fn().mockResolvedValue(undefined),
    channelId: "C0000000001",
    e2eMode: false,
    completeToken: vi.fn().mockResolvedValue({ success: true }),
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
  };
});
afterEach(() => vi.restoreAllMocks());

const decide = (interaction: Interaction) => createDecide(deps)(interaction, SAMPLE);

async function expectAnswer(res: Response, status: number, body: object) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual(body);
}

function expectNotice(text: string) {
  expect(deps.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = deps.fetch.mock.calls[0];
  expect(url).toBe(HOOK);
  expect(init).toMatchObject({ method: "POST", redirect: "error" });
  expect(init.headers).toEqual({ "Content-Type": "application/json" });
  expect(JSON.parse(init.body)).toEqual({
    response_type: "ephemeral",
    replace_original: false,
    text,
  });
}

const ALREADY = "This ticket was already decided.";

describe("createDecide", () => {
  it("records a first approve and completes the stored token once", async () => {
    await expectAnswer(await decide(click("approve")), 200, { outcome: "recorded" });
    expect(repos.getTicket).toHaveBeenCalledWith(TICKET_ID);
    expect(repos.decideReview).toHaveBeenCalledWith(REVIEW_ID, "approve", "U0A5ATR4WJD");
    expect(deps.completeToken).toHaveBeenCalledTimes(1);
    expect(deps.completeToken).toHaveBeenCalledWith(TOKEN_MARKER, {
      reviewId: REVIEW_ID,
      decision: "approve",
    });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        level: "info",
        scope: "slack-interactivity",
        msg: "decision",
        reviewId: REVIEW_ID,
        ticketId: TICKET_ID,
        outcome: "recorded",
      },
    ]);
  });

  it("T4.I.03: approve twice → already_decided, the token completed again, one notice", async () => {
    await decide(click("approve"));
    await expectAnswer(await decide(click("approve")), 200, { outcome: "already_decided" });
    expect(deps.completeToken).toHaveBeenCalledTimes(2);
    expect(deps.completeToken).toHaveBeenLastCalledWith(TOKEN_MARKER, {
      reviewId: REVIEW_ID,
      decision: "approve",
    });
    expect(changes).toBe(1);
    expectNotice(ALREADY);
  });

  it("T4.I.03: approve then reject → already_decided, no completion, approve kept, one notice", async () => {
    await decide(click("approve"));
    await expectAnswer(await decide(click("reject")), 200, { outcome: "already_decided" });
    expect(deps.completeToken).toHaveBeenCalledTimes(1);
    expect(stored!.decision).toBe("approve");
    expect(changes).toBe(1);
    expectNotice(ALREADY);
  });

  it("T4.I.04: a stored timeout → late, no completion, one notice", async () => {
    stored = { ...stored!, decision: "timeout" };
    await expectAnswer(await decide(click("approve")), 200, { outcome: "late" });
    expect(deps.completeToken).not.toHaveBeenCalled();
    expectNotice("This review timed out; the ticket is in the manual queue.");
  });

  it("T4.I.06: a failed completion → 500, approve kept; the retry completes and is already_decided", async () => {
    deps.completeToken.mockRejectedValueOnce(new TypeError("network"));
    await expectAnswer(await decide(click("approve")), 500, { error: "internal_error" });
    expect(stored!.decision).toBe("approve");
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      scope: "slack-interactivity",
      msg: "token completion failed",
      reviewId: REVIEW_ID,
      ticketId: TICKET_ID,
      error: "TypeError",
    });
    await expectAnswer(await decide(click("approve")), 200, { outcome: "already_decided" });
    expect(deps.completeToken).toHaveBeenCalledTimes(2);
    expect(changes).toBe(1);
  });

  it.each([
    ["an unknown review", () => (stored = null), 404, "not_found", "unknown_review"],
    [
      "another message ts",
      () => (stored = { ...stored!, slack_ts: "1800000000.000999" }),
      403,
      "forbidden",
      "binding_mismatch",
    ],
    ["a test ticket on staging", () => (isTest = true), 403, "forbidden", "env_mismatch"],
    ["a real ticket on e2e", () => (deps.e2eMode = true), 403, "forbidden", "env_mismatch"],
  ])("refuses %s without deciding", async (_label, arrange, status, error, kind) => {
    arrange();
    await expectAnswer(await decide(click("approve")), status, { error });
    expect(deps.recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(deps.recordSecurityEvent).toHaveBeenCalledWith("slack", kind, SAMPLE);
    expect(repos.decideReview).not.toHaveBeenCalled();
    expect(deps.completeToken).not.toHaveBeenCalled();
  });

  it("checks the binding against the configured channel", async () => {
    await decide(click("approve", { channelId: "C0000000002" }));
    expect(deps.recordSecurityEvent).toHaveBeenCalledWith("slack", "binding_mismatch", SAMPLE);
  });

  it("does not read a ticket for an unknown review", async () => {
    stored = null;
    await decide(click("approve"));
    expect(repos.getTicket).not.toHaveBeenCalled();
  });

  it.each(["getReview", "getTicket", "decideReview"] as const)(
    "answers 500 when %s throws, with no completion",
    async (name) => {
      repos[name].mockRejectedValue(new RangeError("db marker"));
      await expectAnswer(await decide(click("approve")), 500, { error: "internal_error" });
      expect(deps.completeToken).not.toHaveBeenCalled();
      const line = JSON.parse(logs[0]);
      expect(line).toMatchObject({ msg: "decision failed", reviewId: REVIEW_ID });
      expect(line.error).toBe("RangeError");
      expect(line.ticketId).toBe(name === "decideReview" ? TICKET_ID : undefined);
    },
  );

  it("still answers 200 when the notice post throws, logging the class name", async () => {
    stored = { ...stored!, decision: "reject" };
    deps.fetch.mockRejectedValue(new TypeError("fetch failed"));
    await expectAnswer(await decide(click("approve")), 200, { outcome: "already_decided" });
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      scope: "slack-interactivity",
      msg: "notice failed",
      reviewId: REVIEW_ID,
      ticketId: TICKET_ID,
      error: "TypeError",
    });
  });

  it("gives up on a hanging hook after NOTICE_TIMEOUT_MS and still answers 200", async () => {
    stored = { ...stored!, decision: "reject" };
    deps.fetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    const started = Date.now();
    await expectAnswer(await decide(click("approve")), 200, { outcome: "already_decided" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(NOTICE_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(2900);
    expect(JSON.parse(logs[0])).toMatchObject({ msg: "notice failed", error: "TimeoutError" });
  });

  it("does not follow a 302 from the hook and still answers 200", async () => {
    stored = { ...stored!, decision: "timeout" };
    deps.fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://example.test/" } }),
    );
    await expectAnswer(await decide(click("approve")), 200, { outcome: "late" });
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.fetch.mock.calls[0][1].redirect).toBe("error");
    expect(JSON.parse(logs[0])).toMatchObject({ msg: "notice failed", status: 302 });
  });

  it("never puts the stored token ID in a response or a log line", async () => {
    const seen: string[] = [];
    const answer = async (interaction: Interaction) =>
      seen.push(await (await decide(interaction)).text());
    deps.completeToken.mockRejectedValueOnce(new Error(`failed ${TOKEN_MARKER}`));
    deps.fetch.mockRejectedValue(new Error(`hook ${TOKEN_MARKER}`));
    await answer(click("approve"));
    await answer(click("approve"));
    await answer(click("reject"));
    expect([...seen, ...logs].join("\n")).not.toContain(TOKEN_MARKER);
    for (const line of logs) {
      const keys = Object.keys(JSON.parse(line)).filter(
        (key) => !["level", "scope", "msg", "error", "status"].includes(key),
      );
      expect(keys.every((key) => ["reviewId", "ticketId", "outcome"].includes(key))).toBe(true);
    }
  });
});

describe("T4.S.04 (local half): the staging handler with the real decide", () => {
  it("refuses a validly signed decision for a test ticket with 403 and changes nothing", async () => {
    isTest = true;
    const secret = ["Staging", "Secret"].join("").repeat(3);
    const now = 1_800_000_000;
    const body = `payload=${encodeURIComponent(
      JSON.stringify({
        type: "block_actions",
        user: { id: "U0A5ATR4WJD" },
        channel: { id: "C0000000001" },
        container: { message_ts: TS },
        response_url: HOOK,
        actions: [{ action_id: "review_approve", value: REVIEW_ID }],
      }),
    )}`;
    const timestamp = String(now);
    const handler = createInteractivityHandler({
      signingSecret: secret,
      reviewerIds: ["U0A5ATR4WJD"],
      recordSecurityEvent: deps.recordSecurityEvent,
      nowSeconds: () => now,
      decide: createDecide(deps),
    });
    const res = await handler(
      new Request("https://app.example.test/api/slack/interactivity", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signSlackRequest({ secret, timestamp, body }),
        },
      }),
    );
    await expectAnswer(res, 403, { error: "forbidden" });
    expect(deps.recordSecurityEvent).toHaveBeenCalledWith("slack", "env_mismatch", SAMPLE);
    expect(repos.decideReview).not.toHaveBeenCalled();
    expect(deps.completeToken).not.toHaveBeenCalled();
    expect(stored!.decision).toBeNull();
  });
});
