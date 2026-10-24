import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { canaryTicketText, type TriageTicketPayload } from "@ai-it-support/shared";
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
import {
  ORIGINS,
  mockProviders,
  pipelineEnv,
  questionKeys,
} from "../test-support/provider-mocks.js";

// The canned answers live in test-support (shared with the local runner, P3-T10g).
export {
  FIX_REPLY,
  LANGFUSE_BASE_URL,
  LLM_BASE_URL,
  ORIGINS,
  TYPESAFE_ORIGIN,
  llmReply,
  questionKeys,
  typesafeReply,
} from "../test-support/provider-mocks.js";

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

let stack: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
let repos: Repositories | undefined;
let env: Record<string, string> | undefined;

export function sql(): ReturnType<typeof clientFor> {
  if (!db) throw new Error("database client not connected");
  return db;
}

export function testStack(): RestStack {
  if (!stack) throw new Error("REST stack not started");
  return stack;
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

/** A ticket whose description holds every canary; its name and email are forbidden. */
export async function createCanaryTicket(options: { isTest?: boolean } = {}): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const name = `Integration Requester ${suffix}`;
  const email = `requester.${suffix}@example.test`;
  egress.forbid(name);
  egress.forbid(email);
  const { ticket } = await testRepos().createTicket({
    source: "web",
    raw_title: "VPN not connecting",
    raw_description: `${canaryTicketText(egress.runId)}\nThe VPN client times out when I connect from home.`,
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
    env = pipelineEnv(stack);
    repos = createRepositories(createDbClient(env));
    await runKbIngest({ articles: seedArticles() }, { repos, logger: quiet });
    expect(await rowCount("kb_articles")).toBe(30);
  }, 300_000);

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    await removeRestStack(stack);
  });

  beforeEach(() => {
    mockProviders(egress);
  });
}
