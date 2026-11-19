import { randomUUID } from "node:crypto";
import { createDbClient, createRepositories } from "@ai-it-support/db";
import { INTAKE_TICKET_TASK_ID, signSlackRequest } from "@ai-it-support/shared";
import { auth, tasks, wait } from "@trigger.dev/sdk";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { POST as postSlack } from "@/app/api/slack/interactivity/route";
import { POST as postStaff } from "@/app/staff/tickets/[id]/decide/route";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import { egress } from "../../../services/pipeline/test-support/egress.js";
import { seedKnowledgeBase } from "../../../services/pipeline/test-support/kb-seed.js";
import {
  startLocalRunner,
  type LocalRunner,
} from "../../../services/pipeline/test-support/local-runner.js";
import {
  SLACK_CHANNEL,
  SLACK_REVIEWER,
  mockSensitiveAnswer,
} from "../../../services/pipeline/test-support/provider-mocks.js";
import { getStack, signIn, startStaffStack, stopStaffStack, type SignedIn } from "./staff-stack.js";

const { createServerSupabaseClient, env } = vi.hoisted(() => ({
  createServerSupabaseClient: vi.fn(),
  env: {
    HELPDESK: "builtin",
    E2E_MODE: true,
    SUPABASE_URL: "",
    SUPABASE_DB_SCHEMA: "itsupport",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SLACK_SIGNING_SECRET: "f".repeat(32),
    SLACK_REVIEWER_IDS: ["U0000000000"],
    SLACK_CHANNEL_ID: "C0000000000",
  },
}));
vi.mock("@/env", () => ({ env }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));

type Decision = "approve" | "reject";
let runner: LocalRunner;
let db: ReturnType<typeof createDbClient>;
let repos: ReturnType<typeof createRepositories>;
let admin: SignedIn;
let adminId: string;

const withRunner = <T>(run: () => Promise<T>) =>
  auth.withAuth({ baseURL: runner.url, accessToken: "x".repeat(32) }, run);

beforeAll(async () => {
  const stack = await startStaffStack();
  env.SUPABASE_URL = stack.url;
  env.SUPABASE_SERVICE_ROLE_KEY = stack.serviceRoleKey;
  db = createDbClient({
    SUPABASE_URL: stack.url,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    SUPABASE_DB_SCHEMA: env.SUPABASE_DB_SCHEMA,
  });
  repos = createRepositories(db);
  const user = await createTestStaffUser(stack, { role: "admin" });
  admin = await signIn(user.email, user.password);
  expect(admin.response.status).toBe(200);
  adminId = user.staffId!;
  await seedKnowledgeBase(stack);
  runner = await startLocalRunner({
    restStack: stack,
    egress,
    env: { HELPDESK: "builtin", SHADOW_MODE: "false" },
  });
  mockSensitiveAnswer(egress);
  egress.forbid(runner.broker.marker);
});

afterAll(async () => {
  await runner?.stop();
  await stopStaffStack();
});

async function waitingTicket() {
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: "Complaint about my team lead",
    raw_description: "I want to raise an HR complaint about harassment by my team lead.",
    requester_email: "requester@example.test",
    idempotency_key: randomUUID(),
    is_test: true,
  });
  await withRunner(() => tasks.trigger(INTAKE_TICKET_TASK_ID, { ticketId: ticket.id }));
  await runner.idle();
  expect((await repos.getTicket(ticket.id))?.status).toBe("review_pending");
  const review = await repos.getTriageReview(ticket.id);
  expect(Boolean(review?.slack_ts)).toBe(true);
  return { id: ticket.id, review: review! };
}

type WaitingTicket = Awaited<ReturnType<typeof waitingTicket>>;

async function slackDecision({ review }: WaitingTicket, decision: Decision) {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: SLACK_REVIEWER },
      channel: { id: SLACK_CHANNEL },
      container: { message_ts: review.slack_ts },
      response_url: "https://hooks.slack.com/actions/T0/1/test",
      actions: [{ action_id: `review_${decision}`, value: review.id }],
    }),
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return withRunner(() =>
    postSlack(
      new Request("https://example.test/api/slack/interactivity", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": signSlackRequest({
            secret: env.SLACK_SIGNING_SECRET,
            timestamp,
            body,
          }),
        },
      }),
    ),
  );
}

