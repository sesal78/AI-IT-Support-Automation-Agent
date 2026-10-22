import { createHash } from "node:crypto";
import { errorClassName } from "../client.ts";

/** The Langfuse dataset that holds one item per eval ticket. */
export const EVAL_DATASET = "itsupport-eval-v1";

// Langfuse public API, checked 2026-10-19 against
// https://cloud.langfuse.com/generated/api/openapi.yml and
// https://langfuse.com/integrations/native/opentelemetry/experiments.
// The REST endpoint for dataset run items is gone from the public API; a run
// ("experiment") item is now one OTLP trace whose root span carries the
// `langfuse.experiment.*` attributes.
const DATASET_PATH = (name: string) => `/api/public/v2/datasets/${encodeURIComponent(name)}`;
const DATASETS_PATH = "/api/public/v2/datasets";
const DATASET_ITEMS_PATH = "/api/public/dataset-items";
const OTLP_TRACES_PATH = "/api/public/otel/v1/traces";
// Direct OTLP exporters must send it (openapi.yml, "Real-time data").
const INGESTION_VERSION = "4";
const SCOPE_NAME = "ai-it-support-agent/eval";
const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;

/** Tries per request when Langfuse answers 429 or 5xx (P3-T10m); then the request fails. */
export const LANGFUSE_MAX_TRIES = 5;
/** Longest wait before a retry, whatever Retry-After asks for. */
export const LANGFUSE_MAX_RETRY_WAIT_MS = 30_000;
/** Wait before the first retry when there is no usable Retry-After; it doubles each retry. */
export const LANGFUSE_BACKOFF_MS = 1_000;
/** Least time between the starts of two requests, so a 100-ticket run does not burst. */
export const LANGFUSE_PACE_MS = 200;

/** A Langfuse request that failed. Names the endpoint template and the status or error class; never a body. */
export class LangfuseRequestError extends Error {
  override readonly name = "LangfuseRequestError";
  readonly endpoint: string;
  constructor(endpoint: string, problem: string) {
    super(`${endpoint}: ${problem}`);
    this.endpoint = endpoint;
  }
}

export interface LangfuseConfig {
  readonly publicKey: string;
  readonly secretKey: string;
  /** LANGFUSE_BASE_URL, already validated as https. */
  readonly baseUrl: string;
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

export interface LangfuseClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const isRetryable = (status: number) => status === 429 || status >= 500;

/**
 * The wait before retry `retry` (1 for the first), at most
 * `LANGFUSE_MAX_RETRY_WAIT_MS`. Retry-After counts only as whole seconds
 * (`/^\d+$/`) or as an HTTP date (it has letters) that is now or later; any
 * other value, such as "-1", "1.5" or a past date, falls back to 1, 2, 4, 8 s.
 */
export function retryWaitMs(retryAfter: string | null, retry: number, now: number): number {
  let wait = LANGFUSE_BACKOFF_MS * 2 ** (retry - 1);
  const value = retryAfter?.trim() ?? "";
  const date = /[A-Za-z]/.test(value) ? Date.parse(value) : Number.NaN;
  if (/^\d+$/.test(value)) wait = Number(value) * 1_000;
  else if (!Number.isNaN(date) && date >= now) wait = date - now;
  return Math.min(wait, LANGFUSE_MAX_RETRY_WAIT_MS);
}

interface LangfuseApi {
  request(
    endpoint: string,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: unknown }>;
}

/**
 * Requests to the origin of LANGFUSE_BASE_URL only: a path that resolves
 * elsewhere is refused before sending, and `redirect: "manual"` returns a 30x
 * as-is, so the Basic credentials never leave for another host.
 *
 * Paced and retried (P3-T10m): a request starts at least `LANGFUSE_PACE_MS`
 * after the one before, and a 429, a 5xx or a network failure is sent again
 * after `retryWaitMs`, up to `LANGFUSE_MAX_TRIES` tries in all; the last one
 * throws LangfuseRequestError with its status or error class.
 */
function createLangfuseApi(
  config: LangfuseConfig,
  doFetch: FetchLike,
  clock: LangfuseClock,
): LangfuseApi {
  const origin = new URL(config.baseUrl).origin;
  const authorization = `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString(
    "base64",
  )}`;
  let lastStart: number | null = null;

  async function send(
    endpoint: string,
    method: string,
    url: URL,
    body: unknown,
    extra: Record<string, string>,
  ): Promise<{ status: number; json: unknown; retryAfter: string | null } | { failed: string }> {
    if (lastStart !== null) {
      const wait = lastStart + LANGFUSE_PACE_MS - clock.now();
      if (wait > 0) await clock.sleep(wait);
    }
    lastStart = clock.now();
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      text = await response.text();
    } catch (error) {
      return { failed: `request failed (${errorClassName(error)})` };
    }
    let json: unknown = null;
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, retryAfter: response.headers.get("retry-after") };
  }

  return {
    async request(endpoint, method, path, body, extra = {}) {
      const url = path.startsWith("/") && !path.startsWith("//") ? new URL(path, origin) : null;
      if (url === null || url.origin !== origin) {
        throw new LangfuseRequestError(endpoint, "origin refused");
      }
      for (let tries = 1; ; tries += 1) {
        const sent = await send(endpoint, method, url, body, extra);
        if ("status" in sent && !isRetryable(sent.status)) {
          return { status: sent.status, json: sent.json };
        }
        if (tries === LANGFUSE_MAX_TRIES) {
          const problem = "status" in sent ? `status ${sent.status}` : sent.failed;
          throw new LangfuseRequestError(endpoint, `${problem} after ${tries} tries`);
        }
        const retryAfter = "status" in sent ? sent.retryAfter : null;
        await clock.sleep(retryWaitMs(retryAfter, tries, clock.now()));
      }
    },
  };
}

