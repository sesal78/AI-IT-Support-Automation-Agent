import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLive, type LiveReport, type ReportEntry, type RunLiveOptions } from "./runner.ts";
import { scenarios } from "./scenarios.ts";
import {
  ACCESS_BYPASS_PATH,
  ACCESS_GUARDED_PATHS,
  isAccessDenied,
  FLOOD_CONCURRENCY,
  FLOOD_REQUESTS,
  securityScenarios,
  wrongTokenFor,
} from "./security.ts";
import { markerEnv } from "./testing/env.ts";
import {
  startMockE2e,
  type MockE2e,
  type MockE2eOptions,
  type MockReply,
} from "./testing/mock-e2e.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

const CLOUDFLARE_403: MockReply = {
  status: 403,
  text: "<!DOCTYPE html><html><body>Forbidden</body></html>",
  contentType: "text/html",
};
const html404: MockReply = { status: 404, text: "<html>404</html>", contentType: "text/html" };

type MockExtras = Omit<MockE2eOptions, "token" | "accessClientId" | "accessClientSecret">;

interface SetupOptions {
  readonly mock?: MockExtras;
  /** Override of the staging mock, or `unset` for no STAGING_BASE_URL. */
  readonly staging?: MockE2eOptions["override"] | "unset";
  readonly now?: () => number;
}

async function setup(options: SetupOptions = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "live-security-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    ...options.mock,
  });
  cleanup.push(() => mock.close());
  // The staging mock knows the real credentials, so a leaked one would pass its gate.
  const staging = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    override: options.staging === "unset" ? undefined : options.staging,
  });
  cleanup.push(() => staging.close());
  const stagingOrigin = new URL(values.STAGING_BASE_URL).origin;
  const env: Record<string, string | undefined> = {
    ...values,
    E2E_BASE_URL: mock.origin,
    STAGING_BASE_URL: options.staging === "unset" ? undefined : values.STAGING_BASE_URL,
  };
  // The staging host is not resolvable; route it to the staging mock.
  const routed: NonNullable<RunLiveOptions["fetch"]> = (input, init) =>
    input.origin === stagingOrigin
      ? fetch(new URL(`${input.pathname}${input.search}`, staging.origin), init)
      : fetch(input, init);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = async (argv: string[]) => {
    const code = await runLive({
      argv,
      env,
      scenarios,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetch: routed,
      now: options.now,
    });
    const live = join(dir, "live");
    const files = readdirSync(live).filter((name) => name !== "form-pacer.json");
    const texts = files.map((name) => readFileSync(join(live, name), "utf8"));
    const report = JSON.parse(texts.at(-1)!) as LiveReport;
    return { code, report, texts };
  };
  const one = async (id: string): Promise<{ code: number; entry: ReportEntry }> => {
    const { code, report } = await run(["--only", id]);
    return { code, entry: report.scenarios[0]! };
  };
  return { values, mock, staging, run, one, stdout, stderr };
}

/** Requests the scenario made to the given internal path. */
const to = (mock: MockE2e, prefix: string) =>
  mock.requests.filter((r) => r.path.startsWith(prefix));

describe("security scenario registry", () => {
  it("registers the five security IDs", () => {
    expect(securityScenarios.map((s) => s.id)).toEqual([
      "T3.S.02",
      "T3.S.02-staging",
      "T3.S.03",
      "T3.S.05",
      "T3.S.07",
    ]);
    expect(scenarios.map((s) => s.id)).toEqual(expect.arrayContaining(["T3.S.02", "T3.S.07"]));
  });

  it("derives a wrong token that is clearly not the real one", () => {
    for (const real of ["a".repeat(32), "b".repeat(64), `LiveWrongToken${"x".repeat(18)}`]) {
      const wrong = wrongTokenFor(real);
      expect(wrong).not.toBe(real);
      expect(wrong.includes(real)).toBe(false);
      expect(wrong).toMatch(/^LiveWrongToken[xy]+$/);
    }
  });
});

