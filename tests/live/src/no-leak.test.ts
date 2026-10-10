import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLive, type Scenario } from "./runner.ts";
import { markerEnv } from "./testing/env.ts";
import { startMockE2e } from "./testing/mock-e2e.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
  vi.restoreAllMocks();
});

describe("marker run", () => {
  it("leaves no env value in stdout, stderr or the report, failing scenarios included", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "live-leak-")), ".loop-evidence");
    cleanup.push(() => rmSync(dirname(dir), { recursive: true, force: true }));
    const values = markerEnv("http://127.0.0.1:1");
    const second = await startMockE2e({ token: "t", accessClientId: "i", accessClientSecret: "s" });
    cleanup.push(() => second.close());
    const mock = await startMockE2e({
      token: values.INTERNAL_API_TOKEN,
      accessClientId: values.CF_ACCESS_CLIENT_ID,
      accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
      override: (request) => {
        if (request.path === "/echo") {
          // A body that echoes every credential back.
          return { status: 500, json: { got: Object.values(values).join(" ") } };
        }
        if (request.path === "/redirect") {
          return { status: 302, headers: { Location: `${second.origin}/steal` } };
        }
        return undefined;
      },
    });
    cleanup.push(() => mock.close());
    const env = { ...values, E2E_BASE_URL: mock.origin };
    const markers = Object.entries(values)
      .filter(([key]) => key !== "E2E_BASE_URL")
      .map(([, value]) => value);

    // Catch anything that bypasses the injected writers, too.
    const stray: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation((chunk: string | Uint8Array) => {
        stray.push(String(chunk));
        return true;
      });
    }
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        stray.push(args.map(String).join(" "));
      });
    }

    const all = (ctx: Parameters<Scenario["run"]>[0]) => Object.values(ctx.config).join(" ");
    const scenarios: Scenario[] = [
      {
        id: "ok",
        run: async ({ client }) => ({
          status: "pass",
          evidence: { features: Object.keys((await client.healthConfig()).features).length },
        }),
      },
      {
        id: "throws-with-secret",
        run: async (ctx) => {
          throw new Error(all(ctx) + JSON.stringify(ctx.config));
        },
      },
      {
        id: "evidence-with-secret",
        run: async (ctx) => ({ status: "fail", evidence: { leak: ctx.config.accessClientSecret } }),
      },
      {
        id: "echo",
        run: async ({ client }) => {
          await client.usage("2026-10");
          return { status: "pass" };
        },
      },
      {
        id: "echo-raw",
        run: async ({ client }) => {
          await client.healthConfig();
          return {
            status: "pass",
            evidence: { status: (await client.send("GET /echo", "/echo")).status },
          };
        },
      },
      {
        id: "redirect",
        run: async ({ client }) => {
          await client.send("GET /redirect", "/redirect");
          throw new TypeError("redirect seen");
        },
      },
      {
        id: "not-run",
        run: async () => ({ status: "not_run", evidence: { reason: "STAGING_BASE_URL-unset" } }),
      },
    ];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runLive({
      argv: [],
      env,
      scenarios,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      // The usage endpoint answers with the echoing body.
      fetch: (input, init) =>
        input.pathname === "/api/internal/usage"
          ? fetch(new URL("/echo", input), init)
          : fetch(input, init),
    });
    // A transport-level failure with the credentials in its message.
    const broken = await runLive({
      argv: ["--only", "ok"],
      env,
      scenarios,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      fetch: async () => {
        throw new TypeError(`connect failed ${JSON.stringify(env)}`);
      },
    });
    const missing = await runLive({
      argv: [],
      env: { ...env, INTERNAL_API_TOKEN: undefined, CF_ACCESS_CLIENT_SECRET: "bad value" },
      scenarios,
      evidenceDir: dir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(1);
    expect(broken).toBe(1);
    expect(missing).toBe(2);
    expect(second.requests).toEqual([]);

    const live = join(dir, "live");
    const files = readdirSync(live).map((name) => readFileSync(join(live, name), "utf8"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    const output = [...stdout, ...stderr, ...stray, ...files].join("\n");
    for (const marker of markers) {
      expect(output.includes(marker), "a marker leaked").toBe(false);
    }
    // The report still says what happened.
    expect(stdout.some((l) => /^ok pass \d+ms$/.test(l))).toBe(true);
    expect(stdout.some((l) => /^throws-with-secret fail \d+ms Error$/.test(l))).toBe(true);
    expect(stdout.some((l) => /^evidence-with-secret fail \d+ms EvidenceRefused$/.test(l))).toBe(
      true,
    );
    expect(stdout.some((l) => /^echo fail \d+ms LiveContractError$/.test(l))).toBe(true);
    expect(stdout.some((l) => /^ok fail \d+ms LiveTransportError$/.test(l))).toBe(true);
  });
});
