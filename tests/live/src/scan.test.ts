import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanaries } from "@ai-it-support/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runScan } from "./scan.ts";
import { markerEnv } from "./testing/env.ts";

const RUN = "run42abc";
const canary = Object.fromEntries(buildCanaries(RUN).map((c) => [c.type, c.value]));
const values = markerEnv("http://127.0.0.1:1");
const env = {
  LANGFUSE_PUBLIC_KEY: values.LANGFUSE_PUBLIC_KEY,
  LANGFUSE_SECRET_KEY: values.LANGFUSE_SECRET_KEY,
  LANGFUSE_BASE_URL: "https://langfuse.example",
};
const markers = [values.LANGFUSE_PUBLIC_KEY, values.LANGFUSE_SECRET_KEY];
const SINCE = "2026-10-19T00:00:00.000Z";

type Row = { id: string; input?: unknown; output?: unknown; metadata?: unknown };

/** A mock Langfuse API: pages of observations chained by cursor; records requests. */
function mockLangfuse(
  pages: Row[][],
  respond?: (url: URL, init: RequestInit) => Response | undefined,
) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = async (url: URL, init: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const custom = respond?.(url, init);
    if (custom) return custom;
    const index = Number(url.searchParams.get("cursor")?.replace("c", "") ?? "0");
    const meta = index + 1 < pages.length ? { cursor: `c${index + 1}` } : {};
    return Response.json({ data: pages[index] ?? [], meta });
  };
  return { fetch, requests };
}

async function run(argv: string[], options: Parameters<typeof runScan>[3] = {}, scanEnv = env) {
  const lines: string[] = [];
  const out = { stdout: (l: string) => lines.push(l), stderr: (l: string) => lines.push(l) };
  const code = await runScan(argv, scanEnv, out, options);
  const text = lines.join("\n");
  for (const marker of markers) expect(text).not.toContain(marker);
  return { code, text };
}

const clean = (id: string): Row => ({
  id,
  input: "VPN down, contact [REDACTED_EMAIL]",
  output: { steps: ["Restart the client"] },
  metadata: { environment: "e2e" },
});
const traces = (...extra: string[]) => ["traces", "--run", RUN, "--since", SINCE, ...extra];