describe("T3.S.02", () => {
  it("passes against the default mock with no token and a wrong token", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.S.02");
    expect(code).toBe(0);
    expect(entry).toMatchObject({
      status: "pass",
      evidence: { noTokenStatus: 401, wrongTokenStatus: 401 },
    });
    const [noToken, wrong] = to(h.mock, "/api/internal/tickets/");
    expect(noToken).toMatchObject({ hasAuthorization: false, accessOk: true });
    expect(wrong).toMatchObject({ hasBearer: true, bearerOk: false, accessOk: true });
  });

  it("fails naming the check when a request with no token gets 200", async () => {
    const h = await setup({
      mock: {
        override: (r) =>
          r.path.startsWith("/api/internal/tickets/") && !r.hasAuthorization
            ? { status: 200, json: {} }
            : undefined,
      },
    });
    const { code, entry } = await h.one("T3.S.02");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { failedCheck: "no-token-401", status: 200 },
    });
  });

  it("fails naming the check when the security events are missing afterwards", async () => {
    const h = await setup({ mock: { securityEvents: "none" } });
    const { code, entry } = await h.one("T3.S.02");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: {
        failedCheck: "security-events",
        missingKinds: ["missing_token", "bad_token"],
        rows: 0,
      },
    });
  });
});

describe("T3.S.02-staging", () => {
  const stagingAnswers =
    (answer: MockReply): MockE2eOptions["override"] =>
    (r) =>
      r.method === "POST" && r.path === "/api/internal/test-tickets" ? answer : undefined;

  it("passes when staging answers 404, and staging receives no credential", async () => {
    const h = await setup({ staging: stagingAnswers(html404) });
    const { code, entry } = await h.one("T3.S.02-staging");
    expect(code).toBe(0);
    expect(entry).toMatchObject({ status: "pass", evidence: { status: 404 } });
    expect(h.staging.requests).toHaveLength(1);
    expect(h.staging.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/internal/test-tickets",
      hasAuthorization: false,
      hasAccessHeaders: false,
    });
    expect(h.mock.requests).toEqual([]);
  });

  it("fails when staging answers 201", async () => {
    const h = await setup({
      staging: stagingAnswers({ status: 201, json: { ticketId: "x", queued: true } }),
    });
    const { code, entry } = await h.one("T3.S.02-staging");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { status: 201, failedCheck: "staging-test-tickets-404" },
    });
  });

  it("is reported as not run (exit code 2) when STAGING_BASE_URL is unset", async () => {
    const h = await setup({ staging: "unset" });
    const { code, entry } = await h.one("T3.S.02-staging");
    expect(code).toBe(2);
    expect(entry).toMatchObject({ status: "not_run" });
    expect(h.staging.requests).toEqual([]);
    expect(h.mock.requests).toEqual([]);
  });
});

describe("T3.S.03", () => {
  it("passes against the default mock", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.S.03");
    expect(code).toBe(0);
    expect(entry).toMatchObject({ status: "pass", evidence: { status: 200, features: 6 } });
  });

  it("fails when the mock adds a string field under features", async () => {
    const h = await setup({
      mock: {
        override: (r) =>
          r.path === "/api/health/config" && r.accessOk
            ? {
                status: 200,
                json: {
                  version: "0.0.0-mock",
                  features: {
                    database: true,
                    migration0003: true,
                    pipelineTrigger: true,
                    turnstile: true,
                    internalApi: true,
                    e2eMode: true,
                    region: "eu",
                  },
                },
              }
            : undefined,
      },
    });
    const { code, entry } = await h.one("T3.S.03");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { failedCheck: "healthConfigSchema", status: 200 },
    });
  });
});

