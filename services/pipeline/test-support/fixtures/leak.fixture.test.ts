// Run only by egress-recorder.integration.test.ts, through selftest.vitest.config.ts.
// The first test leaks on purpose; the setup file's check must fail it, and only it.
import { describe, expect, it } from "vitest";
import { buildCanaries } from "../../../../packages/shared/src/canaries.js";
import { egress } from "../egress.js";

describe("egress self-test", () => {
  it("leaks an email canary", async () => {
    egress.mock("https://api.typesafe.ai");
    const email = buildCanaries(egress.runId).find((entry) => entry.type === "email")?.value ?? "";
    await fetch("https://api.typesafe.ai/v1/systemone", { method: "POST", body: email });
    expect(egress.requests()).toHaveLength(1);
  });

  it("sends only a placeholder", async () => {
    await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      body: "Reply to [REDACTED_EMAIL]",
    });
    expect(egress.requests()).toHaveLength(1);
  });
});
