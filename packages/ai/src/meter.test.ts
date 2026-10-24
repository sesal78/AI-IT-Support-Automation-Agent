import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, alertThreshold, createMeter, type MeterRepos } from "./meter.js";

const CALL_ID = "00000000-0000-4000-8000-0000000000aa";
const TICKET = "00000000-0000-4000-8000-000000000001";
const usage = { tokensIn: 120, tokensOut: 30 };

interface Setup {
  order: string[];
  repos: { reserveAiCall: ReturnType<typeof vi.fn>; completeAiCall: ReturnType<typeof vi.fn> };
  alert: ReturnType<typeof vi.fn>;
  logger: { error: ReturnType<typeof vi.fn> };
  meter: ReturnType<typeof createMeter>;
}

function setup(
  options: {
    usedCalls?: number;
    allowed?: boolean;
    reserve?: () => Promise<unknown>;
    complete?: () => Promise<unknown>;
    alert?: () => unknown;
  } = {},
): Setup {
  const order: string[] = [];
  const { usedCalls = 5, allowed = true } = options;
  const repos = {
    reserveAiCall: vi.fn(async () => {
      if (options.reserve) return options.reserve();
      await Promise.resolve();
      order.push("reserve");
      return { allowed, usedCalls, callId: allowed ? CALL_ID : null };
    }),
    completeAiCall: vi.fn(async () => {
      order.push("complete");
      if (options.complete) return options.complete();
      return undefined;
    }),
  };
  const alert = vi.fn(options.alert ?? (async () => undefined));
  const logger = { error: vi.fn() };
  const meter = createMeter({
    repos: repos as unknown as MeterRepos,
    caps: { llm: 2000, typesafe: 20000 },
    environment: "test",
    alert: alert as never,
    logger,
  });
  return { order, repos, alert, logger, meter };
}

const llm = { provider: "llm", kind: "triage", ticketId: TICKET } as const;

describe("meter.run ordering and results", () => {
  it("reserves before fn starts, completes with the tokens after fn resolves, returns the result", async () => {
    const s = setup();
    const result = { text: "ok", ...usage };
    const value = await s.meter.run(llm, async () => {
      s.order.push("fn");
      return result;
    });
    expect(value).toBe(result);
    expect(s.order).toEqual(["reserve", "fn", "complete"]);
    expect(s.repos.completeAiCall).toHaveBeenCalledWith(CALL_ID, usage);
  });

  it("passes provider, kind, ticket, environment and the env cap to the reservation", async () => {
    const s = setup();
    await s.meter.run({ provider: "typesafe", kind: "sensitive" }, async () => usage);
    expect(s.repos.reserveAiCall).toHaveBeenCalledWith({
      provider: "typesafe",
      kind: "sensitive",
      calls: 1,
      capCalls: 20000,
      environment: "test",
      ticketId: undefined,
    });
  });
});

