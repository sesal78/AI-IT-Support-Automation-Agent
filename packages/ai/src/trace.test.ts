import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, createMeter, type MeterRepos } from "./meter.js";
import { TraceExportError, createAiRuntime, errorClassName, type TraceSpan } from "./trace.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
const INPUT = { messages: [{ role: "user", content: "redacted text" }] };
const usage = { tokensIn: 120, tokensOut: 30 };

function setup(
  options: {
    allowed?: boolean;
    record?: (span: TraceSpan) => Promise<void>;
    addEvent?: () => Promise<unknown>;
  } = {},
) {
  const repos = {
    reserveAiCall: vi.fn(async () => ({
      allowed: options.allowed ?? true,
      usedCalls: 1,
      callId: options.allowed === false ? null : "00000000-0000-4000-8000-0000000000aa",
    })),
    completeAiCall: vi.fn(async () => undefined),
  } satisfies MeterRepos;
  const meter = createMeter({
    repos,
    caps: { llm: 100, typesafe: 100 },
    environment: "e2e",
    alert: vi.fn(),
    logger: { error: vi.fn() },
  });
  const spans: TraceSpan[] = [];
  const sink = {
    record: vi.fn(async (span: TraceSpan) => {
      if (options.record) return options.record(span);
      spans.push(span);
    }),
  };
  const addEvent = vi.fn(options.addEvent ?? (async () => undefined));
  const logger = { error: vi.fn() };
  const runtime = createAiRuntime({ meter, sink, addEvent, environment: "e2e", logger });
  return { runtime, repos, sink, spans, addEvent, logger };
}

const meta = { provider: "llm", kind: "triage", model: "model-a", ticketId: TICKET, input: INPUT };

describe("createAiRuntime.call", () => {
  it("records one span with the same input object, ids, tokens and environment", async () => {
    const { runtime, spans } = setup();
    const result = await runtime.call(meta as never, async () => ({ ...usage, output: "answer" }));
    expect(result).toEqual({ ...usage, output: "answer" });
    expect(spans).toHaveLength(1);
    const span = spans[0] as TraceSpan;
    expect(span.input).toBe(INPUT);
    expect(span).toMatchObject({
      ticketId: TICKET,
      provider: "llm",
      kind: "triage",
      model: "model-a",
      output: "answer",
      tokensIn: 120,
      tokensOut: 30,
      environment: "e2e",
    });
    expect(span.error).toBeUndefined();
    expect(span.startTime).toBeInstanceOf(Date);
    expect(span.endTime.getTime()).toBeGreaterThanOrEqual(span.startTime.getTime());
  });

  it("records a span with the error class name when fn throws, then rethrows", async () => {
    const { runtime, spans } = setup();
    class ProviderDown extends Error {}
    const boom = new ProviderDown("secret detail in message");
    await expect(
      runtime.call(meta as never, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.error).toBe("ProviderDown");
    expect(spans[0]?.tokensIn).toBeNull();
    expect(JSON.stringify(spans[0])).not.toContain("secret detail");
  });

  it("records the type for a non-Error throw and never its content", async () => {
    const { runtime, spans } = setup();
    await expect(
      runtime.call(meta as never, async () => {
        throw "raw secret string";
      }),
    ).rejects.toBe("raw secret string");
    expect(spans[0]?.error).toBe("string");
  });

  it("records no span when the reservation is refused", async () => {
    const { runtime, sink } = setup({ allowed: false });
    const fn = vi.fn(async () => usage);
    await expect(runtime.call(meta as never, fn)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fn).not.toHaveBeenCalled();
    expect(sink.record).not.toHaveBeenCalled();
  });

  it("records no span when the reservation itself fails", async () => {
    const { runtime, repos, sink } = setup();
    repos.reserveAiCall.mockRejectedValueOnce(new Error("db down"));
    await expect(runtime.call(meta as never, async () => usage)).rejects.toThrow("db down");
    expect(sink.record).not.toHaveBeenCalled();
  });

  it("returns fn's result and adds trace_export_failed once when record rejects", async () => {
    const { runtime, addEvent } = setup({
      record: async () => {
        throw new TraceExportError("HTTP 503");
      },
    });
    const result = await runtime.call(meta as never, async () => usage);
    expect(result).toEqual(usage);
    expect(addEvent).toHaveBeenCalledTimes(1);
    expect(addEvent).toHaveBeenCalledWith(TICKET, "trace_export_failed", { kind: "triage" });
  });

  it("still rethrows fn's error when record also rejects", async () => {
    const { runtime, addEvent } = setup({
      record: async () => {
        throw new TraceExportError("timeout");
      },
    });
    const boom = new Error("x");
    await expect(
      runtime.call(meta as never, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(addEvent).toHaveBeenCalledTimes(1);
  });

  it("only logs, with the class name, when there is no ticket id", async () => {
    const { runtime, addEvent, logger } = setup({
      record: async () => {
        throw new TraceExportError("HTTP 503 key-in-message");
      },
    });
    const noTicket = { ...meta, ticketId: undefined };
    await expect(runtime.call(noTicket as never, async () => usage)).resolves.toEqual(usage);
    expect(addEvent).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("trace export failed: TraceExportError");
  });

  it("survives a failing addEvent", async () => {
    const { runtime, logger } = setup({
      record: async () => {
        throw new Error("x");
      },
      addEvent: async () => {
        throw new Error("db");
      },
    });
    await expect(runtime.call(meta as never, async () => usage)).resolves.toEqual(usage);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent calls apart: one span each, with its own input", async () => {
    const { runtime, spans } = setup();
    const inputs = [1, 2, 3, 4, 5].map((n) => ({ n }));
    await Promise.all(
      inputs.map((input, i) =>
        runtime
          .call({ ...meta, input } as never, async () => {
            await new Promise((r) => setTimeout(r, 5 - i));
            if (i === 2) throw new Error("x");
            return usage;
          })
          .catch(() => undefined),
      ),
    );
    expect(spans).toHaveLength(5);
    expect(new Set(spans.map((s) => s.input))).toEqual(new Set(inputs));
    expect(spans.filter((s) => s.error !== undefined)).toHaveLength(1);
  });
});

describe("errorClassName", () => {
  it("never returns a message or an odd name", () => {
    const odd = new Error("m");
    Object.defineProperty(odd, "constructor", { value: { name: "has space and secret" } });
    odd.name = "also bad name!";
    expect(errorClassName(odd)).toBe("Error");
    expect(errorClassName(42)).toBe("number");
    expect(errorClassName(null)).toBe("object");
  });
});
