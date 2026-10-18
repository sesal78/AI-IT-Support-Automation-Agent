// Local stand-in for the Trigger.dev cloud, for end-to-end tests (P3-T10g).
// TEST CODE ONLY: never import it from `src`.
//
// It answers the trigger request of @trigger.dev/sdk 4.6.4 (ApiClient.triggerTask
// in @trigger.dev/core 4.6.4):
//   POST /api/v1/tasks/<encodeURIComponent(taskId)>/trigger
//   headers: Authorization: Bearer <secret key>, Content-Type: application/json
//   body: { payload: <packet data>, options: { payloadType, idempotencyKey?, ... } }
//     payloadType "application/super+json": payload is superjson.stringify(value),
//     i.e. the JSON text of { json, meta? }. idempotencyKey is the 64-char SHA-256
//     hex from idempotencyKeys.create (or makeIdempotencyKey for a raw string).
//   response 200: { id, isCached? } (TriggerTaskResponse); the `x-trigger-jwt`
//     header becomes the handle's publicAccessToken, so the SDK signs nothing.
// The SDK does not retry a 4xx other than 408, 409 and 429 (apiClient/core.js).
//
// Each accepted trigger gets a run ID at once; the real task body then runs
// in-process against the local REST stack, up to 3 attempts (maxAttempts in
// trigger.config.ts, short local delays). AbortTaskRunError ends the run at
// once. After the last failed attempt the task's failure hook runs, as in the
// cloud. Same task and idempotency key: the first run's ID, no second run (no
// TTL). A body's own trigger calls (intake chains triage) are scoped to this
// runner with auth.withAuth, so the process env is not touched.
//
// Network: the server binds 127.0.0.1 on a random port. TypeSafe, the LLM and
// Langfuse get canned answers through an egress recorder (msw); a request to
// any other non-127.0.0.1 host is blocked with an error, never sent.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { errorClassName } from "@ai-it-support/ai";
import { INTAKE_TICKET_TASK_ID, TRIAGE_TICKET_TASK_ID } from "@ai-it-support/shared";
import { AbortTaskRunError, auth } from "@trigger.dev/sdk";
import { z } from "zod";
import type { RestStack } from "../../../packages/db/integration/rest-stack.js";
import {
  createEgressRecorder,
  type EgressRecorder,
} from "../../../packages/shared/test-support/egress-recorder.js";
import { healthcheckPayload, runHealthcheck } from "../src/trigger/healthcheck.js";
import {
  createIntakeDeps,
  intakeTicketPayload,
  runIntakeTicket,
} from "../src/trigger/intake-ticket.js";
import {
  createTriageDeps,
  createTriageFailureDeps,
  onTriageFailure,
  runTriageTicket,
  triageTicketPayload,
} from "../src/trigger/triage-ticket.js";
import { mockProviders, pipelineEnv } from "./provider-mocks.js";

export type LocalRunStatus = "QUEUED" | "EXECUTING" | "COMPLETED" | "FAILED";

export interface LocalRun {
  id: string;
  taskId: string;
  status: LocalRunStatus;
  /** Attempts started so far. */
  attempts: number;
  idempotencyKey?: string;
  /** Class name of the last error of a failed run; never its message. */
  error?: string;
}

export interface LocalRunnerOptions {
  restStack: RestStack;
  /**
   * The recorder that answers the providers. Default: the runner starts its
   * own and stops it in stop(). Pass the test file's recorder when one is
   * already running (vitest integration setup); the runner then only adds the
   * canned mocks to it and leaves starting and stopping to its owner.
   */
  egress?: EgressRecorder;
  /** Merged over the run env (pipelineEnv of the stack, E2E_MODE "true"). */
  env?: Record<string, string>;
  /** Delay before attempt n+1 is n times this (default 50 ms). */
  retryDelayMs?: number;
}

export interface LocalRunner {
  /** Base URL for TRIGGER_API_URL, built from the bound address. */
  readonly url: string;
  readonly egress: EgressRecorder;
  /** Snapshot of every run, oldest first (same as GET /runs). */
  runs(): LocalRun[];
  /** Resolves when no run is queued or executing. */
  idle(): Promise<void>;
  /** Waits for runs in flight, closes the server, stops an owned recorder. Idempotent. */
  stop(): Promise<void>;
}

type RunEnv = Record<string, string>;

interface TaskDef {
  parse(payload: unknown): { success: true; data: unknown } | { success: false };
  run(payload: unknown, env: RunEnv, attempt: number): Promise<unknown>;
  onFailure?(payload: unknown, error: unknown, env: RunEnv): Promise<void>;
}

function defineTask<S extends z.ZodType>(
  schema: S,
  run: (payload: z.infer<S>, env: RunEnv, attempt: number) => Promise<unknown>,
  onFailure?: (payload: unknown, error: unknown, env: RunEnv) => Promise<void>,
): TaskDef {
  return {
    parse: (payload) => {
      const result = schema.safeParse(payload);
      return result.success ? { success: true, data: result.data } : { success: false };
    },
    run: (payload, env, attempt) => run(payload as z.infer<S>, env, attempt),
    ...(onFailure ? { onFailure } : {}),
  };
}

// The real bodies with their real deps, as the task definitions in src/trigger wire them.
const TASKS: Record<string, TaskDef> = {
  [INTAKE_TICKET_TASK_ID]: defineTask(intakeTicketPayload, (payload, env, attempt) =>
    runIntakeTicket(payload, createIntakeDeps(env), attempt),
  ),
  [TRIAGE_TICKET_TASK_ID]: defineTask(
    triageTicketPayload,
    (payload, env, attempt) => runTriageTicket(payload, createTriageDeps(env), attempt),
    (payload, error, env) => onTriageFailure({ payload, error }, createTriageFailureDeps(env)),
  ),
  healthcheck: defineTask(healthcheckPayload, (payload, env) => runHealthcheck(payload, env)),
};