describe("meter.run refusal and failures (fail closed)", () => {
  it("throws BudgetExceededError with the provider and never runs fn when refused", async () => {
    const s = setup({ allowed: false, usedCalls: 2000 });
    const fn = vi.fn(async () => usage);
    const error = await s.meter.run(llm, fn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).provider).toBe("llm");
    expect((error as Error).message).toContain("llm");
    expect(fn).not.toHaveBeenCalled();
    expect(s.repos.completeAiCall).not.toHaveBeenCalled();
    expect(s.alert).not.toHaveBeenCalled();
  });

  it("treats an allowed reservation without a call id as a refusal", async () => {
    const s = setup({ reserve: async () => ({ allowed: true, usedCalls: 1, callId: null }) });
    const fn = vi.fn(async () => usage);
    await expect(s.meter.run(llm, fn)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("rethrows fn's error, skips completeAiCall and does not log the message", async () => {
    const s = setup();
    const marker = "marker".repeat(3);
    const failure = new Error(`upstream ${marker}`);
    await expect(
      s.meter.run(llm, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(s.repos.completeAiCall).not.toHaveBeenCalled();
    expect(JSON.stringify(s.logger.error.mock.calls)).not.toContain(marker);
  });

  it("rethrows the reservation error and never runs fn", async () => {
    const failure = new Error("db down");
    const s = setup({
      reserve: async () => {
        throw failure;
      },
    });
    const fn = vi.fn(async () => usage);
    await expect(s.meter.run(llm, fn)).rejects.toBe(failure);
    expect(fn).not.toHaveBeenCalled();
    expect(s.repos.completeAiCall).not.toHaveBeenCalled();
  });

  it("returns the result and logs the class name when completeAiCall fails", async () => {
    class DbError extends Error {
      override name = "DbError";
    }
    const marker = "marker".repeat(3);
    const s = setup({
      complete: async () => {
        throw new DbError(`row ${marker}`);
      },
    });
    const result = { ...usage };
    await expect(s.meter.run(llm, async () => result)).resolves.toBe(result);
    expect(s.logger.error).toHaveBeenCalledTimes(1);
    const line = String(s.logger.error.mock.calls[0]?.[0]);
    expect(line).toContain("DbError");
    expect(line).not.toContain(marker);
  });

  it.each([
    ["negative", { tokensIn: -1, tokensOut: 0 }],
    ["NaN", { tokensIn: 0, tokensOut: Number.NaN }],
    ["fractional", { tokensIn: 1.5, tokensOut: 0 }],
    ["Infinity", { tokensIn: Number.POSITIVE_INFINITY, tokensOut: 0 }],
    ["missing", {} as never],
    ["strings", { tokensIn: "5", tokensOut: "5" } as never],
  ])("returns the result without writing %s token counts", async (_name, bad) => {
    const s = setup();
    await expect(s.meter.run(llm, async () => bad)).resolves.toBe(bad);
    expect(s.repos.completeAiCall).not.toHaveBeenCalled();
    expect(s.logger.error).toHaveBeenCalledTimes(1);
  });

  it("does not add client-side serialisation: concurrent runs each reserve and complete", async () => {
    const s = setup();
    await Promise.all(Array.from({ length: 5 }, () => s.meter.run(llm, async () => usage)));
    expect(s.repos.reserveAiCall).toHaveBeenCalledTimes(5);
    expect(s.repos.completeAiCall).toHaveBeenCalledTimes(5);
  });
});

describe("caps and calls", () => {
  it("capOverride 0 is sent to the reservation (refusing the call) although the env cap is 2000", async () => {
    const s = setup({ allowed: false });
    await expect(s.meter.run({ ...llm, capOverride: 0 }, async () => usage)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    expect(s.repos.reserveAiCall.mock.calls[0]?.[0]).toMatchObject({ capCalls: 0 });
  });

  it("uses the env cap of the provider with no override", async () => {
    const s = setup();
    await s.meter.run(llm, async () => usage);
    expect(s.repos.reserveAiCall.mock.calls[0]?.[0]).toMatchObject({ capCalls: 2000 });
  });

  it("reserves calls: 7, defaulting to 1", async () => {
    const s = setup();
    await s.meter.run({ ...llm, calls: 7 }, async () => usage);
    await s.meter.run(llm, async () => usage);
    expect(s.repos.reserveAiCall.mock.calls[0]?.[0]).toMatchObject({ calls: 7 });
    expect(s.repos.reserveAiCall.mock.calls[1]?.[0]).toMatchObject({ calls: 1 });
  });

  it.each([
    ["calls 0", { calls: 0 }],
    ["calls 1.5", { calls: 1.5 }],
    ["calls -1", { calls: -1 }],
    ["calls NaN", { calls: Number.NaN }],
    ["calls huge", { calls: 2 ** 40 }],
    ["calls Infinity", { calls: Number.POSITIVE_INFINITY }],
    ["capOverride -1", { capOverride: -1 }],
    ["capOverride 1.5", { capOverride: 1.5 }],
    ["capOverride NaN", { capOverride: Number.NaN }],
    ["provider other", { provider: "other" }],
  ])("throws TypeError for %s without reserving or running fn", async (_name, patch) => {
    const s = setup();
    const fn = vi.fn(async () => usage);
    await expect(s.meter.run({ ...llm, ...patch } as never, fn)).rejects.toThrow(TypeError);
    expect(s.repos.reserveAiCall).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Number.NaN, 2 ** 31])("rejects the cap %s at creation", (bad) => {
    expect(() =>
      createMeter({
        repos: {} as MeterRepos,
        caps: { llm: bad, typesafe: 1 },
        environment: "test",
        alert: vi.fn() as never,
      }),
    ).toThrow(TypeError);
  });
});

describe("80 % alert", () => {
  it("computes ceil(0.8 * cap) exactly", () => {
    expect([0, 1, 2, 5, 2000, 20000].map(alertThreshold)).toEqual([0, 1, 2, 4, 1600, 16000]);
  });

  it("alerts llm_cap_80 once when used reaches 1600 of 2000", async () => {
    const s = setup({ usedCalls: 1600 });
    await s.meter.run(llm, async () => usage);
    expect(s.alert).toHaveBeenCalledTimes(1);
    expect(s.alert).toHaveBeenCalledWith("llm_cap_80", { ticketId: TICKET });
  });

  it("does not alert at 1599", async () => {
    const s = setup({ usedCalls: 1599 });
    await s.meter.run(llm, async () => usage);
    expect(s.alert).not.toHaveBeenCalled();
  });

  it("does not alert again above the threshold, only on the crossing", async () => {
    const s = setup({ usedCalls: 1601 });
    await s.meter.run(llm, async () => usage);
    expect(s.alert).not.toHaveBeenCalled();
  });

  it("alerts when a multi-call reservation jumps over the threshold", async () => {
    const s = setup({ usedCalls: 1603 });
    await s.meter.run({ ...llm, calls: 5 }, async () => usage);
    expect(s.alert).toHaveBeenCalledTimes(1);
  });

  it("alerts typesafe_cap_80 for TypeSafe at 16000 of 20000, without a ticket id argument", async () => {
    const s = setup({ usedCalls: 16000 });
    await s.meter.run({ provider: "typesafe", kind: "sensitive" }, async () => usage);
    expect(s.alert).toHaveBeenCalledTimes(1);
    expect(s.alert).toHaveBeenCalledWith("typesafe_cap_80");
  });

  it("computes the threshold from capOverride", async () => {
    const s = setup({ usedCalls: 8 });
    await s.meter.run({ ...llm, capOverride: 10 }, async () => usage);
    expect(s.alert).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("alert down");
      },
    ],
    ["rejects", () => Promise.reject(new Error("alert down"))],
  ])("never fails or blocks the AI call when the alert %s", async (_name, alert) => {
    const s = setup({ usedCalls: 1700, alert });
    const result = { ...usage };
    await expect(s.meter.run(llm, async () => result)).resolves.toBe(result);
    expect(s.repos.completeAiCall).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a hanging alert", async () => {
    const s = setup({ usedCalls: 1700, alert: () => new Promise(() => undefined) });
    await expect(s.meter.run(llm, async () => usage)).resolves.toEqual(usage);
  });
});

describe("import boundary", () => {
  it("packages/ai does not import or depend on packages/db", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources).toContain("meter.ts");
    for (const file of sources) {
      expect(readFileSync(resolve(dir, file), "utf8"), file).not.toMatch(/@ai-it-support\/db/);
    }
    const pkg = readFileSync(resolve(dir, "../package.json"), "utf8");
    expect(pkg).not.toMatch(/@ai-it-support\/db/);
  });
});
