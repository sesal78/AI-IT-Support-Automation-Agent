import type { Redaction, Review, Ticket, Triage } from "@ai-it-support/db";
import { SlackApiError, type PostMessageInput } from "@ai-it-support/slack";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createReviewDeps,
  reviewTicketPayload,
  runReviewTicket,
  type ReviewDeps,
  type ReviewWait,
} from "./review-ticket.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
const REVIEW = "00000000-0000-4000-8000-0000000000aa";
const KB = "00000000-0000-4000-8000-00000000000b";
const NOW = "2026-10-30T00:00:00.000Z";
const CHANNEL = "C0000000001";
const MARK = {
  title: "MARKER-RAW-TITLE",
  description: "MARKER-RAW-DESCRIPTION",
  name: "MARKER-REQUESTER-NAME",
  email: "marker.requester@example.test",
  url: "https://api.trigger.example.test/MARKER-TOKEN-URL",
  pat: "MARKER-PUBLIC-ACCESS-TOKEN",
};
const ALL_MARKERS = Object.values(MARK);

function ticket(status = "triaged", isTest = false): Ticket {
  return {
    id: TICKET,
    source: "web",
    raw_title: MARK.title,
    raw_description: MARK.description,
    requester_email: MARK.email,
    requester_name: MARK.name,
    department: "Finance",
    status,
    servicenow_sys_id: null,
    servicenow_number: null,
    idempotency_key: "k",
    is_test: isTest,
    created_at: NOW,
  };
}

function triage(route = "review", steps = 2): Triage {
  return {
    ticket_id: TICKET,
    sensitive: false,
    sensitive_flags: [],
    checker: "typesafe",
    created_at: NOW,
    category: "network",
    subcategory: null,
    priority: "P3",
    urgency: "medium",
    assignment_group: "Service Desk",
    route,
    probabilities: {},
    flags: ["ungrounded_fix"],
    grounding_score: 0.4,
    kb_article_ids: [KB],
    suggested_fix: {
      steps: Array.from({ length: steps }, (_, i) => `step ${i + 1}`),
      caveats: [],
    },
    model_versions: null,
    triaged_at: NOW,
  };
}

const redaction: Redaction = {
  ticket_id: TICKET,
  redacted_title: "VPN [redacted] down",
  redacted_description: "Cannot connect, contact [email]",
  redaction_log: [],
  created_at: NOW,
};

function review(over: Partial<Review> = {}): Review {
  return {
    id: REVIEW,
    ticket_id: TICKET,
    kind: "triage",
    proposal_id: null,
    slack_user_id: null,
    decision: null,
    decided_at: null,
    wait_token_id: "t-new",
    slack_ts: null,
    created_at: NOW,
    ...over,
  };
}

interface Options {
  found?: Ticket | null;
  triage?: Triage | null;
  review?: Review;
  events?: string[];
  postError?: unknown;
  threadError?: unknown;
  e2eMode?: boolean;
}

function harness(options: Options = {}) {
  const calls: string[] = [];
  const track =
    <A extends unknown[], R>(name: string, impl: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return impl(...args);
    };
  let posts = 0;
  const repos = {
    getTicket: vi.fn(
      track("getTicket", async () => (options.found === undefined ? ticket() : options.found)),
    ),
    getTriage: vi.fn(
      track("getTriage", async () => (options.triage === undefined ? triage() : options.triage)),
    ),
    setTicketStatus: vi.fn(track("setTicketStatus", async () => ({ changed: true }))),
    createTriageReview: vi.fn(track("createTriageReview", async () => options.review ?? review())),
    getRedaction: vi.fn(track("getRedaction", async () => redaction)),
    getKbArticlesByIds: vi.fn(
      track("getKbArticlesByIds", async () => [{ id: KB, slug: "vpn-reset", title: "Reset VPN" }]),
    ),
    setReviewSlackTs: vi.fn(track("setReviewSlackTs", async () => ({ changed: true }))),
    listEventTypes: vi.fn(track("listEventTypes", async () => options.events ?? [])),
    addEvent: vi.fn(track("addEvent", async () => ({}) as never)),
  };
  const slack = {
    postMessage: vi.fn(
      track("postMessage", async (input: PostMessageInput) => {
        posts += 1;
        if (input.threadTs === undefined && options.postError) throw options.postError;
        if (input.threadTs !== undefined && options.threadError) throw options.threadError;
        return { ts: `1700000000.00000${posts}` };
      }),
    ),
  };
  const wait = {
    createToken: vi.fn<ReviewWait["createToken"]>(
      track("createToken", async () => ({
        id: "t-new",
        url: MARK.url,
        publicAccessToken: MARK.pat,
      })),
    ),
    forToken: vi.fn(track("forToken", async () => ({ ok: true }))),
  };
  const alert = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: ReviewDeps = {
    repos,
    slack,
    wait,
    channelId: CHANNEL,
    environment: "staging",
    reviewTimeout: "24h",
    e2eMode: options.e2eMode ?? false,
    alert,
    logger,
  };
  return { deps, calls, repos, slack, wait, alert, logger };
}

