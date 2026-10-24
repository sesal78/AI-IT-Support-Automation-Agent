import { delay, HttpResponse } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEgressRecorder } from "../../shared/test-support/egress-recorder.js";
import { LANGFUSE_TIMEOUT_MS, createLangfuseSink, type LangfuseEnv } from "./langfuse-sink.js";
import { TraceExportError, type TraceSpan } from "./trace.js";

const HOST = "https://langfuse.test.invalid";
const PUBLIC_KEY = "pk-".concat("a".repeat(8));
const SECRET_KEY = "sk-".concat("b".repeat(8));
const env: LangfuseEnv = {
  LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
  LANGFUSE_SECRET_KEY: SECRET_KEY,
  LANGFUSE_BASE_URL: HOST,
};
const TICKET = "00000000-0000-4000-8000-000000000001";
const span: TraceSpan = {
  ticketId: TICKET,
  provider: "llm",
  kind: "triage",
  model: "model-a",
  input: { messages: [{ role: "user", content: "redacted text" }] },
  output: "answer",
  tokensIn: 1234,
  tokensOut: 567,
  startTime: new Date("2026-10-08T10:00:00Z"),
  endTime: new Date("2026-10-08T10:00:01Z"),
  environment: "e2e",
};

const egress = createEgressRecorder();
beforeAll(() => egress.start());
afterAll(() => egress.stop());
beforeEach(() => {
  egress.reset();
  egress.mock(HOST, () => HttpResponse.json({}));
});

const TRACES_PATH = "/api/public/otel/v1/traces";

type OtlpSpan = {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } }[];
  status: { code: number; message?: string };
};

