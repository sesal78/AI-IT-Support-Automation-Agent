import { healthConfigSchema } from "@ai-it-support/shared";
import { describe, expect, it, vi } from "vitest";
import { createHealthConfigProvider, type EnvFlags, type SchemaProbeResult } from "./config";

const flags: EnvFlags = {
  version: "1.2.3",
  pipelineTrigger: true,
  turnstile: true,
  internalApi: true,
  e2eMode: false,
};

type Probe = () => Promise<SchemaProbeResult>;

function setup(probe: Probe) {
  let time = 1_000_000;
  const provider = createHealthConfigProvider({ probe, flags, now: () => time });
  return { provider, advance: (ms: number) => (time += ms), set: (t: number) => (time = t) };
}
const allOk: Probe = () =>
  Promise.resolve({ database: true, migration0003: true, migration0005: true });

describe("createHealthConfigProvider", () => {
  it("combines the probe with the env flags", async () => {
    const { provider } = setup(allOk);
    expect(healthConfigSchema.parse(await provider.get())).toEqual({
      version: "1.2.3",
      features: {
        database: true,
        migration0003: true,
        migration0005: true,
        pipelineTrigger: true,
        turnstile: true,
        internalApi: true,
        e2eMode: false,
      },
    });
  });

  it("reports probe results as given", async () => {
    const { provider } = setup(() =>
      Promise.resolve({ database: true, migration0003: false, migration0005: true }),
    );
    const body = await provider.get();
    expect(body.features.database).toBe(true);
    expect(body.features.migration0003).toBe(false);
  });

  it("calls the probe once for ten requests inside 60 seconds, again after 61", async () => {
    const probe = vi.fn(allOk);
    const { provider, advance } = setup(probe);
    for (let i = 0; i < 10; i++) {
      await provider.get();
      advance(5_000);
    }
    expect(probe).toHaveBeenCalledTimes(1);
    advance(61_000);
    await provider.get();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("serves from the cache at 59.999 seconds and refreshes at 60", async () => {
    const probe = vi.fn(allOk);
    const { provider, advance } = setup(probe);
    await provider.get();
    advance(59_999);
    await provider.get();
    expect(probe).toHaveBeenCalledTimes(1);
    advance(1);
    await provider.get();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe between concurrent requests", async () => {
    let release: (value: SchemaProbeResult) => void = () => {};
    const probe = vi.fn<Probe>(() => new Promise((resolve) => (release = resolve)));
    const { provider } = setup(probe);
    const all = Promise.all([provider.get(), provider.get(), provider.get()]);
    release({ database: true, migration0003: true, migration0005: true });
    const bodies = await all;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toEqual(bodies[2]);
  });

  it("treats a rejecting probe as false and caches that for 60 seconds", async () => {
    const probe = vi.fn<Probe>(() => Promise.reject(new Error("db said marker-secret-text")));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider, advance } = setup(probe);
    const body = await provider.get();
    expect(body.features.database).toBe(false);
    expect(body.features.migration0003).toBe(false);
    advance(30_000);
    await provider.get();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("marker-secret-text");
    spy.mockRestore();
  });

  it("treats a synchronously throwing probe as false", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = setup(() => {
      throw new TypeError("marker-sync-text");
    });
    const body = await provider.get();
    expect(body.features.database).toBe(false);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("marker-sync-text");
    spy.mockRestore();
  });

  it("refreshes when the clock goes backwards", async () => {
    const probe = vi.fn(allOk);
    const { provider, set } = setup(probe);
    await provider.get();
    set(10);
    await provider.get();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("recovers in the next window after a failed probe", async () => {
    const probe = vi
      .fn<Probe>()
      .mockResolvedValueOnce({ database: false, migration0003: false, migration0005: false })
      .mockResolvedValueOnce({ database: true, migration0003: true, migration0005: true });
    const { provider, advance } = setup(probe);
    expect((await provider.get()).features.database).toBe(false);
    advance(60_000);
    expect((await provider.get()).features.database).toBe(true);
  });
});