describe("scan:traces", () => {
  it("exits 0 on two pages of clean observations and counts both pages", async () => {
    const api = mockLangfuse([[clean("o1"), clean("o2")], [clean("o3")]]);
    const { code, text } = await run(traces(), { fetch: api.fetch });
    expect(code).toBe(0);
    expect(text).toContain("3 observations scanned on 2 pages; 0 hard hits");
    expect(api.requests).toHaveLength(2);
    const first = api.requests[0]!;
    expect(first.url.origin + first.url.pathname).toBe(
      "https://langfuse.example/api/public/v2/observations",
    );
    expect(first.url.searchParams.get("fromStartTime")).toBe(SINCE);
    expect(first.url.searchParams.get("fields")).toBe("core,io,metadata");
    expect(api.requests[1]!.url.searchParams.get("cursor")).toBe("c1");
    expect(first.init.redirect).toBe("manual");
    const auth = new Headers(first.init.headers).get("Authorization")!;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      `${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`,
    );
  });

  it("exits 1 on a run canary on the second page and never prints its value", async () => {
    const api = mockLangfuse([
      [clean("o1")],
      [clean("o2"), { id: "obs-leak", output: `SSN ${canary.ssn}` }],
    ]);
    const { code, text } = await run(traces(), { fetch: api.fetch });
    expect(code).toBe(1);
    expect(text).toContain("HARD observation obs-leak canary:ssn");
    expect(text).not.toContain(canary.ssn);
  });

  it("exits 1 with the type email on a raw email address", async () => {
    const api = mockLangfuse([[{ id: "o9", metadata: { to: "someone@example.com" } }]]);
    const { code, text } = await run(traces(), { fetch: api.fetch });
    expect(code).toBe(1);
    expect(text).toContain("HARD observation o9 email");
    expect(text).not.toContain("someone@example.com");
  });

  it("warns with unredacted:IPV4 on an IPv4 address and still exits 0", async () => {
    const api = mockLangfuse([[{ id: "o5", output: "Ping 198.51.100.7 first" }]]);
    const { code, text } = await run(traces(), { fetch: api.fetch });
    expect(code).toBe(0);
    expect(text).toContain("WARN observation o5 unredacted:IPV4");
    expect(text).not.toContain("198.51.100.7");
  });

  it("exits 2 when the time window holds no observations", async () => {
    const { code, text } = await run(traces(), { fetch: mockLangfuse([[]]).fetch });
    expect(code).toBe(2);
    expect(text).toContain("nothing to scan is not a pass");
  });

  it("exits 2 on a 401 with the status and no key, even when the body echoes the keys", async () => {
    const api = mockLangfuse([], (_url, init) =>
      Response.json(
        { error: `bad ${new Headers(init.headers).get("Authorization")} ${markers.join(" ")}` },
        { status: 401 },
      ),
    );
    const { code, text } = await run(traces(), { fetch: api.fetch });
    expect(code).toBe(2);
    expect(text).toContain("unexpected status 401");
    expect(text).not.toContain("Basic ");
  });

  it.each([
    [
      "a redirect",
      () => new Response(null, { status: 302, headers: { Location: "https://x.example/" } }),
    ],
    ["a non-JSON page", () => new Response("<html>", { status: 200 })],
    ["a page without meta", () => Response.json({ data: [{ id: "o1" }] })],
    ["an ID with odd characters", () => Response.json({ data: [{ id: "o 1\n" }], meta: {} })],
  ])("exits 2 on %s (fail closed)", async (_name, make) => {
    const { code } = await run(traces(), { fetch: mockLangfuse([], () => make()).fetch });
    expect(code).toBe(2);
  });

  it("exits 2 when a later page fails after clean pages", async () => {
    const api = mockLangfuse([[clean("o1")], [clean("o2")]], (url) =>
      url.searchParams.has("cursor") ? new Response("", { status: 500 }) : undefined,
    );
    const { code, text } = await run(traces(), { fetch: api.fetch });
    expect(code).toBe(2);
    expect(text).toContain("not proven clean");
  });

  it("exits 2 when the cursor repeats", async () => {
    const api = mockLangfuse([], () =>
      Response.json({ data: [clean("o1")], meta: { cursor: "same" } }),
    );
    const { code, text } = await run(traces(), { fetch: api.fetch });
    expect(code).toBe(2);
    expect(text).toContain("cursor repeated");
  });

  it("exits 2 when the transport throws, printing only the error class", async () => {
    const fetch = async () => {
      throw new Error(`connect failed ${markers.join(" ")}`);
    };
    const { code, text } = await run(traces(), { fetch });
    expect(code).toBe(2);
    expect(text).toContain("request failed (Error)");
  });

  it("exits 2 naming the variable when a Langfuse key is missing", async () => {
    const { code, text } = await run(traces(), {}, {
      ...env,
      LANGFUSE_SECRET_KEY: undefined,
    } as never);
    expect(code).toBe(2);
    expect(text).toContain("LANGFUSE_SECRET_KEY");
  });
});

describe("scan:logs", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function file(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "scan-logs-"));
    dirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it("exits 1 naming the file, line 3 and the type of a canary", async () => {
    const path = file("trigger.log", `start\nok\nkey ${canary.api_key} used\nend\n`);
    const { code, text } = await run(["logs", "--run", RUN, path]);
    expect(code).toBe(1);
    expect(text).toContain(`HARD ${path}:3 canary:api_key`);
    expect(text).not.toContain(canary.api_key);
  });

  it("exits 0 on a clean file", async () => {
    const path = file("dokploy.log", "GET /api/health 200\r\ntriage done\r\n");
    const { code, text } = await run(["logs", "--run", RUN, path]);
    expect(code).toBe(0);
    expect(text).toContain("2 lines scanned; 0 hard hits");
  });

  it("exits 2 on a missing file", async () => {
    const missing = join(tmpdir(), "scan-logs-missing-file.log");
    const { code, text } = await run(["logs", "--run", RUN, missing]);
    expect(code).toBe(2);
    expect(text).toContain("cannot read (ENOENT)");
  });

  it("exits 2 on an empty file", async () => {
    const { code } = await run(["logs", "--run", RUN, file("empty.log", "")]);
    expect(code).toBe(2);
  });
});

describe("usage", () => {
  it.each([
    ["an invalid --run", ["traces", "--run", "Bad-Run!", "--since", SINCE]],
    ["a missing --run", ["logs", "x.log"]],
    ["a missing --since", ["traces", "--run", RUN]],
    ["an invalid --since", ["traces", "--run", RUN, "--since", "yesterday"]],
    ["no files for logs", ["logs", "--run", RUN]],
    ["an unknown command", ["sentry"]],
  ])("fails with a usage message on %s", async (_name, argv) => {
    const { code, text } = await run(argv, { fetch: mockLangfuse([[clean("o1")]]).fetch });
    expect(code).toBe(2);
    expect(text).toContain("usage: scan:");
    expect(text).not.toContain("Bad-Run!");
  });
});
