import type { Redaction, Review, Ticket, Triage } from "@ai-it-support/db";
import {
  SlackApiError,
  type PostMessageInput,
  type UpdateMessageInput,
} from "@ai-it-support/slack";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createReviewDeps,
  onReviewFailure,
  reviewTicketOptions,
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
const REVIEWER = "U0000000001";
const TS = "1700000000.000001";
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
    ticket_number: "ITS-000042",
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
  /** The row's decision after the wait. Default `approve`; null is undecided. */
  decision?: Review["decision"];
  /** forToken's `ok`: false means the token timed out. Default true. */
  tokenOk?: boolean;
  /** decideReview loses the race to this decision (`changed: false`). */
  raceDecision?: "approve" | "reject";
  /** The first setTicketStatus call with this status throws. */
  statusError?: string;
  /** The first timeout note post throws. */
  noteError?: unknown;
  updateError?: unknown;
  /** Thrown by triggerHelpdeskSync. */
  syncTriggerError?: Error;
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
  const statuses: string[] = [];
  let row = options.review ?? review();
  let decision = options.decision === undefined ? "approve" : options.decision;
  const events = [...(options.events ?? [])];
  let statusError = options.statusError;
  let noteError = options.noteError;
  const stored = (): Review => ({
    ...row,
    decision,
    slack_user_id: decision === "approve" || decision === "reject" ? REVIEWER : null,
    decided_at: decision === null ? null : NOW,
  });
  const repos = {
    getTicket: vi.fn(
      track("getTicket", async () => (options.found === undefined ? ticket() : options.found)),
    ),
    getTriage: vi.fn(
      track("getTriage", async () => (options.triage === undefined ? triage() : options.triage)),
    ),
    setTicketStatus: vi.fn(
      track("setTicketStatus", async (_id: string, to: string) => {
        if (statusError === to) {
          statusError = undefined;
          throw new Error("status write failed");
        }
        statuses.push(to);
        return { changed: true };
      }),
    ),
    createTriageReview: vi.fn(track("createTriageReview", async () => row)),
    getRedaction: vi.fn(track("getRedaction", async () => redaction)),
    getKbArticlesByIds: vi.fn(
      track("getKbArticlesByIds", async () => [{ id: KB, slug: "vpn-reset", title: "Reset VPN" }]),
    ),
    setReviewSlackTs: vi.fn(
      track("setReviewSlackTs", async (_id: string, ts: string) => {
        row = { ...row, slack_ts: ts };
        return { changed: true };
      }),
    ),
    getReview: vi.fn(track("getReview", async () => stored())),
    decideReview: vi.fn(
      track("decideReview", async () => {
        if (options.raceDecision) {
          decision = options.raceDecision;
          return { changed: false, review: stored() };
        }
        const changed = decision === null;
        if (changed) decision = "timeout";
        return { changed, review: stored() };
      }),
    ),
    listEventTypes: vi.fn(
      track("listEventTypes", async (_id: string, types: readonly string[]) =>
        events.filter((t) => types.includes(t)),
      ),
    ),
    addEvent: vi.fn(
      track("addEvent", async (_id: string, type: string) => {
        events.push(type);
        return {} as never;
      }),
    ),
  };
  const slack = {
    postMessage: vi.fn(
      track("postMessage", async (input: PostMessageInput) => {
        posts += 1;
        if (input.threadTs === undefined && options.postError) throw options.postError;
        if (input.threadTs !== undefined && options.threadError) throw options.threadError;
        if (input.text.startsWith("No decision") && noteError) {
          const error = noteError;
          noteError = undefined;
          throw error;
        }
        return { ts: `1700000000.00000${posts}` };
      }),
    ),
    updateMessage: vi.fn<(input: UpdateMessageInput) => Promise<void>>(
      track("updateMessage", async () => {
        if (options.updateError) throw options.updateError;
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
    forToken: vi.fn(track("forToken", async () => ({ ok: options.tokenOk ?? true }))),
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
    triggerHelpdeskSync: vi.fn(
      track("triggerHelpdeskSync", async () => {
        if (options.syncTriggerError) throw options.syncTriggerError;
      }),
    ),
  };
  return { deps, calls, repos, slack, wait, alert, logger, events, statuses };
}

const run = (h: ReturnType<typeof harness>, testOverrides?: Record<string, unknown>) =>
  runReviewTicket({ ticketId: TICKET, ...(testOverrides ? { testOverrides } : {}) }, h.deps);

/** Everything that left the task: Slack args, repository args, wait args and log lines. */
function outbound(h: ReturnType<typeof harness>, withWait = true): string {
  const repoCalls = Object.values(h.repos).map((fn) => fn.mock.calls as unknown[]);
  const logs = Object.values(h.logger).flatMap((fn) => fn.mock.calls);
  return JSON.stringify([
    h.slack.postMessage.mock.calls,
    h.slack.updateMessage.mock.calls,
    repoCalls,
    logs,
    h.alert.mock.calls,
    withWait ? h.wait.forToken.mock.calls : [],
  ]);
}

describe("runReviewTicket", () => {
  it("calls the steps in the specified order", async () => {
    const h = harness();
    await expect(run(h)).resolves.toEqual({
      ticketId: TICKET,
      skipped: false,
      decision: "approve",
    });
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
    const untilWait = h.calls.slice(0, h.calls.indexOf("forToken") + 1);
    expect(untilWait.filter((c) => order.includes(c))).toEqual(order);
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
    expect(h.events.filter((t) => t === "review_requested")).toHaveLength(1);
    expect(h.wait.forToken).toHaveBeenCalledWith("t-new");
  });

  it("sends no raw ticket field and no token url or publicAccessToken anywhere", async () => {
    const h = harness({ triage: triage("review", 5) });
    await run(h);
    const out = outbound(h);
    for (const marker of ALL_MARKERS) expect(out).not.toContain(marker);
    expect(JSON.stringify(h.slack.postMessage.mock.calls[0])).toContain("VPN [redacted] down");
  });

  describe("ticket number on the cards (P5-T1d)", () => {
    const withNumber = (number: string, status = "triaged"): Ticket => ({
      ...ticket(status),
      ticket_number: number,
    });
    const contextOf = (blocks: unknown[] | undefined, id: string): string =>
      JSON.stringify(
        (blocks as Array<{ block_id?: string }> | undefined)?.find((b) => b.block_id === id),
      );

    it("passes the stored number to the review card, not the UUID prefix", async () => {
      const h = harness({ found: withNumber("ITS-000777") });
      await run(h);
      const context = contextOf(h.slack.postMessage.mock.calls[0]?.[0].blocks, "review_context");
      expect(context).toContain("Ticket ITS-000777 · staging · decide within 24h, then it goes");
      expect(context).not.toContain(TICKET.slice(0, 8));
    });

    it.each([
      ["approve", "approve"],
      ["timeout", "timeout"],
    ] as const)("ends the %s card summary with the stored number", async (_name, decision) => {
      const h = harness({
        found: withNumber("ITS-000777"),
        ...(decision === "timeout" ? { decision: null, tokenOk: false } : { decision }),
      });
      await run(h);
      const summary = contextOf(h.slack.updateMessage.mock.calls[0]?.[0].blocks, "review_summary");
      expect(summary).toContain(" · ticket ITS-000777");
      expect(summary).not.toContain(TICKET.slice(0, 8));
    });

    it("posts nothing when the stored number is malformed, and names the field only", async () => {
      const h = harness({ found: withNumber("ITS-42") });
      const error = await run(h).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe("review card: ticketNumber must be a ticket number");
      expect(h.slack.postMessage).not.toHaveBeenCalled();
      expect(h.repos.setReviewSlackTs).not.toHaveBeenCalled();
    });
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

  it("recovers an approved ticket, including a DB failure while recording a failed enqueue", async () => {
    const h = harness({ found: ticket("approved") });
    vi.mocked(h.deps.triggerHelpdeskSync).mockRejectedValueOnce(new TypeError("enqueue failed"));
    h.repos.addEvent.mockRejectedValueOnce(new Error("event write failed"));
    const switches = { shadowMode: true };

    await expect(run(h, switches)).rejects.toThrow("event write failed");
    await expect(run(h, switches)).resolves.toEqual({ ticketId: TICKET, skipped: true });

    expect(vi.mocked(h.deps.triggerHelpdeskSync).mock.calls).toEqual([
      [
        { ticketId: TICKET, testOverrides: switches },
        { idempotencyKey: `helpdesk-sync:${TICKET}` },
      ],
      [
        { ticketId: TICKET, testOverrides: switches },
        { idempotencyKey: `helpdesk-sync:${TICKET}` },
      ],
    ]);
    expect(h.repos.setTicketStatus).not.toHaveBeenCalled();
    expect(h.repos.getTriage).not.toHaveBeenCalled();
    expect(h.slack.postMessage).not.toHaveBeenCalled();
    expect(h.wait.createToken).not.toHaveBeenCalled();
    expect(h.wait.forToken).not.toHaveBeenCalled();
  });

  it.each(["rejected", "escalated_manual", "failed"])(
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

describe("runReviewTicket after the wait (P4-T4b)", () => {
  it("approve: review_decided, then approved, then the decided card on the stored ts", async () => {
    const h = harness();
    await expect(run(h)).resolves.toEqual({
      ticketId: TICKET,
      skipped: false,
      decision: "approve",
    });
    const after = h.calls.slice(h.calls.indexOf("forToken"));
    const steps = ["addEvent", "setTicketStatus", "updateMessage"];
    expect(after.filter((c) => steps.includes(c))).toEqual(steps);
    expect(h.repos.addEvent).toHaveBeenLastCalledWith(TICKET, "review_decided", {
      reviewId: REVIEW,
      decision: "approve",
    });
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "approved");
    const update = h.slack.updateMessage.mock.calls[0]?.[0];
    expect(update).toMatchObject({ channel: CHANNEL, ts: TS });
    expect(JSON.stringify(update?.blocks)).toContain(`Approved by <@${REVIEWER}>`);
  });

  it("reject: rejected, and nothing is triggered (T4.I.02 unit half)", async () => {
    const h = harness({ decision: "reject" });
    await expect(run(h)).resolves.toMatchObject({ decision: "reject" });
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "rejected");
    // The deps hold no trigger; every call after the wait is one of these.
    const after = h.calls.slice(h.calls.indexOf("forToken") + 1);
    expect(new Set(after)).toEqual(
      new Set([
        "getReview",
        "listEventTypes",
        "addEvent",
        "setTicketStatus",
        "getRedaction",
        "getKbArticlesByIds",
        "updateMessage",
      ]),
    );
    expect(Object.keys(h.deps).some((key) => key.startsWith("trigger"))).toBe(true);
    expect(h.deps.triggerHelpdeskSync).not.toHaveBeenCalled();
  });

  it("the row decides: token output says reject, the row says approve -> approved", async () => {
    const h = harness();
    h.wait.forToken.mockResolvedValue({ ok: true, output: { decision: "reject" } } as never);
    await expect(run(h)).resolves.toMatchObject({ decision: "approve" });
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "approved");
  });

  it("a failed status write throws; the retry writes no second review_decided and finishes", async () => {
    const h = harness({ statusError: "approved" });
    await expect(run(h)).rejects.toThrow("status write failed");
    expect(h.slack.updateMessage).not.toHaveBeenCalled();
    h.repos.getTicket.mockResolvedValue(ticket("review_pending"));
    await expect(runReviewTicket({ ticketId: TICKET }, h.deps, 2)).resolves.toMatchObject({
      decision: "approve",
    });
    expect(h.events.filter((t) => t === "review_decided")).toHaveLength(1);
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "approved");
    expect(h.slack.updateMessage).toHaveBeenCalledTimes(1);
  });

  it("a failed card update still returns approved, alerts once and logs the class name", async () => {
    const h = harness({ updateError: new SlackApiError("chat.update", "MARKER_detail") });
    await expect(run(h)).resolves.toMatchObject({ decision: "approve" });
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "approved");
    expect(h.alert.mock.calls).toEqual([["slack_update_failed", { ticketId: TICKET }]]);
    const lines = JSON.stringify(h.logger.error.mock.calls);
    expect(lines).toContain("SlackApiError");
    expect(lines).not.toContain("MARKER_detail");
  });

  it("a completed token on an undecided row aborts and writes nothing", async () => {
    const h = harness({
      decision: null,
      events: ["review_requested"],
      review: review({ slack_ts: TS }),
    });
    const error = await run(h).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AbortTaskRunError);
    expect(String((error as Error).message)).toContain("token completed without a stored decision");
    expect(h.repos.addEvent).not.toHaveBeenCalled();
    expect(h.repos.setTicketStatus.mock.calls).toEqual([[TICKET, "review_pending"]]);
    expect(h.repos.decideReview).not.toHaveBeenCalled();
    expect(h.slack.updateMessage).not.toHaveBeenCalled();
  });

  it("no event payload or log line holds ticket text or the token ID", async () => {
    const h = harness({ review: review({ wait_token_id: "MARKER-TOKEN-ID" }) });
    await run(h);
    const out = JSON.stringify([
      h.repos.addEvent.mock.calls,
      Object.values(h.logger).map((fn) => fn.mock.calls),
    ]);
    for (const marker of [...ALL_MARKERS, "MARKER-TOKEN-ID"]) expect(out).not.toContain(marker);
  });
});

describe("runReviewTicket on a timeout (P4-T5)", () => {
  const timedOut = (options: Options = {}) =>
    harness({ decision: null, tokenOk: false, ...options });
  const notes = (h: ReturnType<typeof harness>) =>
    h.slack.postMessage.mock.calls.map(([m]) => m).filter((m) => m.text.startsWith("No decision"));

  it("T4.I.04 unit half: decideReview(timeout), note on the ts, event, escalated_manual, card", async () => {
    const h = timedOut();
    await expect(run(h)).resolves.toEqual({
      ticketId: TICKET,
      skipped: false,
      decision: "timeout",
    });
    expect(h.repos.decideReview).toHaveBeenCalledWith(REVIEW, "timeout", null);
    const after = h.calls.slice(h.calls.indexOf("forToken") + 1);
    const steps = ["decideReview", "postMessage", "addEvent", "setTicketStatus", "updateMessage"];
    expect(after.filter((c) => steps.includes(c))).toEqual(steps);
    expect(notes(h)).toEqual([expect.objectContaining({ channel: CHANNEL, threadTs: TS })]);
    expect(h.repos.addEvent).toHaveBeenLastCalledWith(TICKET, "review_timed_out", {
      reviewId: REVIEW,
    });
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "escalated_manual");
    expect(JSON.stringify(h.slack.updateMessage.mock.calls[0]?.[0])).toContain("Review timed out");
  });

  it("a decision stored at the last moment (changed: false, approve) ends approved, no note", async () => {
    const h = timedOut({ raceDecision: "approve" });
    await expect(run(h)).resolves.toMatchObject({ decision: "approve" });
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "approved");
    expect(notes(h)).toEqual([]);
    expect(h.events).not.toContain("review_timed_out");
  });

  it("a failed note throws before the status write; the retry posts it, the event once", async () => {
    const h = timedOut({ noteError: new SlackApiError("chat.postMessage", "http_500") });
    await expect(run(h)).rejects.toBeInstanceOf(SlackApiError);
    expect(h.repos.setTicketStatus.mock.calls).toEqual([[TICKET, "review_pending"]]);
    expect(h.events).not.toContain("review_timed_out");
    h.repos.getTicket.mockResolvedValue(ticket("review_pending"));
    await expect(runReviewTicket({ ticketId: TICKET }, h.deps, 2)).resolves.toMatchObject({
      decision: "timeout",
    });
    expect(h.events.filter((t) => t === "review_timed_out")).toHaveLength(1);
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "escalated_manual");
  });

  it("the note names the timeout value and holds no ticket text", async () => {
    const h = timedOut({ e2eMode: true, found: ticket("triaged", true) });
    await runReviewTicket({ ticketId: TICKET, testOverrides: { reviewTimeout: "30m" } }, h.deps);
    const [note] = notes(h);
    expect(note?.text).toBe("No decision within 30m: sent to the manual queue");
    const text = JSON.stringify(note);
    for (const marker of [...ALL_MARKERS, "VPN", "redacted"]) expect(text).not.toContain(marker);
  });
});