describe("T3.S.05", () => {
  it("passes against the default mock and never sends the Access headers or a token", async () => {
    const h = await setup();
    const { code, entry } = await h.one("T3.S.05");
    expect(code).toBe(0);
    expect(entry).toMatchObject({
      status: "pass",
      evidence: {
        paths: [...ACCESS_GUARDED_PATHS],
        statuses: ACCESS_GUARDED_PATHS.map(() => 403),
        inboundStatus: 404,
        failedPaths: [],
      },
    });
    expect(h.mock.requests.map((r) => r.path)).toEqual([
      ...ACCESS_GUARDED_PATHS,
      ACCESS_BYPASS_PATH,
    ]);
    for (const request of h.mock.requests) {
      expect(request).toMatchObject({ hasAccessHeaders: false, hasAuthorization: false });
    }
  });

  it("fails naming the path when one path answers 200 without the Access headers", async () => {
    const h = await setup({
      mock: {
        override: (r) =>
          r.path === "/api/health" && !r.accessOk
            ? { status: 200, json: { status: "ok", version: "x" } }
            : undefined,
      },
    });
    const { code, entry } = await h.one("T3.S.05");
    expect(code).toBe(1);
    expect(entry).toMatchObject({ status: "fail", evidence: { failedPaths: ["/api/health"] } });
  });

  it("fails naming the path when a guarded path answers the app's JSON 403", async () => {
    const h = await setup({
      mock: {
        override: (r) =>
          r.path === "/api/tickets" ? { status: 403, json: { error: "forbidden" } } : undefined,
      },
    });
    const { entry } = await h.one("T3.S.05");
    expect(entry).toMatchObject({ status: "fail", evidence: { failedPaths: ["/api/tickets"] } });
  });

  it("fails naming the path when /api/inbound/email answers with the Cloudflare 403", async () => {
    const h = await setup({
      mock: { override: (r) => (r.path === ACCESS_BYPASS_PATH ? CLOUDFLARE_403 : undefined) },
    });
    const { code, entry } = await h.one("T3.S.05");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { inboundStatus: 403, failedPaths: [ACCESS_BYPASS_PATH] },
    });
  });

  it("passes when Access answers with the 302 login redirect, and records no Location", async () => {
    const h = await setup({ mock: { accessDenial: "redirect" } });
    const { code, entry } = await h.one("T3.S.05");
    expect(code).toBe(0);
    expect(entry).toMatchObject({
      status: "pass",
      evidence: {
        statuses: ACCESS_GUARDED_PATHS.map(() => 302),
        inboundStatus: 404,
        failedPaths: [],
      },
    });
    expect(JSON.stringify(entry)).not.toContain("cloudflareaccess");
  });

  it("fails naming the path when a guarded path redirects somewhere that is not Access", async () => {
    const h = await setup({
      mock: {
        override: (r) =>
          r.path === "/api/tickets"
            ? { status: 302, headers: { Location: "https://cloudflareaccess.com.evil.example/x" } }
            : undefined,
      },
    });
    const { entry } = await h.one("T3.S.05");
    expect(entry).toMatchObject({ status: "fail", evidence: { failedPaths: ["/api/tickets"] } });
  });

  it("fails when the inbound path answers with the Access login redirect", async () => {
    const h = await setup({
      mock: {
        accessDenial: "redirect",
        override: (r) =>
          r.path === ACCESS_BYPASS_PATH
            ? {
                status: 302,
                headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/h" },
              }
            : undefined,
      },
    });
    const { entry } = await h.one("T3.S.05");
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { inboundStatus: 302, failedPaths: [ACCESS_BYPASS_PATH] },
    });
  });
});

describe("isAccessDenied", () => {
  const ok = "https://team.cloudflareaccess.com/cdn-cgi/access/login/e2e.example.test?kid=1";
  const res = (status: number, location: string | null, text = "", contentType = "") => ({
    status,
    contentType,
    text,
    location,
  });

  it("accepts the 403 non-JSON page and the 302/303 login redirect", () => {
    expect(isAccessDenied(res(403, null, "<html>no</html>", "text/html"))).toBe(true);
    expect(isAccessDenied(res(302, ok))).toBe(true);
    expect(isAccessDenied(res(303, ok))).toBe(true);
    expect(isAccessDenied(res(302, "https://a.b.cloudflareaccess.com/cdn-cgi/access/login"))).toBe(
      true,
    );
  });

  it.each([
    ["the e2e app itself", "https://e2e.example.test/cdn-cgi/access/login/x"],
    ["a lookalike suffix host", "https://cloudflareaccess.com.evil.example/cdn-cgi/access/login/x"],
    [
      "a host that merely ends in the name",
      "https://evilcloudflareaccess.com/cdn-cgi/access/login/x",
    ],
    ["the bare apex host", "https://cloudflareaccess.com/cdn-cgi/access/login/x"],
    ["http", "http://team.cloudflareaccess.com/cdn-cgi/access/login/x"],
    ["another path", "https://team.cloudflareaccess.com/other"],
    [
      "a path that only starts with the prefix",
      "https://team.cloudflareaccess.com/cdn-cgi/access/loginx",
    ],
    ["a garbled Location", "not a url"],
    ["no Location", null],
  ])("rejects a 302 to %s", (_name, location) => {
    expect(isAccessDenied(res(302, location))).toBe(false);
  });

  it("rejects other statuses and the app's own JSON", () => {
    expect(isAccessDenied(res(200, ok))).toBe(false);
    expect(isAccessDenied(res(301, ok))).toBe(false);
    expect(isAccessDenied(res(307, ok))).toBe(false);
    expect(isAccessDenied(res(401, null, '{"error":"unauthorized"}', "application/json"))).toBe(
      false,
    );
    expect(isAccessDenied(res(403, null, '{"error":"forbidden"}', "application/json"))).toBe(false);
  });
});

