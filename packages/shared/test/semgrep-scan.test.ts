import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = resolve(repoRoot, "packages/shared/scripts/semgrep-scan.mjs");
const script = readFileSync(scriptPath, "utf8");

// Nothing listens on this port, so the Docker client cannot reach a daemon.
const noDaemon = { ...process.env, DOCKER_HOST: "tcp://127.0.0.1:1" };

function runWrapper(args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: noDaemon,
  });
}

describe("packages/shared/scripts/semgrep-scan.mjs", () => {
  it("fails the scan on ERROR findings from the four rule packs", () => {
    expect(script).toMatch(/"--error"/);
    expect(script).toMatch(/"--severity",\s*"ERROR"/);
    for (const pack of ["p/typescript", "p/nextjs", "p/secrets", "p/owasp-top-ten"]) {
      expect(script).toContain(`"${pack}"`);
    }
  });

  it("pins every image reference to an exact version tag and digest, never `latest`", () => {
    const refs = script.match(/semgrep\/semgrep[^\s"'`]*/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^semgrep\/semgrep:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    }
  });

  it("exits non-zero and says Docker is needed when no daemon is reachable", () => {
    const run = runWrapper([]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Docker is needed");
  });

  it.each(["..", "packages/shared/no-such-folder", "package.json"])(
    "refuses the target %s, which is not an existing folder inside the repo",
    (target) => {
      const run = runWrapper([target]);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain(`target "${target}"`);
    },
  );

  it("refuses more than one target", () => {
    const run = runWrapper(["packages", "apps"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("at most one folder");
  });
});