describe("review-ticket starts the helpdesk sync (P5-T5b)", () => {
  const key = `helpdesk-sync:${TICKET}`;

  it("approve: one trigger, after the approved status write", async () => {
    const h = harness({ decision: "approve" });

    await expect(run(h)).resolves.toMatchObject({ decision: "approve" });

    expect(h.statuses).toEqual(["review_pending", "approved"]);
    const last = h.calls.lastIndexOf("setTicketStatus");
    expect(h.calls.slice(last, last + 2)).toEqual(["setTicketStatus", "triggerHelpdeskSync"]);
    expect(h.deps.triggerHelpdeskSync).toHaveBeenCalledTimes(1);
    expect(h.deps.triggerHelpdeskSync).toHaveBeenCalledWith(
      { ticketId: TICKET },
      { idempotencyKey: key },
    );
  });

  it("approve passes the payload's test switches on unchanged", async () => {
    const h = harness({ e2eMode: true, found: ticket("triaged", true) });

    await run(h, { helpdeskAsleepMinutes: 3 });

    expect(h.deps.triggerHelpdeskSync).toHaveBeenCalledWith(
      { ticketId: TICKET, testOverrides: { helpdeskAsleepMinutes: 3 } },
      { idempotencyKey: key },
    );
  });

  it("reject: no trigger", async () => {
    const h = harness({ decision: "reject" });
    await expect(run(h)).resolves.toMatchObject({ decision: "reject" });
    expect(h.deps.triggerHelpdeskSync).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(["review_pending", "rejected"]);
  });

  it("a timeout: no trigger", async () => {
    const h = harness({ decision: null, tokenOk: false });
    await expect(run(h)).resolves.toMatchObject({ decision: "timeout" });
    expect(h.deps.triggerHelpdeskSync).not.toHaveBeenCalled();
    expect(h.statuses).toEqual(["review_pending", "escalated_manual"]);
  });

  it("a failed trigger: helpdesk_enqueue_failed { error }, failed, one alert, abort naming the ID", async () => {
    const h = harness({ syncTriggerError: new TypeError("MARKER-sync-trigger-detail") });

    const error = await run(h).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AbortTaskRunError);
    expect(String((error as Error).message)).toContain(TICKET);
    expect(h.repos.addEvent).toHaveBeenCalledWith(TICKET, "helpdesk_enqueue_failed", {
      error: "TypeError",
    });
    expect(h.statuses).toEqual(["review_pending", "approved", "failed"]);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert).toHaveBeenCalledWith("helpdesk_sync_failed", { ticketId: TICKET });
    expect(JSON.stringify(Object.values(h.logger).flatMap((fn) => fn.mock.calls))).not.toContain(
      "MARKER-sync-trigger-detail",
    );
  });
});

