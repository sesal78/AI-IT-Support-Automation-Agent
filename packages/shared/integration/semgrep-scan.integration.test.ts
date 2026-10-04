import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtures = "packages/shared/integration/fixtures";

// The command a developer or CI types, run from the repo root.
function scan(target: string) {
  const run = spawnSync(`pnpm scan:semgrep -- ${target}`, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("pnpm scan:semgrep (pinned Semgrep image; needs Docker and network)", () => {
  it("exits 1 and names the rule ID for the seeded finding", () => {
    const run = scan(`${fixtures}/semgrep-bad`);
    expect(run.output).toContain(
      "javascript.lang.security.audit.code-string-concat.code-string-concat",
    );
    expect(run.status).toBe(1);
  });

  it("exits 0 for the clean twin, after scanning its one file", () => {
    const run = scan(`${fixtures}/semgrep-clean`);
    expect(run.output).toMatch(/on 1 file: 0 findings/);
    expect(run.status).toBe(0);
  });
});
