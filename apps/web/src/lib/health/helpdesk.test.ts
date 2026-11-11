import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ list: vi.fn(), retrieve: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ runs: { list: sdk.list, retrieve: sdk.retrieve } }));

import { CACHE_TTL_MS } from "./config";
import {
  HELPDESK_HEALTH_MAX_AGE_MS,
  createHelpdeskHealthReader,
  getHelpdeskHealth,
  type HelpdeskRunsClient,
} from "./helpdesk";

const NOW = Date.parse("2026-11-10T10:00:00.000Z");
const MIN = 60_000;
const MARK = "MARKER-HOST-dev420188.service-now.com";

type Status = "ok" | "asleep" | "down";
const output = (status: Status) => ({
  connector: "servicenow",
  status,
  checkedAt: new Date(NOW - 11 * MIN).toISOString(),
});
/** A completed run that finished `ageMs` before NOW. */
const item = (ageMs: number, extra: object = {}) => ({
  id: "run_abc123",
  createdAt: new Date(NOW - ageMs - 5_000),
  finishedAt: new Date(NOW - ageMs),
  ...extra,
});

function setup(client: Partial<HelpdeskRunsClient> = {}) {
  let time = NOW;
  const list = vi.fn<HelpdeskRunsClient["list"]>();
  const retrieve = vi.fn<HelpdeskRunsClient["retrieve"]>();
  const log = vi.fn();
  const reader = createHelpdeskHealthReader({
    client: { list, retrieve, ...client },
    now: () => time,
    log,
  });
  return {
    reader,
    list,
    retrieve,
    log,
    advance: (ms: number) => (time += ms),
    set: (t: number) => (time = t),
  };
}
/** The latest run is `ageMs` old and says `status`; the output needs runs.retrieve. */
function latest(s: ReturnType<typeof setup>, ageMs: number, status: Status) {
  s.list.mockResolvedValue({ data: [item(ageMs)] });
  s.retrieve.mockResolvedValue({ output: output(status) });
}

describe("createHelpdeskHealthReader: what the latest run says", () => {
  it("a 10 minute old ok run is reachable and not asleep", async () => {
    const s = setup();
    latest(s, 10 * MIN, "ok");
    await expect(s.reader.get()).resolves.toEqual({ reachable: true, asleep: false });
  });

  it("at most 45 minutes old counts: 45:00 is reachable, 45:00.001 is not", async () => {
    expect(HELPDESK_HEALTH_MAX_AGE_MS).toBe(45 * MIN);
    const edge = setup();
    latest(edge, 45 * MIN, "ok");
    await expect(edge.reader.get()).resolves.toEqual({ reachable: true, asleep: false });
    const over = setup();
    latest(over, 45 * MIN + 1, "ok");
    await expect(over.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
  });

  it("a 46 minute old ok run is not reachable", async () => {
    const s = setup();
    latest(s, 46 * MIN, "ok");
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
  });

  it("a fresh asleep run is asleep and not reachable", async () => {
    const s = setup();
    latest(s, 10 * MIN, "asleep");
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: true });
  });

  it("a stale asleep run says nothing: the checker may have stopped", async () => {
    const s = setup();
    latest(s, 46 * MIN, "asleep");
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
  });

  it("a fresh down run is neither", async () => {
    const s = setup();
    latest(s, 1 * MIN, "down");
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
  });

  it("no completed run gives both false, without reading an output", async () => {
    const s = setup();
    s.list.mockResolvedValue({ data: [] });
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
    expect(s.retrieve).not.toHaveBeenCalled();
    expect(s.log).not.toHaveBeenCalled();
  });

  it("the age comes from finishedAt, and from createdAt when there is none", async () => {
    const s = setup();
    s.list.mockResolvedValue({
      data: [{ id: "run_abc123", createdAt: new Date(NOW - 10 * MIN) }],
    });
    s.retrieve.mockResolvedValue({ output: output("ok") });
    await expect(s.reader.get()).resolves.toEqual({ reachable: true, asleep: false });
    const old = setup();
    old.list.mockResolvedValue({
      data: [{ id: "run_abc123", createdAt: new Date(NOW - 50 * MIN) }],
    });
    old.retrieve.mockResolvedValue({ output: output("ok") });
    await expect(old.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
  });
});

describe("createHelpdeskHealthReader: SDK requests", () => {
  it("lists the latest completed helpdesk-health run: limit 1, one hour window", async () => {
    const s = setup();
    latest(s, 1 * MIN, "ok");
    await s.reader.get();
    expect(s.list).toHaveBeenCalledTimes(1);
    expect(s.list).toHaveBeenCalledWith({
      taskIdentifier: "helpdesk-health",
      status: "COMPLETED",
      limit: 1,
      period: "1h",
    });
  });

  it("reads the output with runs.retrieve when the list item has none: one more request", async () => {
    const s = setup();
    latest(s, 1 * MIN, "ok");
    await s.reader.get();
    expect(s.retrieve).toHaveBeenCalledTimes(1);
    expect(s.retrieve).toHaveBeenCalledWith("run_abc123");
  });

  it("uses the output the list item already carries and does not retrieve", async () => {
    const s = setup();
    s.list.mockResolvedValue({ data: [item(1 * MIN, { output: output("asleep") })] });
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: true });
    expect(s.retrieve).not.toHaveBeenCalled();
  });
});

