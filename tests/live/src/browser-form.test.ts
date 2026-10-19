import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrowserFormScenario,
  FORM_TRIAGE_LIMIT_MS,
  type FormBrowser,
  type FormSubmitOptions,
} from "./browser-form.ts";
import { pacerStateFile } from "./pacer.ts";
import { TURNSTILE_TEST_TOKEN } from "./pipeline.ts";
import { headersForRequest } from "./playwright-form.ts";
import { runLive, type LiveReport, type ReportEntry } from "./runner.ts";
import { scenarios } from "./scenarios.ts";
import { markerEnv } from "./testing/env.ts";
import { startMockE2e, type MockE2eOptions } from "./testing/mock-e2e.ts";

// The scenario logic, with a browser stand-in that posts the form body the
// page would post. The real browser (Chromium) runs in e2e/browser-form.spec.ts.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

/** Submits like the form page: the Access headers on the E2E origin, a Turnstile token. */
function fakeBrowser(options: { showId?: boolean } = {}) {
  const calls: FormSubmitOptions[] = [];
  const browser: FormBrowser = {
    async submit(submit) {
      calls.push(submit);
      await submit.beforeSubmit();
      const v = submit.values;
      const response = await fetch(new URL("/api/tickets", submit.origin), {
        method: "POST",
        headers: { ...submit.accessHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: v.Name,
          email: v.Email,
          department: v.Department,
          title: v.Title,
          description: v.Description,
          turnstileToken: TURNSTILE_TEST_TOKEN,
        }),
      });
      const { ticketId } = (await response.json()) as { ticketId: string };
      return { ticketId: options.showId === false ? null : ticketId };
    },
  };
  return { browser, calls };
}

async function setup(
  pipeline?: MockE2eOptions["pipeline"],
  scenarioOptions: { triageLimitMs?: number; showId?: boolean } = {},
) {
  const dir = join(mkdtempSync(join(tmpdir(), "live-form-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  let time = Date.parse("2026-10-19T10:00:00.000Z");
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    now: clock.now,
    pipeline,
  });
  cleanup.push(() => mock.close());
  const fake = fakeBrowser({ showId: scenarioOptions.showId });
  const scenario = createBrowserFormScenario({
    browser: fake.browser,
    triageLimitMs: scenarioOptions.triageLimitMs,
  });
  const run = async (): Promise<{ code: number; entry: ReportEntry }> => {
    const code = await runLive({
      argv: ["--only", "T3.L.01"],
      env: { ...values, E2E_BASE_URL: mock.origin, STAGING_BASE_URL: undefined },
      scenarios: [scenario],
      evidenceDir: dir,
      stdout: () => undefined,
      stderr: () => undefined,
      now: clock.now,
      sleep: clock.sleep,
      runId: "run-form",
    });
    const report = JSON.parse(
      readFileSync(join(dir, "live", "run-form.json"), "utf8"),
    ) as LiveReport;
    return { code, entry: report.scenarios[0]! };
  };
  const formPosts = () =>
    mock.requests.filter((r) => r.method === "POST" && r.path === "/api/tickets");
  const pacerSubmits = () =>
    (JSON.parse(readFileSync(pacerStateFile(dir), "utf8")) as { submits: number[] }).submits;
  return { values, mock, fake, run, formPosts, pacerSubmits };
}

describe("headersForRequest", () => {
  const headers = { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "x".repeat(8) };
  const origin = "http://127.0.0.1:4100";

  it("adds the Access headers on the E2E origin, any path", () => {
    expect(headersForRequest(`${origin}/`, origin, headers)).toBe(headers);
    expect(headersForRequest(`${origin}/api/tickets?x=1`, origin, headers)).toBe(headers);
  });

  it.each([
    "http://127.0.0.1:4101/turnstile.js",
    "https://127.0.0.1:4100/",
    "http://localhost:4100/",
    "https://challenges.cloudflare.com/turnstile/v0/api.js",
    "data:text/plain,x",
    "not a url",
  ])("adds nothing for %s", (url) => {
    expect(headersForRequest(url, origin, headers)).toEqual({});
  });
});

describe("T3.L.01 (browser stand-in)", () => {
  it("is registered, with the 30 s limit", () => {
    expect(scenarios.map((s) => s.id)).toContain("T3.L.01");
    expect(FORM_TRIAGE_LIMIT_MS).toBe(30_000);
  });

  it("passes when the ticket is triaged in 5 s with a category and fix steps; one paced submit", async () => {
    const h = await setup();
    const { code, entry } = await h.run();
    expect(code).toBe(0);
    const [post] = h.formPosts();
    expect(h.formPosts()).toHaveLength(1);
    expect(post!.accessOk).toBe(true);
    expect(h.pacerSubmits()).toHaveLength(1);
    expect(h.fake.calls[0]!.origin).toBe(h.mock.origin);
    expect(h.fake.calls[0]!.accessHeaders).toEqual({
      "CF-Access-Client-Id": h.values.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": h.values.CF_ACCESS_CLIENT_SECRET,
    });
    expect(entry).toMatchObject({
      status: "pass",
      evidence: {
        status: "triaged",
        msToTriaged: 5_000,
        limitMs: 30_000,
        category: "software",
        fixSteps: 2,
        failedChecks: [],
      },
    });
    expect(entry.evidence["ticketId"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fails when the ticket never reaches triaged", async () => {
    const h = await setup((_, d) => ({ ...d, triagedAfterMs: null }));
    const { code, entry } = await h.run();
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      msToTriaged: null,
      failedChecks: expect.arrayContaining(["triaged-within-limit"]),
    });
  });

  it("fails when triage takes longer than the (shortened) limit", async () => {
    const h = await setup(undefined, { triageLimitMs: 2_000 });
    const { code, entry } = await h.run();
    expect(code).toBe(1);
    expect(entry.evidence["failedChecks"]).toContain("triaged-within-limit");
  });

  it("fails when triage lands after 30 s", async () => {
    const h = await setup((_, d) => ({ ...d, triagedAfterMs: 30_500 }));
    const { code, entry } = await h.run();
    expect(code).toBe(1);
    expect(entry.evidence["failedChecks"]).toContain("triaged-within-limit");
  });

  it("fails when there are no fix steps", async () => {
    const h = await setup((_, d) => ({ ...d, fixSteps: 0 }));
    const { code, entry } = await h.run();
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({ fixSteps: 0, failedChecks: ["fix-steps"] });
  });

  it("fails when the page shows no ticket ID", async () => {
    const h = await setup(undefined, { showId: false });
    const { code, entry } = await h.run();
    expect(code).toBe(1);
    expect(entry.evidence).toMatchObject({
      ticketId: null,
      formSubmitted: true,
      failedChecks: ["ticket-id"],
    });
  });
});
