import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { createBrowserFormScenario } from "../src/browser-form.ts";
import { pacerStateFile } from "../src/pacer.ts";
import { createPlaywrightFormBrowser } from "../src/playwright-form.ts";
import { runLive, type LiveReport, type ReportEntry } from "../src/runner.ts";
import { markerEnv } from "../src/testing/env.ts";
import { startMockE2e, type MockE2eOptions } from "../src/testing/mock-e2e.ts";
import { serveFormPage, startAssetOrigin } from "../src/testing/mock-form.ts";

// T3.L.01 with real headless Chromium against the local mock: the mock e2e app
// serves a form with the real page's labels and button behind its Access gate,
// and the page loads a script from a second local origin, which must never
// see an Access header. No network beyond 127.0.0.1.

const cleanup: Array<() => Promise<void> | void> = [];
test.afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

async function runAgainstMock(pipeline: MockE2eOptions["pipeline"], triageLimitMs?: number) {
  const dir = join(mkdtempSync(join(tmpdir(), "live-browser-")), ".loop-evidence");
  cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
  const assets = await startAssetOrigin();
  cleanup.push(() => assets.close());
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    override: serveFormPage(assets.origin),
    pipeline,
  });
  cleanup.push(() => mock.close());
  const output: string[] = [];
  const code = await runLive({
    argv: ["--only", "T3.L.01"],
    env: { ...values, E2E_BASE_URL: mock.origin, STAGING_BASE_URL: undefined },
    scenarios: [
      createBrowserFormScenario({
        browser: createPlaywrightFormBrowser({ allowLocalNetwork: true }),
        triageLimitMs,
      }),
    ],
    evidenceDir: dir,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    runId: "run-browser",
  });
  const live = join(dir, "live");
  const report = JSON.parse(readFileSync(join(live, "run-browser.json"), "utf8")) as LiveReport;
  const texts = readdirSync(live).map((name) => readFileSync(join(live, name), "utf8"));
  const text = [...output, ...texts].join("\n");
  for (const [key, value] of Object.entries(values)) {
    if (key !== "E2E_BASE_URL") expect(text.includes(value), `${key} leaked`).toBe(false);
  }
  const entry: ReportEntry = report.scenarios[0]!;
  const submits = (JSON.parse(readFileSync(pacerStateFile(dir), "utf8")) as { submits: number[] })
    .submits;
  return { code, entry, mock, assets, submits };
}

// Fast pipeline: redacted after 200 ms, triaged after 1 s.
const fast: MockE2eOptions["pipeline"] = (_, d) => ({
  ...d,
  redactedAfterMs: 200,
  triagedAfterMs: 1_000,
});

test("T3.L.01 passes against the mock form, with one paced submit", async () => {
  const { code, entry, mock, submits } = await runAgainstMock(fast);
  expect(entry).toMatchObject({
    status: "pass",
    evidence: { status: "triaged", category: "software", fixSteps: 2, failedChecks: [] },
  });
  expect(code).toBe(0);
  expect(entry.evidence["ticketId"]).toMatch(/^[0-9a-f-]{36}$/);
  // The page and the form post both passed the Access gate.
  const page = mock.requests.filter((r) => r.method === "GET" && r.path === "/");
  const posts = mock.requests.filter((r) => r.method === "POST" && r.path === "/api/tickets");
  expect(page.length).toBeGreaterThanOrEqual(1);
  expect(page.every((r) => r.accessOk)).toBe(true);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.accessOk).toBe(true);
  expect(JSON.parse(posts[0]!.body)).toMatchObject({ title: "Laptop will not boot" });
  expect(submits).toHaveLength(1);
});

test("T3.L.01 sends no Access header to the second origin the page loads from", async () => {
  const { code, assets } = await runAgainstMock(fast);
  expect(code).toBe(0);
  expect(assets.requests.map((r) => r.path)).toContain("/turnstile.js");
  for (const request of assets.requests) {
    expect(request.hasAccessClientId, request.path).toBe(false);
    expect(request.hasAccessClientSecret, request.path).toBe(false);
  }
});

test("T3.L.01 fails when the ticket is not triaged within the shortened limit", async () => {
  const { code, entry, submits } = await runAgainstMock(
    (_, d) => ({ ...d, triagedAfterMs: null }),
    1_500,
  );
  expect(code).toBe(1);
  expect(entry.evidence["failedChecks"]).toContain("triaged-within-limit");
  expect(submits).toHaveLength(1);
});

test("T3.L.01 fails when the ticket has no fix steps", async () => {
  const { code, entry } = await runAgainstMock((_, d) => ({ ...fast!(_, d), fixSteps: 0 }));
  expect(code).toBe(1);
  expect(entry.evidence).toMatchObject({ fixSteps: 0, failedChecks: ["fix-steps"] });
});
