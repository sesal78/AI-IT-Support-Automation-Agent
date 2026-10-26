import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import rootConfig from "../../../vitest.config.js";
import {
  coverageThresholds,
  missingGuardModules,
  parseGuardModules,
} from "../src/guard-modules.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const guardModules = parseGuardModules(
  JSON.parse(readFileSync(resolve(repoRoot, "guard-modules.json"), "utf8")),
);
const coverage = rootConfig.test?.coverage;

describe("guard-modules.json", () => {
  // Floors are only ever raised (docs/PROJECT.md §9), so an entry never leaves the list.
  it("keeps every listed guard module", () => {
    expect(guardModules.map((module) => module.path)).toEqual(
      expect.arrayContaining([
        "packages/shared/src/redact.ts",
        "apps/web/src/lib/intake/request.ts",
        "apps/web/src/lib/internal/auth.ts",
        "packages/shared/src/policy.ts",
        "packages/shared/src/status.ts",
      ]),
    );
  });

  // P3-T15e: the ticket status guard, coverage floor only until its mutation gate is on.
  it("lists the ticket status guard with a 90 % statements floor", () => {
    const status = guardModules.find(({ path }) => path === "packages/shared/src/status.ts");
    expect(status).toEqual({
      path: "packages/shared/src/status.ts",
      statements: 90,
      mutation: null,
    });
  });

  // T3.S.06: `pnpm test:mutation` proves this floor.
  it("switches on the 80 % mutation floor for the intake request module", () => {
    const request = guardModules.find(({ path }) => path === "apps/web/src/lib/intake/request.ts");
    expect(request?.mutation).toBe(80);
  });

  // T3.S.06 with P3-T3b: the gate proves the redaction floor too.
  it("switches on the 80 % mutation floor for redaction", () => {
    const redact = guardModules.find(({ path }) => path === "packages/shared/src/redact.ts");
    expect(redact?.mutation).toBe(80);
    // Its mutants run redact.test.ts only, so the CI mutation job fits its 30 minutes.
    expect(redact?.related).toBe(false);
  });

  // P4-T3a / T4.S.05: the Slack signature verifier is an authentication guard.
  it("lists the Slack signature module with 90 % statements and an 80 % mutation floor", () => {
    const slack = guardModules.find(
      ({ path }) => path === "packages/shared/src/slack-signature.ts",
    );
    expect(slack).toEqual({
      path: "packages/shared/src/slack-signature.ts",
      statements: 90,
      mutation: 80,
      related: false,
    });
  });

  // P4-T3b (plan T4.S.05): the Slack interaction rules carry both floors.
  it("lists the Slack interaction rules with both floors", () => {
    const interaction = guardModules.find(
      ({ path }) => path === "apps/web/src/lib/slack/interaction.ts",
    );
    expect(interaction).toEqual({
      path: "apps/web/src/lib/slack/interaction.ts",
      statements: 90,
      mutation: 80,
    });
  });

  it("lists only files that exist in the repo", () => {
    expect(missingGuardModules(guardModules, repoRoot)).toEqual([]);
  });

  it("would report a made-up path, or a folder, with the same check", () => {
    const madeUp = ["packages/shared/src/no-such-module.ts", "packages/shared/src"];
    const list = madeUp.map((path) => ({ path, statements: 90, mutation: null }));
    expect(missingGuardModules([...guardModules, ...list], repoRoot)).toEqual(madeUp);
  });

  it("would report a made-up test file listed for a module", () => {
    const tests = ["packages/shared/src/no-such.test.ts"];
    const list = [{ path: "packages/shared/src/redact.ts", statements: 90, mutation: null, tests }];
    expect(missingGuardModules(list, repoRoot)).toEqual(tests);
  });

  // `vitest related` runs these too, so a change to them can weaken the score.
  it("lists the tickets route test for the intake request module", () => {
    const request = guardModules.find(({ path }) => path === "apps/web/src/lib/intake/request.ts");
    expect(request?.tests).toEqual(["apps/web/src/app/api/tickets/route.test.ts"]);
  });

  // Vitest skips a per-file floor whose file is not in the coverage report.
  it("lists only files that the coverage run measures", () => {
    for (const { path } of guardModules) {
      const measured = coverage?.include?.some((glob) => posix.matchesGlob(path, glob));
      expect(measured, path).toBe(true);
    }
  });

  // An excluded file is not in the coverage report either, so its floor would be skipped.
  it("lists no file that the coverage run excludes", () => {
    const excluded = guardModules
      .map(({ path }) => path)
      .filter((path) => coverage?.exclude?.some((glob) => posix.matchesGlob(path, glob)));
    expect(excluded).toEqual([]);
  });
});

describe("root vitest.config.ts coverage thresholds", () => {
  it("keep the global 80 % floor and add one per-file floor for each guard module", () => {
    expect(coverage?.thresholds).toEqual({
      lines: 80,
      functions: 80,
      branches: 80,
      statements: 80,
      ...coverageThresholds(guardModules),
    });
  });
});