const MAX_ATTEMPTS = 3;
const MAX_BODY_BYTES = 1024 * 1024;

const triggerBody = z.object({
  payload: z.unknown().optional(),
  options: z
    .object({
      payloadType: z.string().optional(),
      idempotencyKey: z.string().min(1).max(2048).optional(),
    })
    .optional(),
});

class BadRequest extends Error {}

/** The task payload from the SDK's packet (stringifyIO in @trigger.dev/core). */
function decodePayload(data: unknown, payloadType = "application/json"): unknown {
  if (data === undefined) return undefined;
  switch (payloadType) {
    case "application/super+json": {
      if (typeof data !== "string") throw new BadRequest("payload is not a superjson string");
      const packet = JSON.parse(data) as { json?: unknown; meta?: unknown };
      // Only plain JSON values: a meta block means Dates, Maps and the like.
      if (packet.meta !== undefined) throw new BadRequest("superjson meta is not supported");
      return packet.json;
    }
    case "application/json":
      return typeof data === "string" ? JSON.parse(data) : data;
    case "text/plain":
      return data;
    default:
      throw new BadRequest(`payload type ${payloadType} is not supported`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequest("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startLocalRunner(options: LocalRunnerOptions): Promise<LocalRunner> {
  const owned = options.egress === undefined;
  const egress = options.egress ?? createEgressRecorder();
  if (owned) egress.start();
  mockProviders(egress);

  const env: RunEnv = { ...pipelineEnv(options.restStack, true), ...options.env };
  const retryDelayMs = options.retryDelayMs ?? 50;
  const runs = new Map<string, LocalRun>();
  const byKey = new Map<string, string>();
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  let url = "";

  const sdkScope = { baseURL: "", accessToken: "x".repeat(32) };
  const scoped = <T>(fn: () => Promise<T>) => auth.withAuth(sdkScope, fn);

  async function execute(run: LocalRun, task: TaskDef, payload: unknown): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      run.status = "EXECUTING";
      run.attempts = attempt;
      try {
        await scoped(() => task.run(payload, env, attempt));
        run.status = "COMPLETED";
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof AbortTaskRunError || stopping) break;
        if (attempt < MAX_ATTEMPTS) await delay(retryDelayMs * attempt);
      }
    }
    if (task.onFailure) {
      const onFailure = task.onFailure;
      await scoped(() => onFailure(payload, lastError, env)).catch(() => undefined);
    }
    run.status = "FAILED";
    run.error = errorClassName(lastError);
  }

  function enqueue(taskId: string, task: TaskDef, payload: unknown, key?: string): LocalRun {
    const run: LocalRun = {
      id: `run_${randomBytes(12).toString("hex")}`,
      taskId,
      status: "QUEUED",
      attempts: 0,
      ...(key === undefined ? {} : { idempotencyKey: key }),
    };
    runs.set(run.id, run);
    if (key !== undefined) byKey.set(`${taskId}\n${key}`, run.id);
    // Started on the next tick, so the trigger answers before the body runs.
    const done = delay(0)
      .then(() => execute(run, task, payload))
      .finally(() => inFlight.delete(done));
    inFlight.add(done);
    return run;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", url).pathname;
    if (req.method === "GET" && path === "/runs") {
      send(res, 200, { runs: [...runs.values()].map((run) => ({ ...run })) });
      return;
    }
    const match = /^\/api\/v1\/tasks\/([^/]+)\/trigger$/.exec(path);
    if (req.method !== "POST" || !match) {
      send(res, 404, { error: "Not found" });
      return;
    }
    const taskId = decodeURIComponent(match[1] ?? "");
    const task = TASKS[taskId];
    if (!task) {
      send(res, 404, { error: "Task not found" });
      return;
    }
    let payload: unknown;
    let key: string | undefined;
    try {
      const body = triggerBody.safeParse(JSON.parse(await readBody(req)));
      if (!body.success) throw new BadRequest("invalid trigger body");
      payload = decodePayload(body.data.payload, body.data.options?.payloadType);
      key = body.data.options?.idempotencyKey;
    } catch (error) {
      const reason = error instanceof BadRequest ? error.message : "body is not JSON";
      send(res, 400, { error: `Invalid request: ${reason}` });
      return;
    }
    const parsed = task.parse(payload);
    if (!parsed.success) {
      // Nothing is written: no run, no body call.
      send(res, 400, { error: "Payload does not match the task schema" });
      return;
    }
    const cachedId = key === undefined ? undefined : byKey.get(`${taskId}\n${key}`);
    const headers = { "x-trigger-jwt": "local-runner" };
    if (cachedId !== undefined) {
      send(res, 200, { id: cachedId, isCached: true }, headers);
      return;
    }
    const run = enqueue(taskId, task, parsed.data, key);
    send(res, 200, { id: run.id, isCached: false }, headers);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: "Runner error" });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  url = `http://${address.address}:${address.port}`;
  sdkScope.baseURL = url;

  const idle = async () => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      // Runs in flight finish first: a body may still trigger its next task here.
      await idle();
      stopping = true;
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await idle();
      if (owned) egress.stop();
    })();
    return stopped;
  };

  return {
    url,
    egress,
    runs: () => [...runs.values()].map((run) => ({ ...run })),
    idle,
    stop,
  };
}
