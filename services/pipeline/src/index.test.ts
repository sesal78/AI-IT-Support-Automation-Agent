import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@ai-it-support/pipeline", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@ai-it-support/pipeline");
  });
});