describe("createHelpdeskHealthReader: failures give false and log the class name only", () => {
  class ApiError extends Error {
    override name = "ApiError";
  }

  it("runs.list throwing", async () => {
    const s = setup();
    s.list.mockRejectedValue(new ApiError(`401 ${MARK}`));
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
    expect(s.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.log.mock.calls)).toContain("ApiError");
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(MARK);
  });

  it("runs.retrieve throwing", async () => {
    const s = setup();
    s.list.mockResolvedValue({ data: [item(1 * MIN)] });
    s.retrieve.mockRejectedValue(new TypeError(MARK));
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
    expect(JSON.stringify(s.log.mock.calls)).toContain("TypeError");
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(MARK);
  });

  it("a thrown value that is not an Error logs no text", async () => {
    const s = setup();
    s.list.mockRejectedValue(MARK);
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(MARK);
  });

  it.each(["servicenow", "builtin"])(
    "reads a fresh ok run of the %s connector",
    async (connector) => {
      const s = setup();
      s.list.mockResolvedValue({ data: [item(1 * MIN)] });
      s.retrieve.mockResolvedValue({ output: { ...output("ok"), connector } });
      await expect(s.reader.get()).resolves.toEqual({ reachable: true, asleep: false });
    },
  );

  it.each([
    ["no output", undefined],
    ["null", null],
    ["a string", MARK],
    ["another connector", { ...output("ok"), connector: "jira" }],
    ["an unknown status", { ...output("ok"), status: "up" }],
    ["an extra key", { ...output("ok"), host: MARK }],
    ["a missing time", { connector: "servicenow", status: "ok" }],
  ])("an unusable output (%s) is not reachable and not asleep", async (_name, value) => {
    const s = setup();
    s.list.mockResolvedValue({ data: [item(1 * MIN)] });
    s.retrieve.mockResolvedValue({ output: value });
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(MARK);
  });
});

describe("createHelpdeskHealthReader: 60 second cache", () => {
  it("two calls inside 60 seconds make one SDK request; one after 61 seconds makes another", async () => {
    const s = setup();
    latest(s, 1 * MIN, "ok");
    await s.reader.get();
    s.advance(5_000);
    await s.reader.get();
    expect(s.list).toHaveBeenCalledTimes(1);
    s.advance(61_000);
    await s.reader.get();
    expect(s.list).toHaveBeenCalledTimes(2);
  });

  it("is fresh at 59.999 seconds and expired at 60 seconds", async () => {
    expect(CACHE_TTL_MS).toBe(60_000);
    const s = setup();
    latest(s, 1 * MIN, "ok");
    await s.reader.get();
    s.advance(59_999);
    await s.reader.get();
    expect(s.list).toHaveBeenCalledTimes(1);
    s.advance(1);
    await s.reader.get();
    expect(s.list).toHaveBeenCalledTimes(2);
  });

  it("the age is judged on every call, not frozen in the cache", async () => {
    const s = setup();
    latest(s, 44 * MIN + 30_000, "ok");
    await expect(s.reader.get()).resolves.toEqual({ reachable: true, asleep: false });
    s.advance(59_000); // still cached, now 45 min 29 s old
    await expect(s.reader.get()).resolves.toEqual({ reachable: false, asleep: false });
    expect(s.list).toHaveBeenCalledTimes(1);
  });

  it("a failure is cached too, so a broken SDK is not hammered", async () => {
    const s = setup();
    s.list.mockRejectedValue(new Error("down"));
    await s.reader.get();
    await s.reader.get();
    expect(s.list).toHaveBeenCalledTimes(1);
    expect(s.log).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers during a miss share one request", async () => {
    const s = setup();
    latest(s, 1 * MIN, "ok");
    await Promise.all([s.reader.get(), s.reader.get(), s.reader.get()]);
    expect(s.list).toHaveBeenCalledTimes(1);
  });

  it("a clock that goes backwards counts as expired", async () => {
    const s = setup();
    latest(s, 1 * MIN, "ok");
    await s.reader.get();
    s.set(NOW - 10_000);
    await s.reader.get();
    expect(s.list).toHaveBeenCalledTimes(2);
  });
});

describe("getHelpdeskHealth (real SDK wiring)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    sdk.list.mockReset();
    sdk.retrieve.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("asks the Trigger.dev SDK, caches for 60 seconds and logs nothing on success", async () => {
    // The module-level reader keeps its cache, so every assertion lives in this one test.
    sdk.list.mockResolvedValue({ data: [item(10 * MIN)] });
    sdk.retrieve.mockResolvedValue({ output: output("ok") });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getHelpdeskHealth()).resolves.toEqual({ reachable: true, asleep: false });
    vi.advanceTimersByTime(5_000);
    await getHelpdeskHealth();
    expect(sdk.list).toHaveBeenCalledTimes(1);
    expect(sdk.list).toHaveBeenCalledWith({
      taskIdentifier: "helpdesk-health",
      status: "COMPLETED",
      limit: 1,
      period: "1h",
    });
    expect(sdk.retrieve).toHaveBeenCalledWith("run_abc123");
    expect(error).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61_000);
    await getHelpdeskHealth();
    expect(sdk.list).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
