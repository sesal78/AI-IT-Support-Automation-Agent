// Mutation gate (root script `pnpm test:mutation`, plan §9, T3.S.06). When a
// guard module with a mutation floor, its own test file, guard-modules.json or
// this gate changed, it runs Stryker on every module with a floor and fails
// (exit 1) when one is below it. Otherwise it prints a skip line and exits 0.
// `-- --all` forces a run; `-- --changed <file>` (repeatable) replaces the git
// diff. Exit 2 means the gate could not run. Node runs the imported .ts files
// by type stripping.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGuardModules } from "../src/guard-modules.ts";
import {
  checkMutationReport,
  guardFilesTouched,
  parseMutationReport,
} from "../src/mutation-gate.ts";

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
  else if (args[i] === "--changed" && args[i + 1]) (fakeChanged ??= []).push(args[(i += 1)]);
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

const list = parseGuardModules(JSON.parse(readFileSync("guard-modules.json", "utf8")));
if (!all && !guardFilesTouched(fakeChanged ?? changedFiles(), list)) {
  console.log("mutation: skipped (no guard module changed)");
  process.exit(0);
}

// The Stryker options (no separate config file). The command runner runs Vitest
// once per mutant on the tests that import the module (`vitest related`), so no
// Vitest plugin is involved; coverage is off because the per-file floors would
// fail a partial run. In place: Stryker edits the module in the working tree
// and restores it from .stryker-tmp/ at the end. Guard-module paths are plain
// (REPO_PATH), so the command needs no quoting. The default thresholds are
// whole numbers, as checkMutationReport requires.
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
      plugins: [],
      reporters: ["clear-text", "json"],
      jsonReporter: { fileName },
      concurrency: 4,
    }).runMutationTest();
    const checks = checkMutationReport(parseMutationReport(readFileSync(fileName, "utf8")), [
      module,
    ]);
    const seconds = Math.round((Date.now() - started) / 1000);
    for (const { message } of checks) console.log(`mutation: ${message}, in ${seconds} s`);
    failed ||= checks.length === 0 || checks.some(({ passed }) => !passed);
  } catch (error) {
    fail(`${module.path}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
