// Mutation gate (root script `pnpm test:mutation`, plan §9, T3.S.06). When a
// guard module with a mutation floor, its own or a listed test file, or a gate
// file changed (GATE_FILES in ../src/mutation-gate.ts: guard-modules.json, the
// gate, the Vitest configs, the root package.json and lockfile), it runs Stryker
// on every module with a floor and fails (exit 1) when one is below it.
// Otherwise it prints a skip line and exits 0.
// `-- --all` forces a run; `-- --changed <file>` (repeatable) replaces the git
// diff. Exit 2 means the gate could not run. Node runs the imported .ts files
// by type stripping.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGuardModules } from "../src/guard-modules.ts";
import * as gate from "../src/mutation-gate.ts";

// Stryker runs from the repo root, so its report keys are the guard paths.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));

function fail(message) {
  console.error(`test:mutation: ${message}`);
  process.exit(2);
}

let all = false;
let fakeChanged;
const args = process.argv.slice(2).filter((arg) => arg !== "--");
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--all") all = true;
  else if (args[i] === "--changed" && args[i + 1] && !args[i + 1].startsWith("--"))
    (fakeChanged ??= []).push(args[(i += 1)]);
  else fail(`unknown or incomplete argument "${args[i]}"`);
}

// A pull request is diffed against its base branch, anything else against the
// previous commit. A failed diff stops the gate; it never counts as "no change".
// Lines are split on \r?\n, so a stray \r cannot hide a guard path.
function changedFiles() {
  const base = process.env.GITHUB_BASE_REF;
  const range = base ? `origin/${base}...HEAD` : "HEAD~1";
  try {
    return execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8", stdio: "pipe" })
      .split(/\r?\n/)
      .filter((line) => line !== "");
  } catch (error) {
    return fail(`git diff ${range} failed: ${error.message}`);
  }
}

let list;
try {
  list = parseGuardModules(JSON.parse(readFileSync("guard-modules.json", "utf8")));
} catch (error) {
  fail(`guard-modules.json: ${error.message}`);
}
if (!all && !gate.guardFilesTouched(fakeChanged ?? changedFiles(), list)) {
  console.log("mutation: skipped (no guard module changed)");
  process.exit(0);
}

// The Stryker options (no config file). The command runner runs Vitest per mutant
// on the tests that import the module, coverage off (per-file floors would fail a
// partial run). In place: Stryker restores the module from .stryker-tmp/ at the
// end. Type-check disabling is off, so Stryker never writes `// @ts-nocheck` into
// source files that a killed run would leave behind (Vitest strips types unchecked).
// Guard paths need no quoting (REPO_PATH); default thresholds are integers.
const { Stryker } = await import("@stryker-mutator/core");
let failed = false;
for (const module of list.filter(({ mutation }) => mutation !== null)) {
  const fileName = `reports/mutation/${module.path.replaceAll("/", "__")}.json`;
  rmSync(fileName, { force: true });
  const started = Date.now();
  try {
    await new Stryker({
      testRunner: "command",
      commandRunner: {
        command: `pnpm exec vitest related --run --coverage.enabled=false ${module.path}`,
      },
      mutate: [module.path],
      inPlace: true,
      disableTypeChecks: false,
      plugins: [],
      reporters: ["clear-text", "json"],
      jsonReporter: { fileName },
      concurrency: 4,
    }).runMutationTest();
    const report = gate.parseMutationReport(readFileSync(fileName, "utf8"));
    const checks = gate.checkMutationReport(report, [module]);
    const seconds = Math.round((Date.now() - started) / 1000);
    for (const { message } of checks) console.log(`mutation: ${message}, in ${seconds} s`);
    failed ||= checks.length === 0 || checks.some(({ passed }) => !passed);
  } catch (error) {
    fail(`${module.path}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
