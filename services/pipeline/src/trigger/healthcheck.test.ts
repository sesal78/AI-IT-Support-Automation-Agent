import { describe, expect, it } from "vitest";
import { healthcheck, healthcheckPayload, runHealthcheck } from "./healthcheck.js";

describe("healthcheck task", () => {
  it("is registered with id healthcheck", () => {
    expect(healthcheck.id).toBe("healthcheck");
  });

  it("returns ok, requestedBy and an ISO timestamp", async () => {
    const result = await runHealthcheck({ requestedBy: "ci" });
    expect(result.ok).toBe(true);
    expect(result.requestedBy).toBe("ci");
    expect(new Date(result.at).toISOString()).toBe(result.at);
  });

  it("rejects a payload without requestedBy, naming the field", () => {
    expect(() => healthcheckPayload.parse({})).toThrow(/requestedBy/);
  });

  it("rejects an empty requestedBy", () => {
    expect(healthcheckPayload.safeParse({ requestedBy: "" }).success).toBe(false);
  });
});