/** The single span of the request at `index`, plus its attributes as a map. */
function sentSpan(index = 0): { span: OtlpSpan; attrs: Record<string, string> } {
  const body = JSON.parse(egress.requests()[index]?.body ?? "") as {
    resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
  };
  expect(body.resourceSpans).toHaveLength(1);
  expect(body.resourceSpans[0]?.scopeSpans).toHaveLength(1);
  const spans = body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  expect(spans).toHaveLength(1);
  const span = spans[0] as OtlpSpan;
  const attrs: Record<string, string> = {};
  for (const { key, value } of span.attributes) attrs[key] = value.stringValue;
  return { span, attrs };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("createLangfuseSink", () => {
  it("posts to the OTLP traces endpoint with the ticket, model, tokens and environment", async () => {
    await createLangfuseSink(env).record(span);
    const requests = egress.requests();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: TRACES_PATH });
    const bodies = requests.map((r) => r.body).join("\n");
    for (const part of [TICKET, "model-a", "1234", "567", "e2e", "langfuse.session.id"]) {
      expect(bodies).toContain(part);
    }
    egress.assertClean();
  });

  it("sends Basic auth built from the two keys", async () => {
    let auth: string | null = null;
    egress.mock(HOST, ({ request }) => {
      auth = request.headers.get("authorization");
      return HttpResponse.json({});
    });
    await createLangfuseSink(env).record(span);
    expect(auth).toBe(`Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`);
  });

  it("never puts the secret key into a body", async () => {
    await createLangfuseSink(env).record(span);
    for (const request of egress.requests()) expect(request.body).not.toContain(SECRET_KEY);
    egress.assertClean();
  });

  it("marks a failed call with level ERROR and the class name", async () => {
    await createLangfuseSink(env).record({
      ...span,
      error: "ProviderDown",
      tokensIn: null,
      tokensOut: null,
    });
    const body = egress
      .requests()
      .map((r) => r.body)
      .join("\n");
    expect(body).toContain('{"key":"langfuse.observation.level","value":{"stringValue":"ERROR"}}');
    expect(body).toContain("ProviderDown");
    const { span: sent, attrs } = sentSpan();
    expect(attrs["langfuse.observation.level"]).toBe("ERROR");
    expect(attrs["langfuse.observation.status_message"]).toBe("ProviderDown");
    expect(sent.status).toEqual({ code: 2, message: "ProviderDown" });
    expect(attrs).not.toHaveProperty("langfuse.observation.usage_details");
  });

  it("omits the session id when there is no ticket", async () => {
    await createLangfuseSink(env).record({ ...span, ticketId: undefined });
    expect(egress.requests()[0]?.body).not.toContain("langfuse.session.id");
    expect(egress.requests()[0]?.body).not.toContain("session.id");
  });

  it("sends one OTLP JSON span with the Langfuse attribute names", async () => {
    await createLangfuseSink(env).record(span);
    expect(egress.requests()).toHaveLength(1);
    const request = egress.requests()[0];
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["x-langfuse-ingestion-version"]).toBe("4");
    const { span: sent, attrs } = sentSpan();
    expect(sent.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(sent.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(sent.traceId).not.toBe("0".repeat(32));
    expect(sent.name).toBe("triage");
    expect(sent.startTimeUnixNano).toBe(String(span.startTime.getTime()).concat("000000"));
    expect(sent.endTimeUnixNano).toBe(String(span.endTime.getTime()).concat("000000"));
    expect(sent.status).toEqual({ code: 1 });
    expect(attrs).toEqual({
      "langfuse.observation.type": "generation",
      "langfuse.trace.name": "triage",
      "langfuse.session.id": TICKET,
      "langfuse.environment": "e2e",
      "langfuse.observation.model.name": "model-a",
      "langfuse.observation.input": JSON.stringify(span.input),
      "langfuse.observation.output": "answer",
      "langfuse.observation.usage_details": '{"input":1234,"output":567}',
      "langfuse.observation.metadata.provider": "llm",
      "langfuse.observation.metadata.kind": "triage",
    });
  });

  it("gives each export its own trace and span id", async () => {
    const sink = createLangfuseSink(env);
    await sink.record(span);
    await sink.record(span);
    expect(sentSpan(0).span.traceId).not.toBe(sentSpan(1).span.traceId);
    expect(sentSpan(0).span.spanId).not.toBe(sentSpan(1).span.spanId);
  });

  it("carries the staging environment", async () => {
    await createLangfuseSink(env).record({ ...span, environment: "staging" });
    expect(sentSpan().attrs["langfuse.environment"]).toBe("staging");
  });

  it.each([401, 403, 503])(
    "rejects with TraceExportError on HTTP %i without any key or body text in the error",
    async (status) => {
      egress.mock(HOST, () => new HttpResponse(`echo ${SECRET_KEY} ${PUBLIC_KEY}`, { status }));
      const error = await rejection(createLangfuseSink(env).record(span));
      expect(error).toBeInstanceOf(TraceExportError);
      const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
      expect(text).toContain(`HTTP ${status}`);
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain(PUBLIC_KEY);
    },
  );

  it("rejects with TraceExportError when the connection is refused", async () => {
    egress.mock(HOST, () => HttpResponse.error());
    const started = Date.now();
    const error = await rejection(createLangfuseSink(env).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects with TraceExportError on a DNS-style failure from fetch", async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: new Error(`getaddrinfo ENOTFOUND ${SECRET_KEY}`),
      });
    }) as typeof fetch;
    const error = await rejection(createLangfuseSink(env, { fetch: failing }).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
    expect(JSON.stringify(error)).not.toContain(SECRET_KEY);
    expect((error as Error).message).not.toContain(SECRET_KEY);
  });

  it("times out below 5 seconds by default", () => {
    expect(LANGFUSE_TIMEOUT_MS).toBeLessThan(5000);
  });

  it("rejects with TraceExportError when the host is slow", async () => {
    egress.mock(HOST, async () => {
      await delay(2000);
      return HttpResponse.json({});
    });
    const started = Date.now();
    const error = await rejection(createLangfuseSink(env, { timeoutMs: 100 }).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
    expect((error as Error).message).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("rejects when a 2xx response body is huge", async () => {
    egress.mock(HOST, () => new HttpResponse("x".repeat(5 * 1024 * 1024), { status: 200 }));
    const error = await rejection(createLangfuseSink(env).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
    expect((error as Error).message).toContain("too large");
  });

  it("rejects on a huge error body without reading it", async () => {
    egress.mock(HOST, () => new HttpResponse("x".repeat(5 * 1024 * 1024), { status: 503 }));
    const error = await rejection(createLangfuseSink(env).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
  });

  it.each([["1"], [1]])(
    "rejects when Langfuse reports a partial success with rejectedSpans %j",
    async (rejectedSpans) => {
      egress.mock(HOST, () =>
        HttpResponse.json({
          partialSuccess: { rejectedSpans, errorMessage: `echo ${SECRET_KEY}` },
        }),
      );
      const error = await rejection(createLangfuseSink(env).record(span));
      expect(error).toBeInstanceOf(TraceExportError);
      expect((error as Error).message).toContain("rejected spans");
      expect((error as Error).message).not.toContain(SECRET_KEY);
    },
  );

  it("accepts a partial success that only carries a warning", async () => {
    egress.mock(HOST, () =>
      HttpResponse.json({ partialSuccess: { rejectedSpans: "0", errorMessage: "warning" } }),
    );
    await expect(createLangfuseSink(env).record(span)).resolves.toBeUndefined();
  });

  it("accepts an empty export response", async () => {
    egress.mock(HOST, () => new HttpResponse("", { status: 200 }));
    await expect(createLangfuseSink(env).record(span)).resolves.toBeUndefined();
  });

  it.each([
    ['{"partialSuccess":{"rejectedSpans":"many"}}'],
    ['{"partialSuccess":"x"}'],
    ["[]"],
    ["null"],
  ])("rejects on a malformed export response %s", async (text) => {
    egress.mock(HOST, () => new HttpResponse(text, { status: 200 }));
    const error = await rejection(createLangfuseSink(env).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
    expect((error as Error).message).toContain("unreadable response");
  });

  it("rejects on an unreadable 2xx body", async () => {
    egress.mock(HOST, () => new HttpResponse("not json", { status: 200 }));
    expect(await rejection(createLangfuseSink(env).record(span))).toBeInstanceOf(TraceExportError);
  });

  it("refuses redirects so the key cannot be forwarded", async () => {
    egress.mock(HOST, () =>
      HttpResponse.text("", { status: 307, headers: { location: "https://other.test.invalid/x" } }),
    );
    expect(await rejection(createLangfuseSink(env).record(span))).toBeInstanceOf(TraceExportError);
    expect(egress.requests().every((r) => r.host === "langfuse.test.invalid")).toBe(true);
  });

  it("forceDown rejects with TraceExportError and sends no request", async () => {
    const error = await rejection(createLangfuseSink(env, { forceDown: true }).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
    expect(egress.requests()).toHaveLength(0);
  });

  it("handles concurrent records", async () => {
    const sink = createLangfuseSink(env);
    await Promise.all([1, 2, 3, 4].map(() => sink.record(span)));
    expect(egress.requests().length).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ["http://langfuse.test.invalid", /https/],
    ["not a url", /URL/],
    ["https://user:pw@langfuse.test.invalid", /credentials/],
  ])("refuses to build a sink for base URL %s", (url, pattern) => {
    expect(() => createLangfuseSink({ ...env, LANGFUSE_BASE_URL: url })).toThrow(pattern);
  });
});