describe("onReviewFailure", () => {
  const failureDeps = (h: ReturnType<typeof harness>) => ({
    repos: h.repos,
    alert: h.alert,
    logger: h.logger,
  });

  it("on a review_pending ticket: review_failed { error }, failed, one alert", async () => {
    const h = harness({ found: ticket("review_pending") });
    await onReviewFailure(
      { payload: { ticketId: TICKET }, error: new SlackApiError("chat.postMessage", "http_500") },
      failureDeps(h),
    );
    expect(h.repos.addEvent.mock.calls).toEqual([
      [TICKET, "review_failed", { error: "SlackApiError" }],
    ]);
    expect(h.repos.setTicketStatus.mock.calls).toEqual([[TICKET, "failed"]]);
    expect(h.alert.mock.calls).toEqual([["review_failed", { ticketId: TICKET }]]);
  });

  it("on an approved ticket it changes nothing", async () => {
    const h = harness({ found: ticket("approved") });
    await onReviewFailure({ payload: { ticketId: TICKET }, error: new Error("x") }, failureDeps(h));
    expect(h.repos.addEvent).not.toHaveBeenCalled();
    expect(h.repos.setTicketStatus).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it("with the database down it logs the class name and does not throw", async () => {
    const h = harness({ found: ticket("review_pending") });
    h.repos.getTicket.mockRejectedValue(new TypeError("fetch failed MARKER_detail"));
    await expect(
      onReviewFailure({ payload: { ticketId: TICKET }, error: new Error("x") }, failureDeps(h)),
    ).resolves.toBeUndefined();
    const lines = JSON.stringify(h.logger.error.mock.calls);
    expect(lines).toContain("TypeError");
    expect(lines).not.toContain("MARKER_detail");
  });

  it("T4.I.05 unit half: postMessage fails on all three attempts, then failed and review_failed", async () => {
    const h = harness({ postError: new SlackApiError("chat.postMessage", "http_500") });
    for (const attempt of [1, 2, 3]) {
      await expect(runReviewTicket({ ticketId: TICKET }, h.deps, attempt)).rejects.toBeInstanceOf(
        SlackApiError,
      );
      h.repos.getTicket.mockResolvedValue(ticket("review_pending"));
    }
    await onReviewFailure(
      { payload: { ticketId: TICKET }, error: new SlackApiError("chat.postMessage", "http_500") },
      failureDeps(h),
    );
    expect(h.repos.setTicketStatus).toHaveBeenLastCalledWith(TICKET, "failed");
    expect(h.alert.mock.calls).toEqual([["review_failed", { ticketId: TICKET }]]);
  });

  it("is wired as the task's onFailure", () => {
    expect(reviewTicketOptions.onFailure).toBe(onReviewFailure);
  });
});
