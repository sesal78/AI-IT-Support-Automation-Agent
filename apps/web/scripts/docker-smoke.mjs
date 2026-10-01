// Scripted Docker checks for apps/web/Dockerfile (run from the repo root via
// `pnpm test:e2e:docker`). Everything it creates is named `itsupport-web-e2e*`,
// published only on 127.0.0.1, and removed at the end, pass or fail.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const image = "itsupport-web-e2e:local";
const names = {
  health: "itsupport-web-e2e-health",
  noenv: "itsupport-web-e2e-noenv",
  whoami: "itsupport-web-e2e-whoami",
};
const hostPort = 3002;
const healthDeadlineMs = 20_000;

// Obvious fakes created here; never real values.
const fakeEnv = {
  SUPABASE_URL: "https://fake-e2e.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "fake-e2e-service-role-key",
  TRIGGER_SECRET_KEY: "fake-e2e-trigger-secret",
  ADMIN_HEALTH_TOKEN: "fake-e2e-admin-health-token",
  APP_VERSION: "0.0.0-e2e",
  TURNSTILE_SECRET_KEY: "fake-e2e-turnstile-secret-key",
  TURNSTILE_SITE_KEY: "fake-e2e-turnstile-site-key",
};

function docker(args, { inherit = false } = {}) {
  const res = spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
  });
  if (res.error) throw res.error;
  return { code: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function envArgs(env) {
  return Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
}

function cleanup() {
  for (const name of Object.values(names)) docker(["rm", "-f", name]);
}

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < healthDeadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${hostPort}/api/health`);
      if (res.status === 200) return Date.now() - started;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main() {
  cleanup();

  const build = docker(["build", "-f", "apps/web/Dockerfile", "-t", image, "."], { inherit: true });
  check("docker build -f apps/web/Dockerfile . exits 0", build.code === 0, `exit ${build.code}`);
  if (build.code !== 0) return;

  const who = docker(["run", "--rm", "--name", names.whoami, image, "whoami"]);
  check(
    "container user is not root",
    who.code === 0 && who.out !== "" && who.out !== "root",
    `whoami=${who.out}`,
  );

  const run = docker([
    "run",
    "-d",
    "--name",
    names.health,
    "-p",
    `127.0.0.1:${hostPort}:3000`,
    ...envArgs(fakeEnv),
    image,
  ]);
  if (run.code !== 0) {
    check("container starts", false, run.out);
  } else {
    const ms = await waitForHealth();
    check(
      "GET /api/health returns 200 within 20 s",
      ms !== null,
      ms === null ? "timeout" : `${ms} ms`,
    );
    if (ms === null) console.log(docker(["logs", names.health]).out);
  }

  const { SUPABASE_URL: _omitted, ...withoutUrl } = fakeEnv;
  const noenv = docker(["run", "-d", "--name", names.noenv, ...envArgs(withoutUrl), image]);
  if (noenv.code !== 0) {
    check("container without SUPABASE_URL starts", false, noenv.out);
  } else {
    const started = Date.now();
    let state = "running";
    while (state === "running" && Date.now() - started < healthDeadlineMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = docker(["inspect", "-f", "{{.State.Status}}", names.noenv]).out;
    }
    const exitCode = Number(docker(["inspect", "-f", "{{.State.ExitCode}}", names.noenv]).out);
    const logs = docker(["logs", names.noenv]).out;
    check(
      "without SUPABASE_URL the container exits non-zero",
      state === "exited" && exitCode !== 0,
      `state=${state} exit=${exitCode}`,
    );
    check("its log names SUPABASE_URL", logs.includes("SUPABASE_URL"));
  }
}

let crashed = false;
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
try {
  await main();
} catch (error) {
  crashed = true;
  console.error(error);
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} Docker checks passed`);
process.exit(crashed || failed > 0 || results.length === 0 ? 1 : 0);