const run = (h: ReturnType<typeof harness>, testOverrides?: Record<string, unknown>) =>
  runReviewTicket({ ticketId: TICKET, ...(testOverrides ? { testOverrides } : {}) }, h.deps);

/** Everything that left the task: Slack args, repository args, wait args and log lines. */
function outbound(h: ReturnType<typeof harness>, withWait = true): string {
  const repoCalls = Object.values(h.repos).flatMap((fn) => fn.mock.calls);
  const logs = Object.values(h.logger).flatMap((fn) => fn.mock.calls);
  return JSON.stringify([
    h.slack.postMessage.mock.calls,
    repoCalls,
    logs,
    h.alert.mock.calls,
    withWait ? h.wait.forToken.mock.calls : [],
  ]);
}

describe("runReviewTicket", () => {
  it("calls the steps in the specified order", async () => {
    const h = harness();
    await expect(run(h)).resolves.toEqual({ ticketId: TICKET, skipped: false });
    const order = [
      "getTicket",
      "getTriage",
      "setTicketStatus",
      "createToken",
      "createTriageReview",
      "getRedaction",
      "getKbArticlesByIds",
      "postMessage",
      "setReviewSlackTs",
      "addEvent",
      "forToken",
    ];
    expect(h.calls.filter((c) => order.includes(c))).toEqual(order);
    expect(h.repos.setTicketStatus).toHaveBeenCalledWith(TICKET, "review_pending");
    expect(h.repos.addEvent).toHaveBeenCalledWith(TICKET, "review_requested", { reviewId: REVIEW });
    expect(h.slack.postMessage.mock.calls[0]?.[0].channel).toBe(CHANNEL);
    expect(h.repos.setReviewSlackTs).toHaveBeenCalledWith(REVIEW, "1700000000.000001");
    expect(h.wait.forToken).toHaveBeenCalledWith("t-new");
  });

  it("creates the token with the env timeout, the review key and the ticket tag", async () => {
    const h = harness();
    await run(h);
    expect(h.wait.createToken).toHaveBeenCalledWith({
      timeout: "24h",
      idempotencyKey: `review:${TICKET}`,
      tags: [`ticket:${TICKET}`],
    });
  });

  it("uses reviewTimeout only with E2E_MODE and a test ticket", async () => {
    const on = harness({ e2eMode: true, found: ticket("triaged", true) });
    await run(on, { reviewTimeout: "30m" });
    expect(on.wait.createToken.mock.calls[0]?.[0].timeout).toBe("30m");
    expect(JSON.stringify(on.slack.postMessage.mock.calls[0])).toContain("30m");

    const notTest = harness({ e2eMode: true, found: ticket("triaged", false) });
    await run(notTest, { reviewTimeout: "30m" });
    expect(notTest.wait.createToken.mock.calls[0]?.[0].timeout).toBe("24h");

    const notE2e = harness({ e2eMode: false, found: ticket("triaged", true) });
    await run(notE2e, { reviewTimeout: "30m" });
    expect(notE2e.wait.createToken.mock.calls[0]?.[0].timeout).toBe("24h");
  });

  it("waits on the existing review's token t-old, not the new one", async () => {
    const h = harness({ review: review({ wait_token_id: "t-old" }) });
    await run(h);
    expect(h.wait.forToken).toHaveBeenCalledWith("t-old");
  });

  it("on a retry with slack_ts set and review_requested written: no post, no event, still waits", async () => {
    const h = harness({
      found: ticket("review_pending"),
      review: review({ slack_ts: "1700000000.000009" }),
      events: ["review_requested"],
    });
    await run(h);
    expect(h.slack.postMessage).not.toHaveBeenCalled();
    expect(h.repos.setReviewSlackTs).not.toHaveBeenCalled();
    expect(h.repos.addEvent).not.toHaveBeenCalled();
    expect(h.wait.forToken).toHaveBeenCalledWith("t-new");
  });

  it("sends no raw ticket field and no token url or publicAccessToken anywhere", async () => {
    const h = harness({ triage: triage("review", 5) });
    await run(h);
    const out = outbound(h);
    for (const marker of ALL_MARKERS) expect(out).not.toContain(marker);
    expect(JSON.stringify(h.slack.postMessage.mock.calls[0])).toContain("VPN [redacted] down");
  });

  it("posts the full steps as a thread reply to the card", async () => {
    const h = harness({ triage: triage("review", 5) });
    await run(h);
    expect(h.slack.postMessage).toHaveBeenCalledTimes(2);
    expect(h.slack.postMessage.mock.calls[1]?.[0]).toMatchObject({
      channel: CHANNEL,
      threadTs: "1700000000.000001",
    });
  });

  it("goes on when the thread reply fails: alert, class name logged, event and wait", async () => {
    const h = harness({
      triage: triage("review", 5),
      threadError: new SlackApiError("chat.postMessage", "MARKER_detail"),
    });
    await run(h);
    expect(h.alert).toHaveBeenCalledWith("slack_update_failed", { ticketId: TICKET });
    const lines = JSON.stringify(h.logger.error.mock.calls);
    expect(lines).toContain("SlackApiError");
    expect(lines).not.toContain("MARKER_detail");
    expect(h.repos.addEvent).toHaveBeenCalledWith(TICKET, "review_requested", { reviewId: REVIEW });
    expect(h.wait.forToken).toHaveBeenCalled();
  });

  it("throws when the card post fails: no event, the status stays review_pending", async () => {
    const h = harness({ postError: new SlackApiError("chat.postMessage", "http_500") });
    await expect(run(h)).rejects.toBeInstanceOf(SlackApiError);
    expect(h.repos.addEvent).not.toHaveBeenCalled();
    expect(h.repos.setTicketStatus.mock.calls).toEqual([[TICKET, "review_pending"]]);
    expect(h.wait.forToken).not.toHaveBeenCalled();
  });

  it.each([
    ["route auto", { triage: triage("auto") }],
    ["no triage row", { triage: null }],
    ["an unknown id", { found: null }],
    ["the status new", { found: ticket("new") }],
  ])("aborts for %s", async (_name, options) => {
    const h = harness(options as Options);
    const error = await run(h).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AbortTaskRunError);
    expect(String((error as Error).message)).toContain(TICKET);
    expect(h.repos.setTicketStatus).not.toHaveBeenCalled();
    expect(h.wait.createToken).not.toHaveBeenCalled();
  });

  it.each(["approved", "rejected", "escalated_manual", "failed"])(
    "skips a %s ticket with no further call",
    async (status) => {
      const h = harness({ found: ticket(status) });
      await expect(run(h)).resolves.toEqual({ ticketId: TICKET, skipped: true });
      expect(h.calls).toEqual(["getTicket"]);
    },
  );
});

