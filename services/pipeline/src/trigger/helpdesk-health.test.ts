import { readFileSync } from "node:fs";
import { createAlertSink, type AlertFn, type AlertKind } from "@ai-it-support/ai";
import {
  FakeConnector,
  ServiceNowConnector,
  createServiceNowClient,
  type HelpdeskConnector,
} from "@ai-it-support/helpdesk";
import { HELPDESK_HEALTH_TASK_ID, helpdeskHealthOutputSchema } from "@ai-it-support/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEgressRecorder } from "../../../../packages/shared/test-support/egress-recorder.js";
import {
  createHelpdeskHealthDeps,
  helpdeskHealthOptions,
  runHelpdeskHealth,
  runHelpdeskHealthTask,
  type HelpdeskHealthDeps,
} from "./helpdesk-health.js";

const ORIGIN = "https://itsupport-test.service-now.com";
const PASSWORD = ["Mark", "er", "Pw", "-0123456789"].join(""); // built from pieces for gitleaks
// The real hibernation sample the P5-T3a connector tests use.
const HIBERNATING = readFileSync(
  new URL(
    "../../../../packages/helpdesk/test/fixtures/servicenow-hibernating.html",
    import.meta.url,
  ),
  "utf8",
);
const NOW = Date.parse("2026-11-10T10:00:00.000Z");

let reply: "ok" | "asleep" | "503" = "ok";
const recorder = createEgressRecorder();
beforeAll(() => {
  recorder.start();
  recorder.mock(ORIGIN, () => {
    if (reply === "asleep") {
      return new Response(HIBERNATING, { headers: { "content-type": "text/html" } });
    }
    if (reply === "503") return new Response("", { status: 503 });
    return Response.json({ result: [{ sys_id: "a".repeat(32) }] });
  });
});
afterAll(() => recorder.stop());
beforeEach(() => {
  recorder.reset();
  reply = "ok";
});

const serviceNow = () =>
  new ServiceNowConnector({
    client: createServiceNowClient({
      instanceUrl: ORIGIN,
      username: "svc.itsupport",
      password: PASSWORD,
    }),
    defaultCaller: "d".repeat(32),
  });

function setup(over: Partial<HelpdeskHealthDeps> = {}) {
  const alert = vi.fn<AlertFn>(async () => {});
  const error = vi.fn();
  const deps: HelpdeskHealthDeps = {
    createConnector: serviceNow,
    now: () => NOW,
    alert,
    logger: { error },
    ...over,
  };
  return { deps, alert, error };
}

describe("runHelpdeskHealth", () => {
  it("ok: output status ok with the check time, no alert", async () => {
    const { deps, alert } = setup();
    const out = await runHelpdeskHealth(deps);
    expect(out).toEqual({
      connector: "servicenow",
      status: "ok",
      checkedAt: "2026-11-10T10:00:00.000Z",
    });
    expect(helpdeskHealthOutputSchema.safeParse(out).success).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    expect(recorder.requests()).toHaveLength(1);
  });

  it("the real hibernation sample: asleep and one alert:helpdesk_asleep", async () => {
    reply = "asleep";
    const { deps, alert } = setup();
    const out = await runHelpdeskHealth(deps);
    expect(out.status).toBe("asleep");
    expect(alert.mock.calls).toEqual([["helpdesk_asleep"]]);
    expect(recorder.requests()).toHaveLength(1);
  });

  it("a 503 is down with one alert:helpdesk_down, never asleep", async () => {
    reply = "503";
    const { deps, alert } = setup();
    const out = await runHelpdeskHealth(deps);
    expect(out.status).toBe("down");
    expect(alert.mock.calls).toEqual([["helpdesk_down"]]);
  });

  it("health() throwing is down, the run resolves, and only the class name is logged", async () => {
    const connector = {
      health: () => Promise.reject(new TypeError("MARKER-SECRET-TEXT")),
    } as unknown as HelpdeskConnector;
    const { deps, alert, error } = setup({ createConnector: () => connector });
    await expect(runHelpdeskHealth(deps)).resolves.toMatchObject({ status: "down" });
    expect(alert.mock.calls).toEqual([["helpdesk_down"]]);
    expect(JSON.stringify(error.mock.calls)).toContain("TypeError");
    expect(JSON.stringify(error.mock.calls)).not.toContain("MARKER-SECRET-TEXT");
  });

  it("a connector that cannot be built (bad config) is down with an alert", async () => {
    const { deps, alert, error } = setup({
      createConnector: () => {
        throw new RangeError("MARKER-CONFIG-VALUE");
      },
    });
    await expect(runHelpdeskHealth(deps)).resolves.toMatchObject({ status: "down" });
    expect(alert.mock.calls).toEqual([["helpdesk_down"]]);
    expect(JSON.stringify(error.mock.calls)).not.toContain("MARKER-CONFIG-VALUE");
  });

  it("an unknown status from the connector counts as down", async () => {
    const connector = {
      health: async () => ({ status: "degraded" }),
    } as unknown as HelpdeskConnector;
    const { deps, alert } = setup({ createConnector: () => connector });
    await expect(runHelpdeskHealth(deps)).resolves.toMatchObject({ status: "down" });
    expect(alert.mock.calls).toEqual([["helpdesk_down"]]);
  });

  it("calls health() once", async () => {
    const fake = new FakeConnector();
    const { deps } = setup({ createConnector: () => fake });
    await runHelpdeskHealth(deps);
    expect(fake.calls.filter((c) => c.operation === "health")).toHaveLength(1);
  });

  it("an alert that throws does not fail the run; the class name is logged", async () => {
    reply = "503";
    const alert = vi.fn<AlertFn>(async () => {
      throw new SyntaxError("MARKER-ALERT-TEXT");
    });
    const { deps, error } = setup({ alert });
    await expect(runHelpdeskHealth(deps)).resolves.toMatchObject({ status: "down" });
    expect(JSON.stringify(error.mock.calls)).toContain("SyntaxError");
    expect(JSON.stringify(error.mock.calls)).not.toContain("MARKER-ALERT-TEXT");
  });

  it("with the real alert sink, two asleep runs in one minute post one line and record two", async () => {
    reply = "asleep";
    let seen = 0;
    const recordSecurityEvent = vi.fn(async () => ++seen); // the repository's per-minute count
    const postAlert = vi.fn(async () => {});
    const alert = createAlertSink({ recordSecurityEvent, logger: { error: () => {} }, postAlert });
    await runHelpdeskHealth(setup({ alert }).deps);
    await runHelpdeskHealth(setup({ alert }).deps);
    expect(recordSecurityEvent.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ["pipeline", "alert:helpdesk_asleep"],
      ["pipeline", "alert:helpdesk_asleep"],
    ]);
    expect(postAlert.mock.calls).toEqual([["alert helpdesk_asleep"]]);
  });

  it("raises each kind once per run and none for ok", async () => {
    const kinds: AlertKind[] = [];
    const alert: AlertFn = async (kind) => void kinds.push(kind);
    for (const r of ["ok", "asleep", "503"] as const) {
      reply = r;
      await runHelpdeskHealth(setup({ alert }).deps);
    }
    expect(kinds).toEqual(["helpdesk_asleep", "helpdesk_down"]);
  });
});

