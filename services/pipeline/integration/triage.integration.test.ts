import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SENSITIVE_TOPICS } from "@ai-it-support/ai";
import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import {
  ASSIGNMENT_GROUPS,
  CATEGORIES,
  PRIORITIES,
  URGENCIES,
  buildCanaries,
  canaryTicketText,
  type TriageTicketPayload,
} from "@ai-it-support/shared";
import { HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import {
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../packages/db/integration/rest-stack.js";
import { createIntakeDeps, runIntakeTicket } from "../src/trigger/intake-ticket.js";
import { kbIngestPayload, runKbIngest } from "../src/trigger/kb-ingest.js";
import { createTriageDeps, runTriageTicket } from "../src/trigger/triage-ticket.js";
import { egress } from "../test-support/egress.js";

// P3-T10e: the real intake and triage bodies with their real deps, on the local
// REST stack (migrations 0001 to 0003, the 30 seed KB articles). TypeSafe, the
// LLM and Langfuse are mocked at HTTP through the egress recorder, which the
// setup file checks after every test (canaries, forbidden strings, emails).
// The Trigger.dev runtime is not part of it: the triage trigger is a recorder,
// and a retry is the body called again.

const seedPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/seed/kb-articles.json",
);
const seed: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
const seedArticles = () => kbIngestPayload.parse({ articles: seed }).articles;

// Public endpoints, never reached: every request to them is answered by msw.
const LLM_BASE_URL = "https://opencode.ai/zen/go/v1";
const LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
// The SDK's own default, unless the environment points it elsewhere.
const TYPESAFE_ORIGIN = new URL(process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai")
  .origin;
const ORIGINS = {
  typesafe: new URL(TYPESAFE_ORIGIN).host,
  llm: new URL(LLM_BASE_URL).host,
  langfuse: new URL(LANGFUSE_BASE_URL).host,
};
const MODEL = "jev-1.13.0";
const TOKENS = { input_tokens: 40, output_tokens: 6 };

let stack: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
let repos: Repositories;
let env: Record<string, string>;

function sql(): ReturnType<typeof clientFor> {
  if (!db) throw new Error("database client not connected");
  return db;
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

// ---- HTTP mocks --------------------------------------------------------------

const probabilities = <L extends string>(labels: readonly L[], pick: L) =>
  Object.fromEntries(
    labels.map((label) => [label, label === pick ? 0.9 : 0.1 / (labels.length - 1)]),
  );
const choiceAnswer = <L extends string>(labels: readonly L[], pick: L) => ({
  type: "choice",
  choice: pick,
  confidence: 0.9,
  probabilities: probabilities(labels, pick),
});

/** One System One answer per request kind, told apart by the question keys. */
function typesafeAnswer(questions: string[]): Record<string, unknown> {
  if (questions.includes("legal")) {
    return Object.fromEntries(
      SENSITIVE_TOPICS.map((topic) => [topic, { type: "noul", noul: 0.02 }]),
    );
  }
  if (questions.includes("category")) {
    return {
      category: choiceAnswer(CATEGORIES, "network"),
      priority: choiceAnswer(PRIORITIES, "P3"),
      urgency: choiceAnswer(URGENCIES, "medium"),
      assignment_group: choiceAnswer(ASSIGNMENT_GROUPS, "Network"),
      outage_or_duplicate: { type: "noul", noul: 0.05 },
      injection: { type: "noul", noul: 0.02 },
      actionable: { type: "noul", noul: 0.95 },
    };
  }
  if (questions.includes("grounded")) return { grounded: { type: "score", score: 3 } };
  // KB rerank: a1 is the best match, the rest loosely related.
  return Object.fromEntries(
    questions.map((key) => [key, { type: "score", score: key === "a1" ? 3 : 1 }]),
  );
}

const questionKeys = (body: string): string[] =>
  Object.keys((JSON.parse(body) as { questions?: Record<string, unknown> }).questions ?? {});

function mockProviders(): void {
  egress.mock(TYPESAFE_ORIGIN, async ({ request }) => {
    const answers = typesafeAnswer(questionKeys(await request.text()));
    return HttpResponse.json({ model: MODEL, answers, usage: TOKENS });
  });
  egress.mock(LLM_BASE_URL, () =>
    HttpResponse.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1_790_000_000,
      model: "test-llm",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              steps: ["Restart the VPN client.", "Sign in to the VPN again."],
              caveats: [],
            }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    }),
  );
  egress.mock(LANGFUSE_BASE_URL, () => HttpResponse.json({}));
}

/** Requests to a host, from the `from`-th recorded request on. */
const requestsTo = (host: string, from = 0) =>
  egress
    .requests()
    .slice(from)
    .filter((r) => r.host === host);

/** TypeSafe requests by kind: the question keys say which step sent it. */
function typesafeKinds(from = 0): string[] {
  return requestsTo(ORIGINS.typesafe, from).map((r) => {
    const keys = questionKeys(r.body);
    if (keys.includes("legal")) return "sensitive_check";
    if (keys.includes("category")) return "triage_judgments";
    if (keys.includes("grounded")) return "grounding";
    return "kb_rerank";
  });
}