function staffDecision({ id }: WaitingTicket, decision: Decision) {
  return withRunner(() =>
    postStaff(
      new Request(`https://example.test/staff/tickets/${id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ decision }),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function result({ id }: WaitingTicket) {
  const { data: events, error } = await db
    .from("ticket_events")
    .select("type,payload")
    .eq("ticket_id", id)
    .order("id");
  expect(error).toBeNull();
  const review = await repos.getTriageReview(id);
  const helpdesk = await repos.getHelpdeskTicketByTicketId(id);
  return {
    status: (await repos.getTicket(id))!.status,
    decision: review!.decision,
    helpdeskState: helpdesk?.state ?? null,
    eventTypes: events!.map((event) => event.type),
    decided: events!
      .filter((event) => event.type === "review_decided")
      .map((event) => event.payload),
  };
}

it.each(["approve", "reject"] as const)(
  "T5.I.08: %s through signed Slack and staff reaches the same state",
  async (decision) => {
    const slack = await waitingTicket();
    const staff = await waitingTicket();
    createServerSupabaseClient.mockResolvedValue(admin.supabase);
    const fromSlack = await slackDecision(slack, decision);
    const fromStaff = await staffDecision(staff, decision);
    for (const response of [fromSlack, fromStaff]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: "recorded" });
    }
    await runner.idle();
    const { decided: slackAudit, ...slackState } = await result(slack);
    const { decided: staffAudit, ...staffState } = await result(staff);
    expect(staffState).toEqual(slackState);
    expect(staffState).toMatchObject({
      status: decision === "approve" ? "incident_created" : "rejected",
      decision,
      helpdeskState: decision === "approve" ? "new" : null,
    });
    expect(slackAudit).toEqual([
      { reviewId: slack.review.id, decision, source: "slack", decidedBy: SLACK_REVIEWER },
    ]);
    expect(staffAudit).toEqual([
      { reviewId: staff.review.id, decision, source: "helpdesk", decidedBy: adminId },
    ]);
    const cards = egress.requests().filter((request) => request.path === "/api/chat.update");
    const staffCard = cards.filter(
      (request) => JSON.parse(request.body).ts === staff.review.slack_ts,
    );
    expect(staffCard).toHaveLength(1);
    expect(staffCard[0]!.body).toContain("Decided in the helpdesk");
    expect(staffCard[0]!.body.includes(staff.review.wait_token_id)).toBe(false);
  },
);

it("T5.I.08: a simultaneous Slack and staff decision completes the wait token once", async () => {
  const ticket = await waitingTicket();
  createServerSupabaseClient.mockResolvedValue(admin.supabase);
  egress.mock("https://hooks.slack.com", () => new Response(null, { status: 200 }));
  const complete = vi.spyOn(wait, "completeToken");
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const replies = await Promise.all([
      slackDecision(ticket, "approve"),
      staffDecision(ticket, "reject"),
    ]);
    expect(replies.map((reply) => reply.status)).toEqual([200, 200]);
    const outcomes = await Promise.all(replies.map((reply) => reply.json()));
    expect(outcomes).toContainEqual({ outcome: "recorded" });
    expect(outcomes).toContainEqual({ outcome: "already_decided" });
    await runner.idle();
    expect(complete).toHaveBeenCalledTimes(1);
    const { decided, decision } = await result(ticket);
    expect(decided).toEqual([
      outcomes[0].outcome === "recorded"
        ? {
            reviewId: ticket.review.id,
            decision: "approve",
            source: "slack",
            decidedBy: SLACK_REVIEWER,
          }
        : {
            reviewId: ticket.review.id,
            decision: "reject",
            source: "helpdesk",
            decidedBy: adminId,
          },
    ]);
    expect(decision).toBe(outcomes[0].outcome === "recorded" ? "approve" : "reject");
    const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]);
    expect(logs.includes(ticket.review.wait_token_id)).toBe(false);
  } finally {
    complete.mockRestore();
    info.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
});

it("an agent session gets 403 before any review or token changes", async () => {
  const user = await createTestStaffUser(getStack(), { role: "agent" });
  const agent = await signIn(user.email, user.password);
  expect(agent.response.status).toBe(200);
  createServerSupabaseClient.mockResolvedValue(agent.supabase);
  const ticket = await waitingTicket();
  const before = await result(ticket);
  try {
    expect((await staffDecision(ticket, "approve")).status).toBe(403);
    expect(await result(ticket)).toEqual(before);
    expect(runner.broker.get(ticket.review.wait_token_id)?.state).toBe("waiting");
  } finally {
    runner.broker.timeOut(ticket.review.wait_token_id);
    await runner.idle();
  }
});

it("an admin gets late after the timeout without changing the result", async () => {
  const ticket = await waitingTicket();
  createServerSupabaseClient.mockResolvedValue(admin.supabase);
  expect(runner.broker.timeOut(ticket.review.wait_token_id)).toBe(true);
  await runner.idle();
  const before = await result(ticket);
  expect(before).toMatchObject({ status: "escalated_manual", decision: "timeout" });
  const response = await staffDecision(ticket, "approve");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "late" });
  expect(await result(ticket)).toEqual(before);
  expect(runner.broker.get(ticket.review.wait_token_id)?.state).toBe("timed_out");
});

it("refuses an expired waitpoint while the review row is still undecided", async () => {
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: "Pending review fixture",
    raw_description: "Waiting for the pipeline to record a timeout",
    requester_email: "requester@example.test",
    idempotency_key: randomUUID(),
    is_test: true,
  });
  const { error } = await db
    .from("tickets")
    .update({ status: "review_pending" })
    .eq("id", ticket.id);
  expect(error).toBeNull();
  const token = await runner.broker.createToken({
    timeout: "24h",
    idempotencyKey: `review:${ticket.id}`,
    tags: [],
  });
  const review = await repos.createTriageReview({ ticketId: ticket.id, waitTokenId: token.id });
  await repos.setReviewSlackTs(review.id, "1800000000.000100");
  expect(runner.broker.timeOut(token.id)).toBe(true);

  createServerSupabaseClient.mockResolvedValue(admin.supabase);
  const response = await staffDecision({ id: ticket.id, review }, "approve");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "late" });
  expect(await repos.getTriageReview(ticket.id)).toMatchObject({ decision: null, staff_id: null });
  expect((await repos.getTicket(ticket.id))?.status).toBe("review_pending");
  expect(runner.broker.get(token.id)?.state).toBe("timed_out");
});
