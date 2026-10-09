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
  egress.mock(HOST, () => HttpResponse.json({ successes: [{}, {}], errors: [] }, { status: 207 }));
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("createLangfuseSink", () => {
  it("posts to the ingestion API with the ticket, model, tokens and environment", async () => {
    await createLangfuseSink(env).record(span);
    const requests = egress.requests();
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0]).toMatchObject({ method: "POST", path: "/api/public/ingestion" });
    const bodies = requests.map((r) => r.body).join("\n");
    for (const part of [TICKET, "model-a", "1234", "567", "e2e", "sessionId"]) {
      expect(bodies).toContain(part);
    }
    egress.assertClean();
  });

  it("sends Basic auth built from the two keys", async () => {
    let auth: string | null = null;
    egress.mock(HOST, ({ request }) => {
      auth = request.headers.get("authorization");
      return HttpResponse.json({ successes: [], errors: [] }, { status: 207 });
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
    expect(body).toContain('"level":"ERROR"');
    expect(body).toContain("ProviderDown");
  });

  it("omits sessionId when there is no ticket", async () => {
    await createLangfuseSink(env).record({ ...span, ticketId: undefined });
    expect(egress.requests()[0]?.body).not.toContain("sessionId");
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
    egress.mock(HOST, () => new HttpResponse("x".repeat(5 * 1024 * 1024), { status: 207 }));
    const error = await rejection(createLangfuseSink(env).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
    expect((error as Error).message).toContain("too large");
  });

  it("rejects on a huge error body without reading it", async () => {
    egress.mock(HOST, () => new HttpResponse("x".repeat(5 * 1024 * 1024), { status: 503 }));
    const error = await rejection(createLangfuseSink(env).record(span));
    expect(error).toBeInstanceOf(TraceExportError);
  });

  it("rejects when Langfuse reports per-event errors in a 207", async () => {
    egress.mock(HOST, () =>
      HttpResponse.json({ successes: [], errors: [{ id: "x", status: 400 }] }, { status: 207 }),
    );
    expect(await rejection(createLangfuseSink(env).record(span))).toBeInstanceOf(TraceExportError);
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
