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
// Langfuse public ingestion API (batch of events, Basic auth public:secret).
const INGESTION_PATH = "/api/public/ingestion";

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

function ingestionUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("LANGFUSE_BASE_URL must be a URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("LANGFUSE_BASE_URL must be an https URL without credentials");
  }
  return new URL(INGESTION_PATH, url.origin).toString();
}

function buildBatch(span: TraceSpan) {
  const traceId = crypto.randomUUID();
  const timestamp = span.startTime.toISOString();
  const failed = span.error !== undefined;
  return [
    {
      id: crypto.randomUUID(),
      type: "trace-create",
      timestamp,
      body: {
        id: traceId,
        timestamp,
        name: span.kind,
        // One filter lists all spans of a ticket.
        ...(span.ticketId === undefined ? {} : { sessionId: span.ticketId }),
        environment: span.environment,
        input: span.input,
        ...(span.output === undefined ? {} : { output: span.output }),
      },
    },
    {
      id: crypto.randomUUID(),
      type: "generation-create",
      timestamp,
      body: {
        id: crypto.randomUUID(),
        traceId,
        name: span.kind,
        model: span.model,
        environment: span.environment,
        startTime: timestamp,
        endTime: span.endTime.toISOString(),
        input: span.input,
        ...(span.output === undefined ? {} : { output: span.output }),
        ...(span.tokensIn === null || span.tokensOut === null
          ? {}
          : { usageDetails: { input: span.tokensIn, output: span.tokensOut } }),
        metadata: { provider: span.provider, kind: span.kind },
        ...(failed ? { level: "ERROR", statusMessage: span.error } : {}),
      },
    },
  ];
}

/**
 * Sends each span to Langfuse Cloud with one POST to the public ingestion API
 * (no SDK: the OpenTelemetry exporter cannot report a failed export to the
 * caller). No retries; one try, then `TraceExportError`.
 *
 * Privacy: the body holds exactly what the span holds (redacted text). The
 * secret key goes only into the Authorization header and never into an error
 * or a log. Redirects are refused so the header cannot leave for another host.
 * An error carries a fixed reason (status code, timeout, network), never a
 * response body.
 */
export function createLangfuseSink(env: LangfuseEnv, options: LangfuseSinkOptions = {}): TraceSink {
  const url = ingestionUrl(env.LANGFUSE_BASE_URL);
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
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify({ batch: buildBatch(span) }),
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
      // 207 Multi-Status lists per-event errors; any error fails the export.
      try {
        const parsed: unknown = JSON.parse(text);
        const errors = (parsed as { errors?: unknown } | null)?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
          throw new TraceExportError("rejected events");
        }
      } catch (error) {
        if (error instanceof TraceExportError) throw error;
        throw new TraceExportError("unreadable response");
      }
    },
  };
}
