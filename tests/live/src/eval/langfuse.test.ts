import { describe, expect, it } from "vitest";
import {
  LANGFUSE_MAX_TRIES,
  LANGFUSE_PACE_MS,
  LangfuseRequestError,
  recordDatasetRun,
  retryWaitMs,
  type DatasetRunItem,
} from "./langfuse.ts";

const CONFIG = { publicKey: "pk", secretKey: "sk", baseUrl: "https://langfuse.example.test" };
const ITEMS_PATH = "/api/public/dataset-items";

function item(evalId: string): DatasetRunItem {
  return { evalId, set: "normal", expected: {}, ticketId: null, output: {} };
}

/**
 * A fake clock (sleep only moves `now`) and a fake Langfuse: the dataset
 * exists, and `items` answers each dataset-item request in turn.
 */
function setup(items: Array<{ status: number; retryAfter?: string }> = []) {
  let now = 1_000_000;
  const sleeps: number[] = [];
  const starts: Array<{ path: string; at: number }> = [];
  const queue = [...items];
  const fetch = async (input: URL): Promise<Response> => {
    starts.push({ path: input.pathname, at: now });
    if (input.pathname !== ITEMS_PATH) {
      return new Response(JSON.stringify({ id: "ds_1" }), { status: 200 });
    }
    const next = queue.shift() ?? { status: 200 };
    const headers = next.retryAfter === undefined ? undefined : { "retry-after": next.retryAfter };
    return new Response(JSON.stringify({}), { status: next.status, headers });
  };
  const options = {
    fetch,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  const itemStarts = () => starts.filter((s) => s.path === ITEMS_PATH);
  return { options, sleeps, starts, itemStarts };
}

describe("recordDatasetRun retries and pacing (P3-T10m)", () => {
  it("honours Retry-After in seconds on a 429, then succeeds", async () => {
    const h = setup([{ status: 429, retryAfter: "3" }, { status: 200 }]);
    const result = await recordDatasetRun(CONFIG, "r1", [item("E001")], h.options);
    expect(result.items).toBe(1);
    expect(h.itemStarts()).toHaveLength(2);
    expect(h.itemStarts()[1]!.at - h.itemStarts()[0]!.at).toBe(3_000);
  });

  it("honours Retry-After as an HTTP date", async () => {
    const h = setup();
    const at = new Date(h.options.now() + 7_000).toUTCString();
    // toUTCString drops the milliseconds, so the wait is 6 to 7 s.
    const wait = retryWaitMs(at, 1, h.options.now());
    expect(wait).toBeGreaterThan(6_000);
    expect(wait).toBeLessThanOrEqual(7_000);
  });

  it("caps a long Retry-After at 30 s and never waits below 0", () => {
    expect(retryWaitMs("120", 1, 0)).toBe(30_000);
    expect(retryWaitMs(new Date(0).toUTCString(), 1, 60_000)).toBe(0);
  });

  it("backs off 1, 2, 4, 8 s without Retry-After and fails loudly after 5 tries", async () => {
    const h = setup(Array.from({ length: 5 }, () => ({ status: 429 })));
    const error = await recordDatasetRun(CONFIG, "r1", [item("E001")], h.options).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LangfuseRequestError);
    expect((error as Error).message).toBe(
      "POST /api/public/dataset-items: status 429 after 5 tries",
    );
    expect(h.itemStarts()).toHaveLength(LANGFUSE_MAX_TRIES);
    const gaps = h
      .itemStarts()
      .slice(1)
      .map((s, i) => s.at - h.itemStarts()[i]!.at);
    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("retries a 5xx the same way", async () => {
    const h = setup([{ status: 503 }, { status: 502 }, { status: 200 }]);
    await recordDatasetRun(CONFIG, "r1", [item("E001")], h.options);
    expect(h.itemStarts()).toHaveLength(3);
  });

  it("does not retry another 4xx", async () => {
    const h = setup([{ status: 400 }]);
    await expect(recordDatasetRun(CONFIG, "r1", [item("E001")], h.options)).rejects.toThrow(
      "POST /api/public/dataset-items: status 400",
    );
    expect(h.itemStarts()).toHaveLength(1);
    expect(h.sleeps).toEqual([LANGFUSE_PACE_MS]);
  });

  it("starts requests at least the pace apart", async () => {
    const h = setup();
    await recordDatasetRun(CONFIG, "r1", [item("E001"), item("E002"), item("E003")], h.options);
    // The dataset lookup, then 3 items.
    expect(h.starts).toHaveLength(4);
    const gaps = h.starts.slice(1).map((s, i) => s.at - h.starts[i]!.at);
    expect(gaps).toEqual([LANGFUSE_PACE_MS, LANGFUSE_PACE_MS, LANGFUSE_PACE_MS]);
  });
});
