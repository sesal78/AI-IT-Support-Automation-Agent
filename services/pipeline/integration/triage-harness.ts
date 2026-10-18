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
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
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

// Shared harness of the triage integration suites (P3-T10e, P3-T10f): the real
// intake and triage bodies with their real deps, on the local REST stack
// (migrations 0001 to 0003, the 30 seed KB articles). TypeSafe, the LLM and
// Langfuse are mocked at HTTP through the egress recorder, which the setup
// file checks after every test (canaries, forbidden strings, emails). The
// Trigger.dev runtime is not part of it: the triage trigger is a recorder,
// and a retry is the body called again. Each test file calls useTriageStack().

const seedPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/seed/kb-articles.json",
);
const seed: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
export const seedArticles = () => kbIngestPayload.parse({ articles: seed }).articles;

// Public endpoints, never reached: every request to them is answered by msw.
export const LLM_BASE_URL = "https://opencode.ai/zen/go/v1";
export const LANGFUSE_BASE_URL = "https://cloud.langfuse.com";
// The SDK's own default, unless the environment points it elsewhere.
export const TYPESAFE_ORIGIN = new URL(
  process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai",
).origin;
export const ORIGINS = {
  typesafe: new URL(TYPESAFE_ORIGIN).host,
  llm: new URL(LLM_BASE_URL).host,
  langfuse: new URL(LANGFUSE_BASE_URL).host,
};
const MODEL = "jev-1.13.0";
const TOKENS = { input_tokens: 40, output_tokens: 6 };

let stack: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
let repos: Repositories | undefined;
let env: Record<string, string> | undefined;

export function sql(): ReturnType<typeof clientFor> {
  if (!db) throw new Error("database client not connected");
  return db;
}

export function testRepos(): Repositories {
  if (!repos) throw new Error("repositories not built");
  return repos;
}

export function testEnv(): Record<string, string> {
  if (!env) throw new Error("env not built");
  return env;
}

export const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

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

export const questionKeys = (body: string): string[] =>
  Object.keys((JSON.parse(body) as { questions?: Record<string, unknown> }).questions ?? {});

/** A 200 System One reply for a TypeSafe request body. */
export const typesafeReply = (body: string) =>
  HttpResponse.json({ model: MODEL, answers: typesafeAnswer(questionKeys(body)), usage: TOKENS });

/** A 200 chat completion whose message content is `content`. */
export const llmReply = (content: string) =>
  HttpResponse.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_790_000_000,
    model: "test-llm",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  });

export const FIX_REPLY = JSON.stringify({
  steps: ["Restart the VPN client.", "Sign in to the VPN again."],
  caveats: [],
});

/** The default mocks; a test registers its own after them to override one host. */
function mockProviders(): void {
  egress.mock(TYPESAFE_ORIGIN, async ({ request }) => typesafeReply(await request.text()));
  egress.mock(LLM_BASE_URL, () => llmReply(FIX_REPLY));
  egress.mock(LANGFUSE_BASE_URL, () => HttpResponse.json({}));
}

/** Requests to a host, from the `from`-th recorded request on. */
export const requestsTo = (host: string, from = 0) =>
  egress
    .requests()
    .slice(from)
    .filter((r) => r.host === host);

/** TypeSafe requests by kind: the question keys say which step sent it. */
export function typesafeKinds(from = 0): string[] {
  return requestsTo(ORIGINS.typesafe, from).map((r) => {
    const keys = questionKeys(r.body);
    if (keys.includes("legal")) return "sensitive_check";
    if (keys.includes("category")) return "triage_judgments";
    if (keys.includes("grounded")) return "grounding";
    return "kb_rerank";
  });
}

/** Spans the mocked Langfuse host received for a ticket (OTLP session id). */
export function spansFor(ticketId: string): number {
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

export async function rowCount(table: string, ticketId?: string): Promise<number> {
  const result =
    ticketId === undefined
      ? await sql().query(`select count(*) as n from itsupport.${table}`)
      : await sql().query(`select count(*) as n from itsupport.${table} where ticket_id = $1`, [
          ticketId,
        ]);
  return Number(result.rows[0].n);
}

export async function eventTypes(ticketId: string): Promise<string[]> {
  const result = await sql().query(
    "select type from itsupport.ticket_events where ticket_id = $1 order by id",
    [ticketId],
  );
  return result.rows.map((row: { type: string }) => row.type);
}

/** The payloads of a ticket's events of one type, oldest first. */
export async function eventPayloads(ticketId: string, type: string): Promise<unknown[]> {
  const result = await sql().query(
    "select payload from itsupport.ticket_events where ticket_id = $1 and type = $2 order by id",
    [ticketId, type],
  );
  return result.rows.map((row: { payload: unknown }) => row.payload);
}

export async function aiCalls(ticketId: string) {
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

export async function triageRow(ticketId: string) {
  const result = await sql().query("select * from itsupport.triage_results where ticket_id = $1", [
    ticketId,
  ]);
  return result.rows[0] as Record<string, unknown> | undefined;
}

export async function ticketStatus(ticketId: string): Promise<string> {
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
export async function createCanaryTicket(options: { isTest?: boolean } = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const name = `Integration Requester ${suffix}`;
  const email = `requester.${suffix}@example.test`;
  egress.forbid(name);
  egress.forbid(email);
  const { ticket } = await testRepos().createTicket({
    source: "web",
    raw_title: "VPN not connecting",
    raw_description: `${ticketCanaryText()}\nThe VPN client times out when I connect from home.`,
    requester_email: email,
    requester_name: name,
    department: "Finance",
    idempotency_key: `it-triage-${suffix}`,
    ...(options.isTest === undefined ? {} : { is_test: options.isTest }),
  });
  return ticket.id;
}

/** Intake with the real deps; the triage trigger only records its payload. */
export async function intake(ticketId: string): Promise<TriageTicketPayload> {
  const triggered: TriageTicketPayload[] = [];
  await runIntakeTicket(
    { ticketId },
    {
      ...createIntakeDeps(testEnv()),
      triggerTriage: async (payload) => void triggered.push(payload),
      logger: quiet,
    },
  );
  expect(triggered).toHaveLength(1);
  return triggered[0]!;
}

/** The triage body with the real deps; `envOverrides` change the env of this run only. */
export const triage = (
  payload: TriageTicketPayload,
  attempt = 1,
  envOverrides: Record<string, string> = {},
) =>
  runTriageTicket(
    payload,
    { ...createTriageDeps({ ...testEnv(), ...envOverrides }), logger: quiet },
    attempt,
  );

export const TRIAGE_EVENTS = ["kb_matched", "fix_drafted", "policy_decided", "triaged"];

/** The events written after sensitive_checked. */
export async function eventsAfterCheck(ticketId: string): Promise<string[]> {
  const types = await eventTypes(ticketId);
  return types.slice(types.indexOf("sensitive_checked") + 1);
}

// ---- Suite hooks -------------------------------------------------------------

/** Starts the stack and seeds the KB for the calling test file; mocks reset per test. */
export function useTriageStack(): void {
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
}
