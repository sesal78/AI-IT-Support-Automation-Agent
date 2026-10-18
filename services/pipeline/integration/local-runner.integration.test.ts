import { INTAKE_TICKET_TASK_ID, TRIAGE_TICKET_TASK_ID } from "@ai-it-support/shared";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { healthcheck } from "../src/trigger/healthcheck.js";
import { triageIdempotencyKey, type intakeTicket } from "../src/trigger/intake-ticket.js";
import type { triageTicket } from "../src/trigger/triage-ticket.js";
import { egress } from "../test-support/egress.js";
import { startLocalRunner, type LocalRun, type LocalRunner } from "../test-support/local-runner.js";
import {
  TYPESAFE_ORIGIN,
  createCanaryTicket,
  eventTypes,
  intake,
  questionKeys,
  rowCount,
  testStack,
  ticketStatus,
  typesafeReply,
  useTriageStack,
} from "./triage-harness.js";

// P3-T10g: the local Trigger.dev runner, driven by the real SDK. The runner
// shares this file's egress recorder (started by the setup file), so the
// leak check after every test covers the runs' outbound requests too.

useTriageStack();

let runner: LocalRunner;

/** Points the SDK of this process at a runner, with a fake secret key. */
function useRunner(target: LocalRunner): void {
  vi.stubEnv("TRIGGER_API_URL", target.url);
  vi.stubEnv("TRIGGER_SECRET_KEY", "x".repeat(32));
}

async function listRuns(target: LocalRunner): Promise<LocalRun[]> {
  const response = await fetch(`${target.url}/runs`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { runs: LocalRun[] }).runs;
}

const postTrigger = (taskId: string, body: string) =>
  fetch(`${runner.url}/api/v1/tasks/${encodeURIComponent(taskId)}/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${"x".repeat(32)}` },
    body,
  });

/** Row counts of the tables a run writes to, across all tickets. */
const writeCounts = async () => ({
  events: await rowCount("ticket_events"),
  triage: await rowCount("triage_results"),
  aiCalls: await rowCount("ai_calls"),
});

beforeAll(async () => {
  runner = await startLocalRunner({ restStack: testStack(), egress });
});

beforeEach(() => useRunner(runner));

afterEach(async () => {
  // Runs finish inside their test, so the leak check sees all their requests.
  await runner.idle();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await runner?.stop();
});