/** One eval ticket of the run, as Langfuse gets it: labels and numbers, never ticket text. */
export interface DatasetRunItem {
  /** Dataset ID, for example `E001`. */
  readonly evalId: string;
  readonly set: string;
  /** The labels the dataset expects (no forbidden phrases: they quote ticket text). */
  readonly expected: Record<string, unknown>;
  /** The app's ticket UUID; its pipeline spans carry it as `langfuse.session.id`. Null when the ticket never ran. */
  readonly ticketId: string | null;
  /** What the run produced: status, labels and judge values. */
  readonly output: Record<string, unknown>;
}

export interface DatasetRunResult {
  readonly datasetId: string;
  readonly items: number;
  readonly linked: number;
}

/** Stable dataset item ID: item IDs are unique per project, so the dataset name is part of it. */
export const datasetItemId = (evalId: string): string => `${EVAL_DATASET}:${evalId}`;

/** Deterministic OTLP IDs, so sending the same link again overwrites it instead of adding one. */
function linkIds(runId: string, itemId: string): { traceId: string; spanId: string } {
  const hex = createHash("sha256").update(`${EVAL_DATASET}\n${runId}\n${itemId}`).digest("hex");
  return { traceId: hex.slice(0, 32), spanId: hex.slice(32, 48) };
}

const unixNano = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

function linkExport(runId: string, datasetId: string, item: DatasetRunItem, at: number) {
  const itemId = datasetItemId(item.evalId);
  const { traceId, spanId } = linkIds(runId, itemId);
  const attributes: Array<{ key: string; value: { stringValue: string } }> = [];
  const add = (key: string, value: string) =>
    attributes.push({ key, value: { stringValue: value } });
  add("langfuse.trace.name", "eval-item");
  // The ticket's trace reference: every pipeline span of the ticket has this session ID.
  add("langfuse.session.id", item.ticketId!);
  add("langfuse.environment", "e2e");
  add("langfuse.experiment.id", `${EVAL_DATASET}:${runId}`);
  add("langfuse.experiment.name", runId);
  add("langfuse.experiment.dataset.id", datasetId);
  add("langfuse.experiment.item.id", itemId);
  add("langfuse.experiment.item.root_observation_id", spanId);
  add("langfuse.experiment.item.expected_output", JSON.stringify(item.expected));
  add("langfuse.experiment.item.metadata.ticket_id", item.ticketId!);
  add("langfuse.observation.input", JSON.stringify({ evalTicketId: item.evalId, set: item.set }));
  add("langfuse.observation.output", JSON.stringify(item.output));
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: [
              {
                traceId,
                spanId,
                name: "eval-item",
                kind: SPAN_KIND_INTERNAL,
                startTimeUnixNano: unixNano(at),
                endTimeUnixNano: unixNano(at),
                attributes,
                status: { code: STATUS_OK },
              },
            ],
          },
        ],
      },
    ],
  };
}

