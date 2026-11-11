import { healthConfigSchema } from "@ai-it-support/shared";
import { describe, expect, it, vi } from "vitest";
import { createHealthConfigProvider, type EnvFlags, type SchemaProbeResult } from "./config";
import type { HelpdeskHealth } from "./helpdesk";

const flags: EnvFlags = {
  version: "1.2.3",
  pipelineTrigger: true,
  turnstile: true,
  internalApi: true,
  e2eMode: false,
  slackInteractivity: true,
};

type Probe = () => Promise<SchemaProbeResult>;

const helpdeskUp = () => Promise.resolve({ reachable: true, asleep: false });

function setup(probe: Probe, helpdesk: () => Promise<HelpdeskHealth> = helpdeskUp) {
  let time = 1_000_000;
  const provider = createHealthConfigProvider({ probe, helpdesk, flags, now: () => time });
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
        slackInteractivity: true,
        helpdeskReachable: true,
        helpdeskAsleep: false,
      },
    });
  });

  it.each([
    [{ reachable: true, asleep: false }],
    [{ reachable: false, asleep: true }],
    [{ reachable: false, asleep: false }],
  ])("reports the helpdesk flags as given: %j", async (flagsIn) => {
    const { provider } = setup(allOk, () => Promise.resolve(flagsIn));
    const body = await provider.get();
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(body.features).toMatchObject({
      helpdeskReachable: flagsIn.reachable,
      helpdeskAsleep: flagsIn.asleep,
    });
  });

  it("keeps the helpdesk flags out of the database probe cache", async () => {
    const helpdesk = vi.fn(helpdeskUp);
    const { provider } = setup(allOk, helpdesk);
    await provider.get();
    await provider.get();
    expect(helpdesk).toHaveBeenCalledTimes(2);
  });

  it("treats a rejecting helpdesk reader as both false, still a valid body, class name only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = setup(allOk, () => Promise.reject(new RangeError("marker-helpdesk-text")));
    const body = await provider.get();
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(body.features).toMatchObject({ helpdeskReachable: false, helpdeskAsleep: false });
    expect(body.features.database).toBe(true);
    expect(JSON.stringify(spy.mock.calls)).toContain("RangeError");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("marker-helpdesk-text");
    spy.mockRestore();
  });

  it("treats anything but the boolean true as false", async () => {
    const odd = { reachable: "true", asleep: 1 } as unknown as HelpdeskHealth;
    const { provider } = setup(allOk, () => Promise.resolve(odd));
    expect((await provider.get()).features).toMatchObject({
      helpdeskReachable: false,
      helpdeskAsleep: false,
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
