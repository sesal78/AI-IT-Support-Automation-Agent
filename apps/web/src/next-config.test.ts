import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config", () => {
  it("builds a standalone server for the Docker image", () => {
    expect(nextConfig.output).toBe("standalone");
  });

  it("traces files from the monorepo root so workspace packages are included", () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    expect(nextConfig.outputFileTracingRoot).toBeTypeOf("string");
    expect(path.resolve(nextConfig.outputFileTracingRoot as string)).toBe(path.resolve(repoRoot));
  });
});