describe("helpdeskHealthOptions", () => {
  it("is the scheduled helpdesk-health task, every 30 minutes", () => {
    expect(helpdeskHealthOptions.id).toBe(HELPDESK_HEALTH_TASK_ID);
    expect(helpdeskHealthOptions.cron).toBe("*/30 * * * *");
  });

  it("does not retry: the run never fails", () => {
    expect(helpdeskHealthOptions).not.toHaveProperty("retry");
  });
});

describe("createHelpdeskHealthDeps and runHelpdeskHealthTask", () => {
  const env = {
    // Port 1 never listens: a database call from the alert sink fails at once, nothing is written.
    SUPABASE_URL: "http://127.0.0.1:1",
    SUPABASE_SERVICE_ROLE_KEY: "k".repeat(16),
    SUPABASE_DB_SCHEMA: "itsupport",
    SERVICENOW_INSTANCE_URL: ORIGIN,
    SERVICENOW_USERNAME: "svc.itsupport",
    SERVICENOW_PASSWORD: PASSWORD,
    SERVICENOW_DEFAULT_CALLER: "d".repeat(32),
  };

  it("builds deps without a request; the connector is built when asked", () => {
    const deps = createHelpdeskHealthDeps(env);
    expect(recorder.requests()).toHaveLength(0);
    expect(deps.createConnector().kind).toBe("servicenow");
    expect(deps.now()).toBeGreaterThan(Date.parse("2026-11-01"));
  });

  it("missing ServiceNow settings fail when the connector is built, not before", () => {
    const deps = createHelpdeskHealthDeps({ ...env, SERVICENOW_PASSWORD: undefined });
    expect(() => deps.createConnector()).toThrow(/SERVICENOW_PASSWORD/);
  });

  it("throws without the database settings, naming the variable and never the password", () => {
    const attempt = () => createHelpdeskHealthDeps({ ...env, SUPABASE_URL: undefined });
    expect(attempt).toThrow(/SUPABASE_URL/);
    try {
      attempt();
    } catch (error) {
      expect(String(error)).not.toContain(PASSWORD);
    }
  });

  it("the task body resolves down when the database settings are missing", async () => {
    const log = vi.fn();
    const out = await runHelpdeskHealthTask({}, { error: log }, () => NOW);
    expect(out).toEqual({
      connector: "servicenow",
      status: "down",
      checkedAt: "2026-11-10T10:00:00.000Z",
    });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SUPABASE");
  });

  it("the task body checks the instance and resolves ok", async () => {
    const out = await runHelpdeskHealthTask(env, { error: () => {} }, () => NOW);
    expect(out.status).toBe("ok");
    expect(recorder.requests()).toHaveLength(1);
  });

  it("missing ServiceNow settings give down, and the run resolves", async () => {
    const out = await runHelpdeskHealthTask(
      { ...env, SERVICENOW_INSTANCE_URL: undefined },
      { error: () => {} },
      () => NOW,
    );
    expect(out.status).toBe("down");
    expect(recorder.requests().filter((r) => r.host.endsWith("service-now.com"))).toHaveLength(0);
  });
});
