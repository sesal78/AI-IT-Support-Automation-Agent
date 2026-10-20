import { FixParseError, errorClassName } from "@ai-it-support/ai";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { createIntakeDeps, runIntakeTicket } from "../src/trigger/intake-ticket.js";
import { createTriageFailureDeps, onTriageFailure } from "../src/trigger/triage-ticket.js";
import { egress } from "../test-support/egress.js";
import {
  LLM_BASE_URL,
  ORIGINS,
  TYPESAFE_ORIGIN,
  aiCalls,
  createCanaryTicket,
  eventPayloads,
  eventTypes,
  intake,
  llmReply,
  questionKeys,
  quiet,
  requestsTo,
  sql,
  testEnv,
  ticketStatus,
  triage,
  triageRow,
  typesafeKinds,
  typesafeReply,
  useTriageStack,
} from "./triage-harness.js";

// P3-T10f: failures, caps and the enqueue error, on the shared harness
// (triage-harness.ts). A task retry is the body called again with the next
// attempt number; after the last failed attempt the test calls
// onTriageFailure, as Trigger.dev does (maxAttempts 3 in trigger.config.ts).

useTriageStack();

const MAX_ATTEMPTS = 3;
// The env default (aiBudgetEnvShape): the harness env does not set it.
const LLM_MONTHLY_CALL_CAP = 2000;

/** The 13 triage columns migration 0003 adds to triage_results. */
const TRIAGE_COLUMNS = [
  "category",
  "subcategory",
  "priority",
  "urgency",
  "assignment_group",
  "route",
  "probabilities",
  "flags",
  "grounding_score",
  "kb_article_ids",
  "suggested_fix",
  "model_versions",
  "triaged_at",
];

const isJudgments = (body: string) => questionKeys(body).includes("category");

const serverError = () =>
  HttpResponse.json({ error: { message: "internal error" } }, { status: 500 });

/** TypeSafe answers the judgments request with 500 `times` times, every other request with 200. */
function failJudgments(times: number): void {
  let failed = 0;
  egress.mock(TYPESAFE_ORIGIN, async ({ request }) => {
    const body = await request.text();
    if (isJudgments(body) && failed < times) {
      failed++;
      return serverError();
    }
    return typesafeReply(body);
  });
}

/** Rows of security_events for one pipeline alert kind. */
async function alertRows(kind: string) {
  const result = await sql().query(
    "select source, kind, count from itsupport.security_events where source = 'pipeline' and kind = $1",
    [`alert:${kind}`],
  );
  return result.rows as Array<{ source: string; kind: string; count: number }>;
}