describe("reviewTicketPayload", () => {
  it("rejects {}, naming ticketId", () => {
    const result = reviewTicketPayload.safeParse({});
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("ticketId");
  });

  it.each(["2h", "0m", "61m"])("rejects reviewTimeout %j", (value) => {
    const result = reviewTicketPayload.safeParse({
      ticketId: TICKET,
      testOverrides: { reviewTimeout: value },
    });
    expect(result.success).toBe(false);
  });
});

describe("createReviewDeps", () => {
  const token = ["xoxb", "test", "0000000000", "fake"].join("-");
  const env = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "k".repeat(16),
    SUPABASE_DB_SCHEMA: "itsupport",
    SLACK_BOT_TOKEN: token,
    SLACK_CHANNEL_ID: CHANNEL,
  };

  it("builds deps with the 24h default and the staging environment", () => {
    const deps = createReviewDeps(env);
    expect(deps.reviewTimeout).toBe("24h");
    expect(deps.environment).toBe("staging");
    expect(deps.channelId).toBe(CHANNEL);
  });

  it("throws without SLACK_BOT_TOKEN, naming it", () => {
    expect(() => createReviewDeps({ ...env, SLACK_BOT_TOKEN: undefined })).toThrow(
      /SLACK_BOT_TOKEN/,
    );
  });

  it.each(["24", "0h", "8d"])("rejects SLACK_REVIEW_TIMEOUT=%j, naming it", (value) => {
    expect(() => createReviewDeps({ ...env, SLACK_REVIEW_TIMEOUT: value })).toThrow(
      /SLACK_REVIEW_TIMEOUT/,
    );
  });
});
