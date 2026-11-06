import { signSlackRequest, type InternalTicketView } from "@ai-it-support/shared";
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
  SLACK_CHANNEL,
  SLACK_REVIEWER,
  mockSensitiveAnswer,
} from "../../../services/pipeline/test-support/provider-mocks";
import { startPipelineStack, type PipelineStack } from "./support/pipeline-stack";

// Local end-to-end test of the Slack review (P4-T9c, T4.E.01): the built web
// app (E2E_MODE=true, the fake signing secret and reviewer ID) against the
// local REST stack and the local Trigger.dev runner. The runner runs the real
// intake, triage and review bodies; TypeSafe gives the sensitive answer, so
// every ticket is routed to review, and Slack is answered by the runner's mock.
// A signed click on the web app completes the wait token through the runner.
// Every external request is answered locally or blocked, so the spec needs no
// network. Needs Docker and `pnpm build`.

// The fakes the pipeline stack gives the web app (support/pipeline-stack.ts).
const SIGNING_SECRET = "f".repeat(32);
const RESPONSE_URL = "https://hooks.slack.com/actions/T00000000/1790000000/fakeResponseUrl";
const RUN = Date.now().toString(36);

let stack: PipelineStack | undefined;
const forbidden: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ baseURL }, testInfo) => {
  // Docker image pulls and the REST stack start can take a while on a cold runner.
  testInfo.setTimeout(300_000);
  if (!baseURL) throw new Error("the review project needs a baseURL");
  stack = await startPipelineStack(baseURL);
  mockSensitiveAnswer(stack.runner.egress);
});

test.afterAll(async () => {
  await stack?.stop();
});

test.afterEach(async () => {
  if (!stack) return;
  expect(await stack.webEgressProblems(), "web process egress").toEqual([]);
  stack.runner.egress.assertClean();
});

function getStack(): PipelineStack {
  if (!stack) throw new Error("pipeline stack not started");
  return stack;
}

/** A test ticket through the internal API; its requester name and email are forbidden. */
async function createTestTicket(request: APIRequestContext, label: string): Promise<string> {
  const name = `Review E2E ${label} ${RUN}`;
  const email = `review.e2e.${label}.${RUN}@example.com`;
  for (const value of [name, email]) {
    forbidden.push(value);
    getStack().forbid(value);
    getStack().runner.egress.forbid(value);
  }
  const res = await request.post("/api/internal/test-tickets", {
    headers: { authorization: `Bearer ${getStack().internalToken}` },
    data: {
      testId: `review-e2e-${label}-${RUN}`,
      name,
      email,
      department: "Finance",
      title: "Complaint about my team lead",
      description: "I want to raise an HR complaint about harassment by my team lead.",
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { ticketId: string; queued: boolean };
  expect(body.queued).toBe(true);
  return body.ticketId;
}

async function viewOf(request: APIRequestContext, id: string): Promise<InternalTicketView> {
  const res = await request.get(`/api/internal/tickets/${id}`, {
    headers: { authorization: `Bearer ${getStack().internalToken}` },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  for (const value of forbidden) expect(text.toLowerCase()).not.toContain(value.toLowerCase());
  return JSON.parse(text) as InternalTicketView;
}

/** Waits for review_pending with a card ts; returns the review ID and the ts. */
async function pendingReview(request: APIRequestContext, id: string) {
  let review: InternalTicketView["reviews"][number] | undefined;
  await expect
    .poll(
      async () => {
        const view = await viewOf(request, id);
        review = view.reviews[0];
        return { status: view.status, reviews: view.reviews.length, slackTs: review?.slackTs };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      status: "review_pending",
      reviews: 1,
      slackTs: expect.stringMatching(/^\d+\.\d+$/),
    });
  return { reviewId: review!.id, ts: review!.slackTs! };
}

function click(options: {
  reviewId: string;
  ts: string;
  decision: "approve" | "reject";
  secret?: string;
}) {
  const body = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: SLACK_REVIEWER },
      channel: { id: SLACK_CHANNEL },
      container: { message_ts: options.ts },
      actions: [{ action_id: `review_${options.decision}`, value: options.reviewId }],
      response_url: RESPONSE_URL,
    }),
  }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signSlackRequest({
        secret: options.secret ?? SIGNING_SECRET,
        timestamp,
        body,
      }),
    },
    data: body,
  };
}

const statusWithin10s = (request: APIRequestContext, id: string) =>
  expect.poll(async () => (await viewOf(request, id)).status, { timeout: 10_000 });

test("T4.E.01: a sensitive test ticket reaches review_pending; a signed approve → approved within 10 s", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const ticketId = await createTestTicket(request, "approve");
  const review = await pendingReview(request, ticketId);

  const res = await request.post(
    "/api/slack/interactivity",
    click({ ...review, decision: "approve" }),
  );
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ outcome: "recorded" });

  await statusWithin10s(request, ticketId).toBe("approved");
  const view = await viewOf(request, ticketId);
  expect(view.reviews).toEqual([
    expect.objectContaining({
      id: review.reviewId,
      decision: "approve",
      decidedBy: SLACK_REVIEWER,
    }),
  ]);
  const types = view.events.map((event) => event.type);
  expect(types.slice(types.indexOf("triaged") + 1)).toEqual(["review_requested", "review_decided"]);
  // The web app completed the run's token through the runner; the run is done.
  await getStack().runner.idle();
  expect(getStack().runner.broker.tokens()).toEqual([
    expect.objectContaining({ idempotencyKey: `review:${ticketId}`, state: "completed" }),
  ]);
});

test("T4.E.01: a second test ticket, a signed reject → rejected", async ({ request }) => {
  test.setTimeout(90_000);
  const ticketId = await createTestTicket(request, "reject");
  const review = await pendingReview(request, ticketId);

  const res = await request.post(
    "/api/slack/interactivity",
    click({ ...review, decision: "reject" }),
  );
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ outcome: "recorded" });

  await statusWithin10s(request, ticketId).toBe("rejected");
  expect((await viewOf(request, ticketId)).reviews[0]?.decision).toBe("reject");
});

test("a click with a bad signature gets 401 and the ticket stays review_pending", async ({
  request,
}) => {
  test.setTimeout(90_000);
  const ticketId = await createTestTicket(request, "forged");
  const review = await pendingReview(request, ticketId);

  const res = await request.post(
    "/api/slack/interactivity",
    click({ ...review, decision: "approve", secret: "b".repeat(32) }),
  );
  expect(res.status()).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });

  await getStack().runner.idle();
  const view = await viewOf(request, ticketId);
  expect(view.status).toBe("review_pending");
  expect(view.reviews[0]?.decision).toBeNull();
  expect(
    getStack()
      .runner.broker.tokens()
      .find((token) => token.idempotencyKey === `review:${ticketId}`)?.state,
  ).toBe("waiting");
});

test("the runner answers 404 for an unknown token; a timed-out broker token gives ok: false", async () => {
  const runner = getStack().runner;
  const res = await fetch(`${runner.url}/api/v1/waitpoints/tokens/waitpoint_unknown/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${"x".repeat(32)}` },
    body: JSON.stringify({ data: { decision: "approve" } }),
  });
  expect(res.status).toBe(404);

  const token = await runner.broker.createToken({
    timeout: "1m",
    idempotencyKey: `e2e-timeout-${RUN}`,
    tags: [],
  });
  const waited = runner.broker.forToken(token.id);
  expect(runner.broker.timeOut(token.id)).toBe(true);
  await expect(waited).resolves.toEqual({ ok: false });
  await expect(runner.broker.forToken(token.id)).resolves.toEqual({ ok: false });
});
