import type { MeterRepos } from "@ai-it-support/ai";
import type { Repositories } from "@ai-it-support/db";
import { describe, expectTypeOf, it } from "vitest";

// packages/ai must not import packages/db, so this is the one place that
// proves the db repositories can be passed to createMeter as `repos`.
describe("MeterRepos", () => {
  it("is satisfied by the packages/db repository object", () => {
    expectTypeOf<Repositories>().toExtend<MeterRepos>();
  });
});