describe("triage failures on the local REST stack", () => {
  it("T3.I.03: one TypeSafe 500 is absorbed by the SDK retry inside a single attempt", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    const from = egress.requests().length;
    failJudgments(1);

    const result = await triage(payload, 1);

    expect(result).toMatchObject({ ticketId, skipped: false });
    expect(await ticketStatus(ticketId)).toBe("triaged");
    expect(typesafeKinds(from).filter((kind) => kind === "triage_judgments")).toHaveLength(2);
    const judgmentRows = (await aiCalls(ticketId)).filter((c) => c.kind === "triage_judgments");
    expect(judgmentRows).toHaveLength(1);
    expect(judgmentRows[0]?.tokens_in).not.toBeNull();
  });

  it("T3.I.04: TypeSafe always 500: three attempts throw, then onTriageFailure marks it failed", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    const from = egress.requests().length;
    failJudgments(Number.POSITIVE_INFINITY);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      lastError = await triage(payload, attempt).then(
        () => expect.unreachable(`attempt ${attempt} should throw`),
        (error: unknown) => error,
      );
      expect(lastError, `attempt ${attempt}`).toBeInstanceOf(Error);
      expect(await ticketStatus(ticketId)).toBe("redacted");
    }
    // The SDK's 2 retries per attempt: 3 judgments requests per attempt. The KB
    // rerank runs beside them (P3-T10k), one request per attempt; nothing after.
    const kinds = typesafeKinds(from);
    expect(kinds.filter((kind) => kind === "triage_judgments")).toHaveLength(MAX_ATTEMPTS * 3);
    expect(kinds.filter((kind) => kind !== "triage_judgments")).toEqual(
      Array(MAX_ATTEMPTS).fill("kb_rerank"),
    );
    expect(requestsTo(ORIGINS.llm, from)).toHaveLength(0);

    await onTriageFailure(
      { payload, error: lastError },
      { ...createTriageFailureDeps(testEnv()), logger: quiet },
    );

    expect(await eventPayloads(ticketId, "triage_failed")).toEqual([
      { error: errorClassName(lastError) },
    ]);
    expect(await ticketStatus(ticketId)).toBe("failed");
    const row = await triageRow(ticketId);
    expect(row).toBeDefined();
    for (const column of TRIAGE_COLUMNS) {
      expect(row, column).toHaveProperty(column);
      expect(row?.[column], column).toBeNull();
    }
    expect(await alertRows("triage_failed")).toEqual([
      { source: "pipeline", kind: "alert:triage_failed", count: 1 },
    ]);
  });

  it("T3.I.05: an LLM reply that is not JSON throws FixParseError and writes no fix", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    egress.mock(LLM_BASE_URL, () => llmReply("Sorry, I can only answer in prose today."));

    await expect(triage(payload, 1)).rejects.toBeInstanceOf(FixParseError);

    const row = await triageRow(ticketId);
    expect(row?.suggested_fix).toBeNull();
    expect(row?.triaged_at).toBeNull();
    expect(await eventTypes(ticketId)).not.toContain("fix_drafted");
    expect(await ticketStatus(ticketId)).toBe("redacted");
  });

  it("T3.I.08: with ai_calls filled up to the LLM cap, no LLM request is sent and it routes review", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    const used = await sql().query(
      "select coalesce(sum(calls), 0) as n from itsupport.ai_calls where provider = 'llm' and at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'",
    );
    const missing = LLM_MONTHLY_CALL_CAP - Number(used.rows[0].n);
    expect(missing).toBeGreaterThan(0);
    const filler = await sql().query(
      "insert into itsupport.ai_calls (provider, kind, calls, environment) values ('llm', 'integration_filler', $1, 'staging') returning id",
      [missing],
    );
    try {
      const from = egress.requests().length;

      const result = await triage(payload, 1);

      expect(result).toMatchObject({ ticketId, skipped: false, route: "review" });
      if (!result.skipped) expect(result.reasons).toContain("cap_reached");
      expect(requestsTo(ORIGINS.llm, from)).toHaveLength(0);
      expect(await eventTypes(ticketId)).toContain("llm_cap_reached");
      expect(await eventTypes(ticketId)).not.toContain("fix_drafted");
      expect((await triageRow(ticketId))?.route).toBe("review");
      expect(await ticketStatus(ticketId)).toBe("triaged");
    } finally {
      await sql().query("delete from itsupport.ai_calls where id = $1", [filler.rows[0].id]);
    }
  });

  it("T3.I.13: an LLM 429 is sent once, raises one alert and routes review", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    const from = egress.requests().length;
    egress.mock(LLM_BASE_URL, () =>
      HttpResponse.json({ error: { message: "rate limited" } }, { status: 429 }),
    );

    const result = await triage(payload, 1);

    expect(result).toMatchObject({ ticketId, skipped: false, route: "review" });
    expect(requestsTo(ORIGINS.llm, from)).toHaveLength(1);
    expect(await eventTypes(ticketId)).toContain("llm_unavailable");
    expect((await triageRow(ticketId))?.route).toBe("review");
    expect(await ticketStatus(ticketId)).toBe("triaged");
    expect(await alertRows("llm_unavailable")).toEqual([
      { source: "pipeline", kind: "alert:llm_unavailable", count: 1 },
    ]);
  });

  it("T3.I.10: a failed triage trigger in intake marks the ticket failed with one alert", async () => {
    const ticketId = await createCanaryTicket();

    await expect(
      runIntakeTicket(
        { ticketId },
        {
          ...createIntakeDeps(testEnv()),
          triggerTriage: async () => {
            throw new Error("trigger unavailable");
          },
          logger: quiet,
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof AbortTaskRunError && error.message.includes(ticketId),
    );

    expect(await eventPayloads(ticketId, "triage_enqueue_failed")).toEqual([{ error: "Error" }]);
    expect(await ticketStatus(ticketId)).toBe("failed");
    expect(await alertRows("triage_enqueue_failed")).toEqual([
      { source: "pipeline", kind: "alert:triage_enqueue_failed", count: 1 },
    ]);
  });

  it("langfuseDown on a test ticket in e2e mode: triage completes with trace_export_failed", async () => {
    const ticketId = await createCanaryTicket({ isTest: true });
    const { ticketId: id } = await intake(ticketId);
    const from = egress.requests().length;

    const result = await triage({ ticketId: id, testOverrides: { langfuseDown: true } }, 1, {
      E2E_MODE: "true",
    });

    expect(result).toMatchObject({ ticketId, skipped: false });
    expect(await ticketStatus(ticketId)).toBe("triaged");
    expect(await eventTypes(ticketId)).toContain("trace_export_failed");
    // The forced-down sink sends nothing.
    expect(requestsTo(ORIGINS.langfuse, from)).toHaveLength(0);
  });
});