describe("local Trigger.dev runner", () => {
  it("binds 127.0.0.1 on a random port", () => {
    const url = new URL(runner.url);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number(url.port)).toBeGreaterThan(0);
  });

  it("the real SDK trigger of intake-ticket resolves with a run ID and the ticket is triaged within 10 s", async () => {
    const ticketId = await createCanaryTicket();

    const handle = await tasks.trigger<typeof intakeTicket>(INTAKE_TICKET_TASK_ID, { ticketId });

    expect(handle.id).toMatch(/^run_[0-9a-f]{24}$/);
    await vi.waitFor(async () => expect(await ticketStatus(ticketId)).toBe("triaged"), {
      timeout: 10_000,
      interval: 100,
    });
    await runner.idle();
    const types = await eventTypes(ticketId);
    expect(types.indexOf("redacted")).toBeLessThan(types.indexOf("triaged"));

    // Intake chained triage through the runner, with the ticket's global key.
    const key = await idempotencyKeys.create(triageIdempotencyKey(ticketId), { scope: "global" });
    const runs = await listRuns(runner);
    expect(runs.find((run) => run.id === handle.id)).toMatchObject({
      taskId: INTAKE_TICKET_TASK_ID,
      status: "COMPLETED",
      attempts: 1,
    });
    expect(runs.filter((run) => run.idempotencyKey === key)).toEqual([
      expect.objectContaining({ taskId: TRIAGE_TICKET_TASK_ID, status: "COMPLETED" }),
    ]);
  });

  it("the same idempotency key returns the first run ID and starts no second run", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    const key = await idempotencyKeys.create(triageIdempotencyKey(ticketId), { scope: "global" });

    const first = await tasks.trigger<typeof triageTicket>(TRIAGE_TICKET_TASK_ID, payload, {
      idempotencyKey: key,
    });
    await runner.idle();
    const second = await tasks.trigger<typeof triageTicket>(TRIAGE_TICKET_TASK_ID, payload, {
      idempotencyKey: key,
    });
    await runner.idle();

    expect(second.id).toBe(first.id);
    expect((await listRuns(runner)).filter((run) => run.idempotencyKey === key)).toHaveLength(1);
    expect((await eventTypes(ticketId)).filter((type) => type === "triaged")).toHaveLength(1);
  });

  it("a trigger for an unknown task ID gets 404", async () => {
    const before = runner.runs().length;

    await expect(tasks.trigger("no-such-task", { ticketId: "x" })).rejects.toMatchObject({
      status: 404,
    });
    expect((await postTrigger("no-such-task", "{}")).status).toBe(404);
    expect(runner.runs()).toHaveLength(before);
  });

  it("a body that is not JSON gets 400", async () => {
    const before = runner.runs().length;

    const response = await postTrigger(INTAKE_TICKET_TASK_ID, "not json {");

    expect(response.status).toBe(400);
    expect(runner.runs()).toHaveLength(before);
  });

  it("a payload that fails the task schema gets 400 and nothing is written", async () => {
    const ticketId = await createCanaryTicket();
    const before = await writeCounts();
    const runsBefore = runner.runs().length;

    await expect(
      tasks.trigger(INTAKE_TICKET_TASK_ID, { ticketId: "not-a-uuid" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      tasks.trigger(INTAKE_TICKET_TASK_ID, { ticketId, extra: { nested: 1 }, testOverrides: 5 }),
    ).rejects.toMatchObject({ status: 400 });
    await runner.idle();

    expect(runner.runs()).toHaveLength(runsBefore);
    expect(await writeCounts()).toEqual(before);
    expect(await ticketStatus(ticketId)).toBe("new");
    expect(egress.requests()).toHaveLength(0);
  });

  it("a task body that keeps throwing ends as a failed run in GET /runs and the ticket is failed", async () => {
    const ticketId = await createCanaryTicket();
    // TypeSafe fails the triage judgments only, so intake succeeds and triage throws.
    egress.mock(TYPESAFE_ORIGIN, async ({ request }) => {
      const body = await request.text();
      return questionKeys(body).includes("category")
        ? HttpResponse.json({ error: { message: "internal error" } }, { status: 500 })
        : typesafeReply(body);
    });

    await tasks.trigger<typeof intakeTicket>(INTAKE_TICKET_TASK_ID, { ticketId });
    await runner.idle();

    const key = await idempotencyKeys.create(triageIdempotencyKey(ticketId), { scope: "global" });
    const triageRun = (await listRuns(runner)).find((run) => run.idempotencyKey === key);
    expect(triageRun).toMatchObject({
      taskId: TRIAGE_TICKET_TASK_ID,
      status: "FAILED",
      attempts: 3,
      error: expect.any(String),
    });
    expect(await ticketStatus(ticketId)).toBe("failed");
    expect(await eventTypes(ticketId)).toContain("triage_failed");
  });

  it("a request to a host with no mock fails loudly and is never sent", async () => {
    // A second runner whose Langfuse host has no mock, on the same recorder.
    const unmocked = await startLocalRunner({
      restStack: testStack(),
      egress,
      env: { LANGFUSE_BASE_URL: "https://langfuse.unmocked.invalid" },
    });
    try {
      useRunner(unmocked);
      const ticketId = await createCanaryTicket();
      await tasks.trigger<typeof intakeTicket>(INTAKE_TICKET_TASK_ID, { ticketId });
      await unmocked.idle();

      // The blocked export surfaced as an error in the run, and the leak check names the host.
      expect(await eventTypes(ticketId)).toContain("trace_export_failed");
      expect(() => egress.assertClean()).toThrow(
        /langfuse\.unmocked\.invalid: request to a host with no mock/,
      );
      expect(egress.requests().some((r) => r.host === "langfuse.unmocked.invalid")).toBe(false);
    } finally {
      egress.reset();
      await unmocked.stop();
    }
  });

  it("stop() closes the server and its own mocks; a second stop() is a no-op", async () => {
    // A runner that owns its recorder: the file's recorder steps aside meanwhile.
    egress.stop();
    try {
      const unpatchedFetch = globalThis.fetch;
      const own = await startLocalRunner({ restStack: testStack() });
      expect(own.egress).not.toBe(egress);
      expect(globalThis.fetch).not.toBe(unpatchedFetch);
      useRunner(own);

      const handle = await tasks.trigger<typeof healthcheck>("healthcheck", {
        requestedBy: "local-runner-test",
      });
      await own.idle();
      expect(own.runs()).toEqual([
        expect.objectContaining({ id: handle.id, taskId: "healthcheck", status: "COMPLETED" }),
      ]);

      await own.stop();
      expect(globalThis.fetch).toBe(unpatchedFetch);
      await expect(fetch(`${own.url}/runs`)).rejects.toThrow();
      await expect(own.stop()).resolves.toBeUndefined();
    } finally {
      egress.start();
    }
  });
});
