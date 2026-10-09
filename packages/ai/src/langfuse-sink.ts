import { TraceExportError, type TraceSink, type TraceSpan } from "./trace.js";

/** The three Langfuse variables, already validated by `langfuseEnvShape` (packages/shared). */
export interface LangfuseEnv {
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_BASE_URL: string;
}

export interface LangfuseSinkOptions {
  /** Test switch `langfuseDown`: `record` rejects and no request is made. */
  forceDown?: boolean;
  /** Whole-request limit, headers and body. Default 4000, so a failure shows within 5 s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const LANGFUSE_TIMEOUT_MS = 4000;
const MAX_RESPONSE_BYTES = 64 * 1024;
// Langfuse OTLP/HTTP trace endpoint (JSON encoding, Basic auth public:secret).
// It replaces `/api/public/ingestion`, which Langfuse Cloud stops accepting for
// traces on 2026-11-16. Docs: https://langfuse.com/integrations/native/opentelemetry
const OTLP_TRACES_PATH = "/api/public/otel/v1/traces";
// Selects Langfuse's v4 ingestion path, so spans show in real time.
const INGESTION_VERSION = "4";
const SCOPE_NAME = "ai-it-support-agent";
// OTLP enums are integers in JSON: SpanKind CLIENT, StatusCode OK and ERROR.
const SPAN_KIND_CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Reads at most `limit` bytes; null when the body is larger. */
async function readLimited(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      // Not awaited: cancelling a stream can wait on the rest of the body.
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tracesUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("LANGFUSE_BASE_URL must be a URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("LANGFUSE_BASE_URL must be an https URL without credentials");
  }
  return new URL(OTLP_TRACES_PATH, url.origin).toString();
}

type AnyValue = { stringValue: string };
type KeyValue = { key: string; value: AnyValue };

function hexId(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function unixNano(date: Date): string {
  // OTLP/JSON encodes 64-bit integers as decimal strings.
  return (BigInt(date.getTime()) * 1_000_000n).toString();
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** One OTLP `ExportTraceServiceRequest` holding one generation span. */
function buildExport(span: TraceSpan) {
  const failed = span.error !== undefined;
  const attributes: KeyValue[] = [];
  const add = (key: string, value: string) =>
    attributes.push({ key, value: { stringValue: value } });
  add("langfuse.observation.type", "generation");
  add("langfuse.trace.name", span.kind);
  // One filter lists all spans of a ticket.
  if (span.ticketId !== undefined) add("langfuse.session.id", span.ticketId);
  add("langfuse.environment", span.environment);
  add("langfuse.observation.model.name", span.model);
  add("langfuse.observation.input", asText(span.input));
  if (span.output !== undefined) add("langfuse.observation.output", asText(span.output));
  if (span.tokensIn !== null && span.tokensOut !== null) {
    add(
      "langfuse.observation.usage_details",
      JSON.stringify({ input: span.tokensIn, output: span.tokensOut }),
    );
  }
  add("langfuse.observation.metadata.provider", span.provider);
  add("langfuse.observation.metadata.kind", span.kind);
  if (failed) {
    add("langfuse.observation.level", "ERROR");
    add("langfuse.observation.status_message", span.error ?? "");
  }
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: [
              {
                traceId: hexId(16),
                spanId: hexId(8),
                name: span.kind,
                kind: SPAN_KIND_CLIENT,
                startTimeUnixNano: unixNano(span.startTime),
                endTimeUnixNano: unixNano(span.endTime),
                attributes,
                status: failed
                  ? { code: STATUS_ERROR, message: span.error ?? "" }
                  : { code: STATUS_OK },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Rejected span count from an `ExportTraceServiceResponse`; throws when unreadable. */
function rejectedSpans(text: string): number {
  // An empty ExportTraceServiceResponse is a full success.
  if (text.trim() === "") return 0;
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("not an object");
  }
  const partial = (parsed as { partialSuccess?: unknown }).partialSuccess;
  if (partial === undefined || partial === null) return 0;
  if (typeof partial !== "object") throw new SyntaxError("bad partialSuccess");
  const rejected = (partial as { rejectedSpans?: unknown }).rejectedSpans;
  if (rejected === undefined || rejected === null) return 0;
  // int64 arrives as a decimal string or a number.
  const count =
    typeof rejected === "number" || typeof rejected === "string" ? Number(rejected) : Number.NaN;
  if (!Number.isFinite(count)) throw new SyntaxError("bad rejectedSpans");
  return count;
}

/**
 * Sends each span to Langfuse Cloud as one OTLP/HTTP JSON export request with
 * one span (no SDK: the OpenTelemetry exporter cannot report a failed export
 * to the caller). No retries; one try, then `TraceExportError`. A partial
 * success (`partialSuccess.rejectedSpans > 0`) fails the export.
 *
 * Privacy: the body holds exactly what the span holds (redacted text). The
 * secret key goes only into the Authorization header and never into an error
 * or a log. Redirects are refused so the header cannot leave for another host.
 * An error carries a fixed reason (status code, timeout, network), never a
 * response body.
 */
export function createLangfuseSink(env: LangfuseEnv, options: LangfuseSinkOptions = {}): TraceSink {
  const url = tracesUrl(env.LANGFUSE_BASE_URL);
  if (env.LANGFUSE_PUBLIC_KEY === "" || env.LANGFUSE_SECRET_KEY === "") {
    throw new TypeError("Langfuse keys must not be empty");
  }
  const authorization = `Basic ${Buffer.from(
    `${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`,
  ).toString("base64")}`;
  const timeoutMs = options.timeoutMs ?? LANGFUSE_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;

  return {
    async record(span) {
      if (options.forceDown === true) throw new TraceExportError("sink forced down");
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            "x-langfuse-ingestion-version": INGESTION_VERSION,
          },
          body: JSON.stringify(buildExport(span)),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new TraceExportError(timedOut ? "timeout" : "network error");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new TraceExportError(`HTTP ${response.status}`);
      }
      let text: string | null;
      try {
        text = await readLimited(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new TraceExportError(timedOut ? "timeout" : "network error");
      }
      if (text === null) throw new TraceExportError("response too large");
      let rejected: number;
      try {
        rejected = rejectedSpans(text);
      } catch {
        throw new TraceExportError("unreadable response");
      }
      if (rejected > 0) throw new TraceExportError("rejected spans");
    },
  };
}
