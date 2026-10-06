import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { guardFilesTouched } from "../src/mutation-gate.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = resolve(repoRoot, "packages/shared/scripts/mutation-gate.mjs");

function runGate(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("packages/shared/scripts/mutation-gate.mjs", () => {
  it("prints the skip line and exits 0 without starting Stryker when no guard module changed", () => {
    const run = runGate([
      "--",
      "--changed",
      "README.md",
      "--changed",
      "packages/shared/src/redact.ts",
    ]);
    expect(run.stdout.trim()).toBe("mutation: skipped (no guard module changed)");
    expect(run.stderr).not.toContain("Stryker");
    expect(run.status).toBe(0);
  });

  // `--changed --all` must not read `--all` as a file name and so skip.
  it.each([["--bogus"], ["--changed"], ["--changed", "--all"], ["--changed", "--changed", "a"]])(
    "exits 2 on the bad arguments %j",
    (...args) => {
      const run = runGate(args);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("test:mutation: ");
    },
  );

  it("exits 2 and names the range when git diff fails, never reading it as no change", () => {
    const run = runGate([], { GITHUB_BASE_REF: "no-such-base-branch" });
    expect(run.stderr).toContain("test:mutation: git diff origin/no-such-base-branch...HEAD");
    expect(run.stdout).not.toContain("skipped");
    expect(run.status).toBe(2);
  });

  // A preload swaps in the list text, so the real guard-modules.json is never
  // touched. `--changed README.md`: if the stub stopped applying, it skips, never runs Stryker.
  it.each([
    ["an invalid list", '[{ "path": "a/b.ts", "statements": 90, "mutation": 80, "tests": "x" }]'],
    ["text that is not JSON", "[{"],
  ])("exits 2 and names guard-modules.json for %s", (_case, text) => {
    const preload = `import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const read = fs.readFileSync;
      fs.readFileSync = (file, ...rest) =>
        file === "guard-modules.json" ? ${JSON.stringify(text)} : read(file, ...rest);
      syncBuiltinESMExports();`;
    const stub = `data:text/javascript,${encodeURIComponent(preload)}`;
    const run = spawnSync(
      process.execPath,
      ["--import", stub, scriptPath, "--changed", "README.md"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(run.stderr).toContain("test:mutation: guard-modules.json: ");
    expect(run.stdout).not.toContain("mutation:");
    expect(run.status).toBe(2);
  });

  // `vitest related` loads every project config, so a change to any of them re-runs the gate.
  it("treats every Vitest project config as a gate file", () => {
    const configs = ["apps", "services", "packages"].flatMap((group) =>
      readdirSync(resolve(repoRoot, group), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          readdirSync(resolve(repoRoot, group, entry.name))
            .filter((name) => name.startsWith("vitest.config."))
            .map((name) => `${group}/${entry.name}/${name}`),
        ),
    );
    expect(configs).toContain("packages/shared/vitest.config.ts");
    for (const config of configs) expect(guardFilesTouched([config], []), config).toBe(true);
  });

  // @stryker-mutator/vitest-runner 10.0.0 marks every test "skipped" on Vitest 5, so its score is false.
  it("uses Stryker's built-in command runner, pinned exactly, and never the Vitest runner", () => {
    const script = readFileSync(scriptPath, "utf8");
    const pkg = readFileSync(resolve(repoRoot, "package.json"), "utf8");
    expect(script).toContain('testRunner: "command"');
    expect(`${script}${pkg}`).not.toContain("vitest-runner");
    expect(JSON.parse(pkg).devDependencies["@stryker-mutator/core"]).toBe("10.0.0");
  });

  // In place, a killed run must not leave `// @ts-nocheck` in any file. A preload
  // swaps in a Stryker stub that prints the options it is run with, so the value
  // Stryker gets is checked, not the source text.
  it("runs Stryker with disableTypeChecks set to false", () => {
    const hook = resolve(repoRoot, "packages/shared/test/fixtures/stryker-stub.mjs");
    const run = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(hook).href, scriptPath, "--changed", "package.json"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ disableTypeChecks: false });
  });
});