function rejectedSpans(json: unknown): number {
  const partial = (json as { partialSuccess?: { rejectedSpans?: unknown } } | null)?.partialSuccess;
  const rejected = partial?.rejectedSpans;
  return rejected === undefined || rejected === null ? 0 : Number(rejected);
}

const isOk = (status: number) => status >= 200 && status < 300;

/**
 * Records an eval run in Langfuse: makes sure the dataset `itsupport-eval-v1`
 * exists, upserts one dataset item per eval ticket (ID `itsupport-eval-v1:<id>`),
 * and sends one experiment item trace per ticket that ran, under the
 * experiment (run) name `runId`, with the ticket UUID as its session ID.
 * Idempotent: the dataset is found by name, items are upserted on their ID,
 * and the link traces have IDs derived from the run and the item.
 * Requests are paced and a 429 or 5xx is retried (see `createLangfuseApi`).
 * Throws LangfuseRequestError on the first request that still fails.
 */
export async function recordDatasetRun(
  config: LangfuseConfig,
  runId: string,
  items: readonly DatasetRunItem[],
  options: { fetch?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DatasetRunResult> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const api = createLangfuseApi(config, options.fetch ?? ((input, init) => fetch(input, init)), {
    now,
    sleep,
  });
  const datasetIdOf = (endpoint: string, status: number, json: unknown): string => {
    const id = (json as { id?: unknown } | null)?.id;
    if (!isOk(status)) throw new LangfuseRequestError(endpoint, `status ${status}`);
    if (typeof id !== "string" || id === "") {
      throw new LangfuseRequestError(endpoint, "response has no dataset id");
    }
    return id;
  };

  const getEndpoint = "GET /api/public/v2/datasets/:name";
  const found = await api.request(getEndpoint, "GET", DATASET_PATH(EVAL_DATASET));
  let datasetId: string;
  if (found.status === 404) {
    const createEndpoint = "POST /api/public/v2/datasets";
    const created = await api.request(createEndpoint, "POST", DATASETS_PATH, {
      name: EVAL_DATASET,
      description: "Eval tickets of evals/tickets.json (labels only, no ticket text).",
    });
    datasetId = datasetIdOf(createEndpoint, created.status, created.json);
  } else {
    datasetId = datasetIdOf(getEndpoint, found.status, found.json);
  }

  const itemEndpoint = "POST /api/public/dataset-items";
  const linkEndpoint = "POST /api/public/otel/v1/traces";
  let linked = 0;
  for (const item of items) {
    const created = await api.request(itemEndpoint, "POST", DATASET_ITEMS_PATH, {
      datasetName: EVAL_DATASET,
      id: datasetItemId(item.evalId),
      input: { evalTicketId: item.evalId, set: item.set },
      expectedOutput: item.expected,
      metadata: { source: "evals/tickets.json" },
    });
    if (!isOk(created.status)) {
      throw new LangfuseRequestError(itemEndpoint, `status ${created.status}`);
    }
    if (item.ticketId === null) continue;
    const sent = await api.request(
      linkEndpoint,
      "POST",
      OTLP_TRACES_PATH,
      linkExport(runId, datasetId, item, now()),
      { "x-langfuse-ingestion-version": INGESTION_VERSION },
    );
    if (!isOk(sent.status)) throw new LangfuseRequestError(linkEndpoint, `status ${sent.status}`);
    const rejected = rejectedSpans(sent.json);
    if (!(rejected === 0)) throw new LangfuseRequestError(linkEndpoint, "span rejected");
    linked += 1;
  }
  return { datasetId, items: items.length, linked };
}