/** Spans the mocked Langfuse host received for a ticket (OTLP session id). */
function spansFor(ticketId: string): number {
  let count = 0;
  for (const request of requestsTo(ORIGINS.langfuse)) {
    const body = JSON.parse(request.body) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }>;
        }>;
      }>;
    };
    for (const resource of body.resourceSpans)
      for (const scope of resource.scopeSpans)
        for (const span of scope.spans)
          if (
            span.attributes.some(
              (a) => a.key === "langfuse.session.id" && a.value.stringValue === ticketId,
            )
          )
            count++;
  }
  return count;
}

// ---- Database helpers --------------------------------------------------------

async function rowCount(table: string, ticketId?: string): Promise<number> {
  const result =
    ticketId === undefined
      ? await sql().query(`select count(*) as n from itsupport.${table}`)
      : await sql().query(`select count(*) as n from itsupport.${table} where ticket_id = $1`, [
          ticketId,
        ]);
  return Number(result.rows[0].n);
}

async function eventTypes(ticketId: string): Promise<string[]> {
  const result = await sql().query(
    "select type from itsupport.ticket_events where ticket_id = $1 order by id",
    [ticketId],
  );
  return result.rows.map((row: { type: string }) => row.type);
}

async function aiCalls(ticketId: string) {
  const result = await sql().query(
    "select provider, kind, tokens_in, tokens_out from itsupport.ai_calls where ticket_id = $1 order by at, id",
    [ticketId],
  );
  return result.rows as Array<{
    provider: string;
    kind: string;
    tokens_in: number | null;
    tokens_out: number | null;
  }>;
}

async function triageRow(ticketId: string) {
  const result = await sql().query("select * from itsupport.triage_results where ticket_id = $1", [
    ticketId,
  ]);
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function ticketStatus(ticketId: string): Promise<string> {
  const result = await sql().query("select status from itsupport.tickets where id = $1", [
    ticketId,
  ]);
  return (result.rows[0] as { status: string }).status;
}

/**
 * canaryTicketText without the IPv6 address: redact() does not cover IPv6
 * until P3-T3b (held), so the address would reach every provider. The
 * recorder still scans for the IPv6 canary. Remove this filter with P3-T3b.
 */
function ticketCanaryText(): string {
  const ipv6 = buildCanaries(egress.runId).find((canary) => canary.type === "ipv6")?.value;
  if (ipv6 === undefined) throw new Error("no IPv6 canary");
  const text = canaryTicketText(egress.runId);
  expect(text).toContain(ipv6);
  return text.replaceAll(ipv6, "an IPv6 address");
}

/** A ticket whose description holds every canary but IPv6; its name and email are forbidden. */
async function createCanaryTicket(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const name = `Integration Requester ${suffix}`;
  const email = `requester.${suffix}@example.test`;
  egress.forbid(name);
  egress.forbid(email);
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: "VPN not connecting",
    raw_description: `${ticketCanaryText()}\nThe VPN client times out when I connect from home.`,
    requester_email: email,
    requester_name: name,
    department: "Finance",
    idempotency_key: `it-triage-${suffix}`,
  });
  return ticket.id;
}

/** Intake with the real deps; the triage trigger only records its payload. */
async function intake(ticketId: string): Promise<TriageTicketPayload> {
  const triggered: TriageTicketPayload[] = [];
  await runIntakeTicket(
    { ticketId },
    {
      ...createIntakeDeps(env),
      triggerTriage: async (payload) => void triggered.push(payload),
      logger: quiet,
    },
  );
  expect(triggered).toHaveLength(1);
  return triggered[0]!;
}

const triage = (payload: TriageTicketPayload, attempt = 1) =>
  runTriageTicket(payload, { ...createTriageDeps(env), logger: quiet }, attempt);

const TRIAGE_EVENTS = ["kb_matched", "fix_drafted", "policy_decided", "triaged"];

/** The events written after sensitive_checked. */
async function eventsAfterCheck(ticketId: string): Promise<string[]> {
  const types = await eventTypes(ticketId);
  return types.slice(types.indexOf("sensitive_checked") + 1);
}

// ---- Suite -------------------------------------------------------------------

beforeAll(async () => {
  stack = await startRestStack();
  db = clientFor(stack.pg);
  await db.connect();
  env = {
    SUPABASE_URL: stack.url,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    SUPABASE_DB_SCHEMA: "itsupport",
    TYPESAFE_API_KEY: "x".repeat(32),
    LLM_API_KEY: "x".repeat(32),
    LLM_BASE_URL,
    LLM_MODEL: "test-llm",
    LANGFUSE_PUBLIC_KEY: "x".repeat(16),
    LANGFUSE_SECRET_KEY: "x".repeat(24),
    LANGFUSE_BASE_URL,
    E2E_MODE: "false",
  };
  repos = createRepositories(createDbClient(env));
  await runKbIngest({ articles: seedArticles() }, { repos, logger: quiet });
  expect(await rowCount("kb_articles")).toBe(30);
}, 300_000);

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(stack);
});

beforeEach(() => {
  mockProviders();
});

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
      await runKbIngest({ articles: seedArticles() }, { repos, logger: quiet });
    }
  });
});
