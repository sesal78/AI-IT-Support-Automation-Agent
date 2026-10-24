import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageJson = Partial<
  Record<"scripts" | "dependencies" | "devDependencies", Record<string, string>>
>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path: string) =>
  JSON.parse(readFileSync(resolve(repoRoot, path), "utf8")) as PackageJson;

// no failure-path test: the script is a constant in package.json; it takes no input.
describe("root script deploy:pipeline", () => {
  const script = read("package.json").scripts?.["deploy:pipeline"] ?? "";

  // A fresh clone has no packages/*/dist, which the tasks import (PROJECT §11, 2026-09-30).
  it("exists and builds the workspace packages before trigger deploy", () => {
    expect(script, "deploy:pipeline script").not.toBe("");
    const build = script.indexOf('pnpm --filter "./packages/*" run build');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(script.indexOf("trigger deploy")).toBeGreaterThan(build);
  });

  it("has the trigger CLI in services/pipeline at the SDK's version", () => {
    const { dependencies, devDependencies } = read("services/pipeline/package.json");
    expect(devDependencies?.["trigger.dev"]).toBeTypeOf("string");
    expect(devDependencies?.["trigger.dev"]).toBe(dependencies?.["@trigger.dev/sdk"]);
  });
});
