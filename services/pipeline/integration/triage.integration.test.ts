import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runKbIngest } from "../src/trigger/kb-ingest.js";
import { egress } from "../test-support/egress.js";
import {
  ORIGINS,
  TRIAGE_EVENTS,
  aiCalls,
  createCanaryTicket,
  eventTypes,
  eventsAfterCheck,
  intake,
  quiet,
  requestsTo,
  rowCount,
  seedArticles,
  spansFor,
  sql,
  testRepos,
  ticketStatus,
  triage,
  triageRow,
  typesafeKinds,
  useTriageStack,
} from "./triage-harness.js";

// P3-T10e: the happy path and its edges, on the shared harness (triage-harness.ts).

useTriageStack();

describe("triage pipeline on the local REST stack", () => {
  it("T3.I.01: intake then triage sets the columns, status triaged and the four events in order", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    expect(payload).toEqual({ ticketId });

    const result = await triage(payload);
    expect(result.skipped).toBe(false);

    const row = await triageRow(ticketId);
    expect(row).toBeDefined();
    for (const column of [
      "category",
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
    ]) {
      expect(row?.[column], column).not.toBeNull();
    }
    expect(row).toMatchObject({
      category: "network",
      priority: "P3",
      urgency: "medium",
      assignment_group: "Network",
    });
    if (!result.skipped) expect(row?.route).toBe(result.route);
    expect((row?.kb_article_ids as string[]).length).toBeGreaterThan(0);
    expect(await ticketStatus(ticketId)).toBe("triaged");
    expect(await eventsAfterCheck(ticketId)).toEqual(TRIAGE_EVENTS);
    expect(typesafeKinds()).toEqual([
      "sensitive_check",
      "triage_judgments",
      "kb_rerank",
      "grounding",
    ]);
    expect(requestsTo(ORIGINS.llm)).toHaveLength(1);
  });

  it("T3.I.01: ai_calls rows equal the spans Langfuse received, each with token counts", async () => {
    const ticketId = await createCanaryTicket();
    await triage(await intake(ticketId));

    const calls = await aiCalls(ticketId);
    expect(calls.map((c) => c.kind).sort()).toEqual(
      ["fix_steps", "grounding", "kb_rerank", "sensitive_check", "triage_judgments"].sort(),
    );
    expect(calls).toHaveLength(spansFor(ticketId));
    for (const call of calls) {
      expect(call.tokens_in, call.kind).not.toBeNull();
      expect(call.tokens_out, call.kind).not.toBeNull();
    }
    expect(calls.find((c) => c.kind === "fix_steps")).toMatchObject({
      provider: "llm",
      tokens_in: 120,
      tokens_out: 30,
    });
  });

  it("T3.I.02: a second triage run is a skip that duplicates nothing", async () => {
    const ticketId = await createCanaryTicket();
    const payload = await intake(ticketId);
    await triage(payload, 1);
    const before = {
      results: await rowCount("triage_results", ticketId),
      events: await eventTypes(ticketId),
      calls: await rowCount("ai_calls", ticketId),
      requests: egress.requests().length,
    };

    expect(await triage(payload, 2)).toEqual({ ticketId, skipped: true });

    expect(await ticketStatus(ticketId)).toBe("triaged");
    expect(await rowCount("triage_results", ticketId)).toBe(1);
    const events = await eventTypes(ticketId);
    expect(events).toEqual(before.events);
    for (const type of TRIAGE_EVENTS)
      expect(
        events.filter((t) => t === type),
        type,
      ).toHaveLength(1);
    expect(await rowCount("ai_calls", ticketId)).toBe(before.calls);
    expect(egress.requests()).toHaveLength(before.requests);
  });

  it("T3.I.06: an unknown ticket ID fails naming the ID, writes nothing and sends nothing", async () => {
    const unknownId = randomUUID();
    const before = {
      results: await rowCount("triage_results"),
      events: await rowCount("ticket_events"),
      calls: await rowCount("ai_calls"),
    };

    await expect(triage({ ticketId: unknownId })).rejects.toThrow(unknownId);

    expect(await rowCount("triage_results")).toBe(before.results);
    expect(await rowCount("ticket_events")).toBe(before.events);
    expect(await rowCount("ai_calls")).toBe(before.calls);
    expect(egress.requests()).toEqual([]);
  });

  it("T3.I.07: with no KB articles the fix is drafted, flagged ungrounded and routed review", async () => {
    await sql().query("delete from itsupport.kb_articles");
    try {
      const ticketId = await createCanaryTicket();
      const payload = await intake(ticketId);
      // Only the triage run's requests; the intake ones stay recorded and checked.
      const from = egress.requests().length;

      const result = await triage(payload);

      expect(result).toMatchObject({ ticketId, skipped: false, route: "review" });
      const row = await triageRow(ticketId);
      expect(row?.kb_article_ids).toEqual([]);
      expect(row?.flags).toContain("ungrounded_fix");
      expect(row?.route).toBe("review");
      expect(row?.suggested_fix).toMatchObject({ steps: expect.any(Array) });
      expect(await ticketStatus(ticketId)).toBe("triaged");
      // No rerank and no grounding request: only the judgments and the LLM draft.
      expect(typesafeKinds(from)).toEqual(["triage_judgments"]);
      expect(requestsTo(ORIGINS.llm, from)).toHaveLength(1);
      expect((await aiCalls(ticketId)).map((c) => c.kind).sort()).toEqual(
        ["fix_steps", "sensitive_check", "triage_judgments"].sort(),
      );
    } finally {
      await runKbIngest({ articles: seedArticles() }, { repos: testRepos(), logger: quiet });
    }
  });
});
