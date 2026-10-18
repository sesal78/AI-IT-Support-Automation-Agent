// The local stack of the pipeline end-to-end test (P3-T10h). TEST CODE ONLY.
//
// Started from the spec's worker process (Playwright transpiles the imported
// test-support sources):
// 1. the local REST stack (Docker: Postgres with migrations 0001-0003 + PostgREST),
// 2. the local Trigger.dev runner (P3-T10g), which runs the real intake and
//    triage bodies in this process with canned TypeSafe, LLM and Langfuse answers,
// 3. the built web app (`next start`, run `pnpm build` first) with E2E_MODE=true,
//    pointed at both, with the egress preload loaded through NODE_OPTIONS.
// Every value below is a test fake built at run time; nothing real is used.
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../../packages/db/integration/rest-stack.js";
import {
  startLocalRunner,
  type LocalRunner,
} from "../../../../services/pipeline/test-support/local-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "../..");
const preload = resolve(here, "../../../../services/pipeline/test-support/web-egress-preload.ts");

export interface PipelineStack {
  baseURL: string;
  /** The bearer token of the internal API (a fake). */
  internalToken: string;
  runner: LocalRunner;
  /** Registers a string the web process must never send out. */
  forbid(value: string): void;
  /** Problems the web process's egress recorder saw (empty when clean). */
  webEgressProblems(): Promise<string[]>;
  /** Stops the web app, the runner and the REST stack. Safe after a partial start. */
  stop(): Promise<void>;
}

type EgressReply = { type: "egress"; problems: string[] };

async function waitForHealth(baseURL: string, web: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) throw new Error(`web server exited with code ${web.exitCode}`);
    try {
      const res = await fetch(new URL("/api/health", baseURL));
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`web server not healthy after ${timeoutMs} ms`);
}

function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    child.once("exit", () => done());
    child.kill();
  });
}

export async function startPipelineStack(baseURL: string): Promise<PipelineStack> {
  let stack: RestStack | undefined;
  let runner: LocalRunner | undefined;
  let web: ChildProcess | undefined;
  const output: string[] = [];

  const stop = async () => {
    await stopProcess(web);
    await runner?.stop();
    await removeRestStack(stack);
  };

  try {
    stack = await startRestStack();
    runner = await startLocalRunner({ restStack: stack });

    const internalToken = "e".repeat(32);
    const nextBin = createRequire(resolve(webDir, "package.json")).resolve("next/dist/bin/next");
    const port = new URL(baseURL).port;
    web = spawn(process.execPath, [nextBin, "start", "--port", port, "--hostname", "127.0.0.1"], {
      cwd: webDir,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        NEXT_TELEMETRY_DISABLED: "1",
        SUPABASE_URL: stack.url,
        SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
        SUPABASE_DB_SCHEMA: "itsupport",
        TRIGGER_SECRET_KEY: "x".repeat(32),
        TRIGGER_API_URL: runner.url,
        SHADOW_MODE: "true",
        ADMIN_HEALTH_TOKEN: "h".repeat(24),
        APP_VERSION: "0.0.0-e2e-pipeline",
        INTERNAL_API_TOKEN: internalToken,
        TURNSTILE_SECRET_KEY: "s".repeat(35),
        // Cloudflare's published always-pass test site key; the browser widget is stubbed.
        TURNSTILE_SITE_KEY: `1x${"0".repeat(20)}AA`,
        E2E_MODE: "true",
      },
    });
    // Kept for the error message only; the app never logs request data.
    const keep = (chunk: Buffer) => {
      output.push(chunk.toString("utf8"));
      if (output.length > 200) output.shift();
    };
    web.stdout?.on("data", keep);
    web.stderr?.on("data", keep);
    await waitForHealth(baseURL, web, 60_000);

    const child = web;
    return {
      baseURL,
      internalToken,
      runner,
      forbid: (value) => child.send({ type: "forbid", value }),
      webEgressProblems: () =>
        new Promise<string[]>((done, fail) => {
          const timer = setTimeout(
            () => fail(new Error("no egress reply from the web process")),
            5000,
          );
          const onMessage = (message: unknown) => {
            const reply = message as Partial<EgressReply>;
            if (reply?.type !== "egress" || !Array.isArray(reply.problems)) return;
            clearTimeout(timer);
            child.off("message", onMessage);
            done(reply.problems);
          };
          child.on("message", onMessage);
          child.send({ type: "check" });
        }),
      stop,
    };
  } catch (error) {
    await stop();
    throw new Error(`${String(error)}\n--- web server output ---\n${output.join("")}`);
  }
}