describe("T3.S.07", () => {
  const flood = (mock: MockE2e) =>
    mock.requests.filter((r) => r.path.startsWith("/api/internal/tickets/"));

  it("passes when the mock aggregates per minute, at most 20 requests at a time", async () => {
    const h = await setup({ mock: { delayMs: 2 } });
    const { code, entry } = await h.one("T3.S.07");
    expect(code).toBe(0);
    expect(entry.status).toBe("pass");
    expect(entry.evidence).toMatchObject({
      requests: FLOOD_REQUESTS,
      status401: FLOOD_REQUESTS,
      otherStatuses: [],
      transportErrors: 0,
      healthStatus: 200,
      failedChecks: [],
    });
    expect(entry.evidence.rows).toBeLessThanOrEqual(entry.evidence.minutesTouched as number);
    expect(entry.evidence.countSum).toBeGreaterThanOrEqual(FLOOD_REQUESTS);
    expect(flood(h.mock)).toHaveLength(FLOOD_REQUESTS);
    expect(flood(h.mock).every((r) => r.hasBearer && !r.bearerOk && r.accessOk)).toBe(true);
    // The scenario's own limit, seen from the server; the delay makes it reach it.
    expect(h.mock.peakInFlight).toBeLessThanOrEqual(FLOOD_CONCURRENCY);
    expect(h.mock.peakInFlight).toBeGreaterThan(1);
    expect(entry.evidence.maxConcurrent).toBeLessThanOrEqual(FLOOD_CONCURRENCY);
  });

  it("passes with one row per minute when the flood crosses a minute boundary", async () => {
    // One clock for the harness and the mock, 1 ms per reading, starting just before a minute.
    let t = Date.UTC(2026, 9, 18, 12, 0, 0) - 300;
    const now = () => (t += 1);
    const h = await setup({ mock: { now }, now });
    const { entry } = await h.one("T3.S.07");
    expect(entry).toMatchObject({
      status: "pass",
      evidence: { minutesTouched: 2, rows: 2, countSum: FLOOD_REQUESTS },
    });
  });

  it("fails when the mock returns 1 000 rows", async () => {
    const h = await setup({ mock: { securityEvents: "per-request" } });
    const { code, entry } = await h.one("T3.S.07");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { rows: FLOOD_REQUESTS, failedChecks: ["rows-per-minute"] },
    });
  });

  it("fails when a flood request gets 500", async () => {
    let seen = 0;
    const h = await setup({
      mock: {
        override: (r) =>
          r.path.startsWith("/api/internal/tickets/") && ++seen === 500
            ? { status: 500, json: { error: "internal" } }
            : undefined,
      },
    });
    const { code, entry } = await h.one("T3.S.07");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { status401: FLOOD_REQUESTS - 1, otherStatuses: [500] },
    });
    expect(entry.evidence.failedChecks).toContain("all-401");
  });

  it("fails when /api/health is not 200 afterwards", async () => {
    const h = await setup({
      mock: {
        override: (r) =>
          r.path === "/api/health" ? { status: 503, json: { status: "down" } } : undefined,
      },
    });
    const { code, entry } = await h.one("T3.S.07");
    expect(code).toBe(1);
    expect(entry).toMatchObject({
      status: "fail",
      evidence: { healthStatus: 503, failedChecks: ["health-200"] },
    });
  });
});

describe("security evidence", () => {
  it("holds status codes, counts, check names and paths only, and never an env value", async () => {
    const h = await setup({ staging: (r) => (r.method === "POST" ? html404 : undefined) });
    const { code, report, texts } = await h.run([
      "--only",
      securityScenarios.map((s) => s.id).join(","),
    ]);
    expect(code).toBe(0);
    for (const entry of report.scenarios) {
      expect(entry.status, entry.id).toBe("pass");
      for (const value of Object.values(entry.evidence).flat()) {
        if (typeof value === "string") expect(value).toMatch(/^[a-z0-9/_-]+$/i);
        else expect(typeof value === "number" || typeof value === "boolean").toBe(true);
      }
    }
    const output = [...h.stdout, ...h.stderr, ...texts].join("\n");
    const secrets = Object.entries(h.values)
      .filter(([key]) => key !== "E2E_BASE_URL")
      .map(([, value]) => value);
    for (const secret of [...secrets, wrongTokenFor(h.values.INTERNAL_API_TOKEN)]) {
      expect(output.includes(secret), "a value leaked").toBe(false);
    }
  });
});
